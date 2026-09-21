import type { AnswerCache, LeaseHandle } from '@app/domain';
import {
  AdmissionController,
  resolveAdmissionConfig,
  type AdmissionRejectionReason,
  type ReleaseLeaseResult,
  type ReleaseOutcome,
} from '@app/application/capacity/admission-control';
import { getComposition } from '@/composition';
import { logger } from '@/lib/logger';

/**
 * Request admission for interactive chat turns (WP-9 workstream C).
 *
 * Single request path from `src/app/api/chat` to the application
 * `AdmissionController` (used as-is). This module replaces
 * `src/app/api/chat/slots.ts` (deleted):
 *
 * - The process-local 2/user fast-path map is now the controller's local
 *   admission state (default `maxConcurrentPerUser: 2`).
 * - The flag-gated distributed per-user lease is kept as an async gate that
 *   reuses the exact slots.ts client source (`getComposition().answerCache`
 *   coordination), key scheme, and TTL, and creates no new connections.
 *
 * Why the distributed lease is an external gate instead of a constructor
 * `DistributedTurnLeasePort`: the port interface is synchronous while the
 * slots.ts client source (`CacheLeaseCoordinator.acquire`) is async, and the
 * infrastructure `DistributedTurnLease` constructor requires a synchronous
 * `LeaseStore` that cannot wrap that async client. The controller is
 * therefore built local-only with `failClosedOnDistributedOutage: false`
 * (matching the old degrade-to-local behavior); the Redis lease is acquired
 * first and rolled back whenever local admission refuses while holding it.
 *
 * Queued turns answer 429 immediately (with Retry-After) instead of holding
 * the connection open for a queue wait: serverless cannot cheaply hold a
 * request open, so the client retries and the retry re-enters admission.
 */

