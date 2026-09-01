export class DatabaseQueryCancelledError extends Error {
  readonly code = 'database_query_cancelled';

  constructor(cause?: unknown) {
    super('Database query cancelled', { cause });
    this.name = 'DatabaseQueryCancelledError';
  }
}

const CANCELLATION_REQUEST_TIMEOUT_MS = 2_000;

function cancellationError(signal: AbortSignal): DatabaseQueryCancelledError {
  return new DatabaseQueryCancelledError(signal.reason);
}

export type CancelStartedOperation = () => void | PromiseLike<void>;

export interface ExecuteCancelableInput<T> {
  /** The operation is invoked only after the pre-flight abort check. */
  operation: () => PromiseLike<T>;
  signal?: AbortSignal | undefined;
  /**
   * Optional driver cancellation hook. The hook must target the same checked
   * out connection/query as `operation`; it is called at most once. Drivers
   * that do not expose a safe native cancellation primitive should omit it
   * and rely on the configured server-side statement timeout.
   */
  cancel?: CancelStartedOperation | undefined;
}

export interface ExecuteDatabaseCancelableInput<T> {
  client: Client;
  operation(client: Client): PromiseLike<T>;
  signal?: AbortSignal | undefined;
}

/**
 * Execute a lazy database operation with request cancellation semantics.
 *
 * This helper deliberately does not race a promise that was created by the
 * caller: `operation` is a thunk, so an already-aborted request (including a
 * signal aborted between registration and the next microtask) never starts a
 * query. A driver-specific cancellation hook may terminate an in-flight
 * query, but the caller still receives one normalized cancellation error.
 */
export function executeCancelable<T>(input: ExecuteCancelableInput<T>): Promise<T> {
  const { signal, cancel } = input;
  if (signal?.aborted) return Promise.reject(cancellationError(signal));
  if (!signal) return Promise.resolve().then(input.operation);
  return new Promise<T>((resolve, reject) => {
    let cancelCalled = false;
    const onAbort = (): void => {
      cleanup();
      reject(cancellationError(signal));
      if (cancel && !cancelCalled) {
        cancelCalled = true;
        // Cancellation is best effort. The request already has a stable
        // typed result, and a driver failure must not become an unhandled
        // rejection or replace that result.
        void Promise.resolve().then(cancel).catch(() => undefined);
      }
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        // Abort can happen after the listener is registered but before this
        // microtask runs. Check again so that race cannot start the query.
        if (signal.aborted) {
          onAbort();
          return undefined;
        }
        return input.operation();
      })
      .then(
        (value) => {
          cleanup();
          if (!signal.aborted) resolve(value as T);
        },
        (error: unknown) => {
          cleanup();
          reject(signal.aborted ? cancellationError(signal) : error);
        },
      );
  });
}

async function cancelBackend(databaseUrl: string, processId: number): Promise<void> {
  // A separate physical connection is essential: the application pool may be
  // configured with max=1 while its only connection is running the query to
  // cancel. PostgreSQL permits a role to cancel its own backends.
  const cancellationClient = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CANCELLATION_REQUEST_TIMEOUT_MS,
    query_timeout: CANCELLATION_REQUEST_TIMEOUT_MS,
    statement_timeout: CANCELLATION_REQUEST_TIMEOUT_MS,
  });
  try {
    await cancellationClient.connect();
    await cancellationClient.query('SELECT pg_cancel_backend($1)', [processId]);
  } finally {
    await cancellationClient.end().catch(() => undefined);
  }
}

/**
 * Run a signal-bearing operation on one owned node-postgres connection and
 * send a real PostgreSQL cancellation request on abort. The checked-out
 * connection is not returned to the pool until both the original query and
 * cancellation request have settled, preventing a late cancel from targeting
 * a subsequent borrower. Neon retains the lazy wrapper plus statement timeout
 * because its HTTP/WebSocket pool does not expose an equivalent backend PID.
 */
export async function executeDatabaseCancelable<T>(
  input: ExecuteDatabaseCancelableInput<T>,
): Promise<T> {
  const config = databaseConfigForClient(input.client as object);
  if (
    !input.signal
    || !config?.databaseUrl
    || config.isNeon
  ) {
    return executeCancelable({
      operation: () => input.operation(input.client),
      signal: input.signal,
    });
  }
  if (input.signal.aborted) throw cancellationError(input.signal);

  const pool = getPool(config);
  if (!(pool instanceof pg.Pool)) {
    return executeCancelable({ operation: () => input.operation(input.client), signal: input.signal });
  }

  const rawClient = await pool.connect();
  if (input.signal.aborted) {
    rawClient.release();
    throw cancellationError(input.signal);
  }
  const processId = (rawClient as unknown as { processID?: unknown }).processID;
  if (!Number.isSafeInteger(processId) || (processId as number) <= 0) {
    rawClient.release();
    throw new Error('node-postgres did not expose a valid backend process ID');
  }
  const scopedClient = drizzlePg(rawClient, { schema }) as unknown as Client;
  let cancelRequest: Promise<void> = Promise.resolve();
  let aborted = false;
  let rejectAbort: ((reason: DatabaseQueryCancelledError) => void) | undefined;
  const abortResult = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    cancelRequest = cancelBackend(config.databaseUrl!, processId as number);
    rejectAbort?.(cancellationError(input.signal!));
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  const operation = Promise.resolve().then(() => input.operation(scopedClient));
  try {
    return await Promise.race([operation, abortResult]);
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    // Do not release the PID-bearing connection until a cancellation can no
    // longer arrive and its original query is fully settled.
    await Promise.allSettled([operation, cancelRequest]);
    rawClient.release();
  }
}
import pg from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { databaseConfigForClient, type Client } from './client';
import { getPool } from './pool';
import * as schema from './schema';