export function positiveIntEnv(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function isDistributedAdmissionEnabled(): boolean {
  const raw = (process.env.WP8_DISTRIBUTED_ADMISSION_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** slots.ts-exact distributed slot scheme: same keys, count, and TTL. */
export const CHAT_DISTRIBUTED_SLOTS_PER_USER = 2;
export const CHAT_DISTRIBUTED_SLOT_TTL_SEC = 65;

/** Fallback Retry-After for distributed-held rejections (matches the old `Retry-After: 1`). */
export const CHAT_ADMISSION_RETRY_AFTER_MS = 1_000;

function distributedSlotKey(userId: string, slot: number): string {
  return `rag:turn-slot:${encodeURIComponent(userId)}:${slot}`;
}

type DistributedGate =
  | { readonly kind: 'acquired'; readonly handle: LeaseHandle }
  | { readonly kind: 'held' }
  | { readonly kind: 'bypassed'; readonly reason: string };

function downgrade(reason: string): DistributedGate {
  logger.warn('chat.admission.distributed_unavailable', { reason, turnId: 'admission' });
  return { kind: 'bypassed', reason };
}

async function acquireDistributedGate(userId: string): Promise<DistributedGate> {
  if (!isDistributedAdmissionEnabled()) return { kind: 'bypassed', reason: 'flag_disabled' };
  let coordination: AnswerCache['coordination'];
  try {
    coordination = getComposition().answerCache?.coordination;
  } catch {
    return downgrade('composition_unavailable');
  }
  if (!coordination) return downgrade('no_coordinator');
  if (coordination.scope !== 'distributed') return downgrade('local_scope');
  for (let slot = 0; slot < CHAT_DISTRIBUTED_SLOTS_PER_USER; slot += 1) {
    let acquired: Awaited<ReturnType<typeof coordination.acquire>>;
    try {
      acquired = await coordination.acquire(
        distributedSlotKey(userId, slot),
        CHAT_DISTRIBUTED_SLOT_TTL_SEC,
      );
    } catch {
      return downgrade('coordinator_error');
    }
    if (acquired.kind === 'acquired') return { kind: 'acquired', handle: acquired.handle };
    if (acquired.kind === 'unavailable') return downgrade('coordinator_unavailable');
    // 'held': this slot is taken, try the next one.
  }
  return { kind: 'held' };
}

let requestAdmissionController: AdmissionController | null = null;
let admissionsByRequest = new WeakMap<Request, ChatAdmissionLease>();
const distributedHandles = new Map<string, LeaseHandle>();

/** Process-wide singleton: one controller owns local admission state per instance. */
export function getRequestAdmissionController(): AdmissionController {
  if (requestAdmissionController === null) {
    requestAdmissionController = new AdmissionController({
      config: resolveAdmissionConfig({}),
      // Matches the retired slots.ts degrade-to-local behavior: a distributed
      // outage never fails the request path when the local ceilings allow it.
      // The downgrade is logged in acquireDistributedGate.
      failClosedOnDistributedOutage: false,
    });
  }
  return requestAdmissionController;
}

/** Test-only reset: destroys the singleton and clears ownership tracking. */
export function __resetRequestAdmissionControllerForTests(): void {
  if (requestAdmissionController !== null) {
    requestAdmissionController.destroy();
    requestAdmissionController = null;
  }
  admissionsByRequest = new WeakMap();
  distributedHandles.clear();
}

export interface ChatAdmissionLease {
  readonly leaseId: string;
  readonly ownerToken: string;
  readonly turnId: string;
}

export type AdmissionDenialReason = AdmissionRejectionReason | 'queued';

export type AdmitInteractiveTurnResult =
  | { readonly admitted: true; readonly lease: ChatAdmissionLease }
  | {
      readonly admitted: false;
      readonly status: 429 | 503;
      readonly retryAfterMs: number;
      readonly reason: AdmissionDenialReason;
      readonly message: string;
    };

export async function admitInteractiveTurn(input: {
  readonly req: Request;
  readonly userId: string;
  readonly turnId: string;
}): Promise<AdmitInteractiveTurnResult> {
  const controller = getRequestAdmissionController();
  const gate = await acquireDistributedGate(input.userId);
  if (gate.kind === 'held') {
    // Cross-instance per-user ceiling hit: reject before body parsing/model
    // work without consuming a local permit (matches retired slots.ts).
    return {
      admitted: false,
      status: 429,
      retryAfterMs: CHAT_ADMISSION_RETRY_AFTER_MS,
      reason: 'per_user_limit',
      message: 'Distributed per-user turn limit reached; retry after the indicated delay.',
    };
  }
  const decision = controller.tryAdmit({
    userId: input.userId,
    turnId: input.turnId,
    provider: 'main',
    kind: 'interactive',
    // HTTP retries re-enter admission with a new turn ID. Do not enqueue a
    // request whose connection has already received a rejection: the
    // controller could otherwise promote this ownerless entry after another
    // turn releases its permit.
    queueable: false,
  });
  if (decision.kind === 'admitted') {
    if (gate.kind === 'acquired') distributedHandles.set(decision.leaseId, gate.handle);
    const lease: ChatAdmissionLease = {
      leaseId: decision.leaseId,
      ownerToken: decision.ownerToken,
      turnId: input.turnId,
    };
    admissionsByRequest.set(input.req, lease);
    return { admitted: true, lease };
  }
  if (gate.kind === 'acquired') {
    // Local admission refused while holding a distributed slot: hand it back
    // so a concurrent turn is not stranded until the Redis TTL.
    try {
      await gate.handle.release();
    } catch {
      // Best-effort; TTL expiry recovers the slot.
    }
  }
  if (decision.kind === 'queued') {
    return {
      admitted: false,
      status: 429,
      retryAfterMs: decision.retryAfterMs,
      reason: 'queued',
      message: `Turn queued at position ${decision.position}; the client retries after the indicated delay.`,
    };
  }
  return {
    admitted: false,
    status: httpStatusForAdmissionRejection(decision.reason),
    retryAfterMs: decision.retryAfterMs,
    reason: decision.reason,
    message: decision.message,
  };
}

/**
 * Exactly-once release for completed/cancelled/error stream outcomes. The
 * distributed handle is marked consumed synchronously before its async
 * release is fired best-effort; the controller itself is exactly-once
 * (`released` vs `already_released`).
 */
export function releaseAdmission(lease: ChatAdmissionLease, outcome: ReleaseOutcome): ReleaseLeaseResult {
  const handle = distributedHandles.get(lease.leaseId);
  if (handle !== undefined) {
    distributedHandles.delete(lease.leaseId);
    void handle.release().catch(() => undefined);
  }
  try {
    return getRequestAdmissionController().release({
      leaseId: lease.leaseId,
      ownerToken: lease.ownerToken,
      outcome,
    });
  } catch {
    // Singleton was reset (tests) or the lease was never admitted here.
    return { kind: 'unknown_lease', leaseId: lease.leaseId };
  }
}

/** Request-keyed release for the route catch path; null when untracked. */
export function releaseAdmissionForRequest(req: Request, outcome: ReleaseOutcome): ReleaseLeaseResult | null {
  const lease = admissionsByRequest.get(req);
  if (lease === undefined) return null;
  admissionsByRequest.delete(req);
  return releaseAdmission(lease, outcome);
}

export function httpStatusForAdmissionRejection(reason: AdmissionDenialReason): 429 | 503 {
  switch (reason) {
    case 'per_user_limit':
    case 'queue_full':
    case 'queue_timeout':
    case 'rate_limited':
    case 'queued':
      return 429;
    case 'global_limit':
    case 'provider_limit':
    case 'circuit_open':
    case 'dependency_shedding':
    case 'deadline_exceeded':
      return 503;
  }
}

export function retryAfterHeaderSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
}

/** Keeps the 'Too Many Requests' body convention for 429s. */
export function admissionRejectionResponse(
  rejection: Extract<AdmitInteractiveTurnResult, { admitted: false }>,
): Response {
  const body = rejection.status === 429 ? 'Too Many Requests' : 'Service Unavailable';
  return new Response(body, {
    status: rejection.status,
    headers: { 'Retry-After': retryAfterHeaderSeconds(rejection.retryAfterMs) },
  });
}

/**
 * Stream-end wrapper with outcome mapping: normal completion -> `completed`,
 * client cancel -> `cancelled`, read/encode errors -> `error`.
 */
export function releaseAdmissionWhenStreamEnds<T extends Response>(res: T, lease: ChatAdmissionLease): T {
  const body = res.body;
  if (!body) {
    releaseAdmission(lease, 'completed');
    return res;
  }
  let finished = false;
  const finish = (outcome: ReleaseOutcome) => {
    if (finished) return;
    finished = true;
    releaseAdmission(lease, outcome);
  };
  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = body.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              controller.enqueue(value);
            } catch {
              finish('error');
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
          finish('completed');
          controller.close();
        } catch {
          finish('error');
          try {
            controller.error(new Error('Chat stream interrupted'));
          } catch {
          }
        }
      })();
    },
    cancel() {
      finish('cancelled');
    },
  });
  return new Response(tracked, { status: res.status, statusText: res.statusText, headers: res.headers }) as T;
}
