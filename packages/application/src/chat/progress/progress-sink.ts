import {
  assertP99ProgressPayloadWithinBudget,
  assertProgressPayloadWithinBudget,
  createProgressEvent,
  isTerminalProgressPhase,
  type AgentProgressEvent,
  type AgentProgressPhase,
  type ProgressLabelCode,
  type ProgressStatus,
} from './progress-event';

/**
 * Application-owned progress sink (WP-8 Task A, F-29/F-42).
 *
 * Injected into the agent, search orchestrator, verification, and persistence
 * seams. Those modules emit events when state changes; the route only
 * serializes them as transient `data-agent-progress` parts.
 *
 * Delivery policy (all deterministic; the clock is injectable for tests):
 * - The first event of a turn must be `accepted`.
 * - Updates for the same event ID coalesce: the latest wins.
 * - At most one non-terminal event per second per turn; excess updates are
 *   coalesced into pending state and released by `flush`.
 * - A heartbeat (`heartbeat_running`) is emitted only after
 *   `heartbeatIdleMs` of silence, and at most every `heartbeatEveryMs`.
 * - Terminal phases (`complete` / `degraded` / `cancelled`) bypass the rate
 *   limit, are emitted exactly once, and settle the sink: later emits,
 *   heartbeats, and flushes are no-ops.
 * - The sink owns no real timers, so there is nothing to leak; `dispose`
 *   exists to mark the end of a turn explicitly.
 */

export const PROGRESS_RATE_LIMIT_MS = 1_000 as const;
export const PROGRESS_HEARTBEAT_IDLE_MS = 10_000 as const;
export const PROGRESS_HEARTBEAT_EVERY_MS = 10_000 as const;

export interface ProgressEmitInput {
  readonly id: string;
  readonly phase: AgentProgressPhase;
  readonly status?: ProgressStatus;
  readonly labelCode: ProgressLabelCode;
  readonly elapsedMs: number;
  readonly callId?: string;
  readonly subquestionId?: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface CreateProgressSinkInput {
  readonly turnId: string;
  readonly onEmit: (event: AgentProgressEvent) => void;
  readonly clock?: () => number;
  readonly rateLimitMs?: number;
  readonly heartbeatIdleMs?: number;
  readonly heartbeatEveryMs?: number;
}

export interface AgentProgressSink {
  readonly turnId: string;
  readonly settled: boolean;
  readonly disposed: boolean;
  readonly emittedCount: number;
  emit(input: ProgressEmitInput): AgentProgressEvent | null;
  heartbeat(nowMs?: number): AgentProgressEvent | null;
  flush(nowMs?: number): AgentProgressEvent | null;
  complete(input: Omit<ProgressEmitInput, 'phase'> & { readonly phase?: AgentProgressPhase }): AgentProgressEvent | null;
  degrade(input: Omit<ProgressEmitInput, 'phase'> & { readonly phase?: AgentProgressPhase }): AgentProgressEvent | null;
  cancel(input: Omit<ProgressEmitInput, 'phase'> & { readonly phase?: AgentProgressPhase }): AgentProgressEvent | null;
  events(): readonly AgentProgressEvent[];
  validateOrdering(): void;
  assertPayloadBudget(): void;
  dispose(): void;
}

function defaultStatusFor(phase: AgentProgressPhase): ProgressStatus {
  switch (phase) {
    case 'complete':
      return 'completed';
    case 'degraded':
    case 'cancelled':
      return 'failed';
    case 'accepted':
      return 'started';
    default:
      return 'updated';
  }
}

/**
 * Pure ordering validator over an emitted event log: opens with `accepted`,
 * ends with exactly one terminal phase, and never regresses `elapsedMs`.
 */
export function validateProgressOrdering(
  turnId: string,
  emitted: readonly AgentProgressEvent[],
): void {
  if (emitted.length === 0) {
    throw new Error(`AgentProgressSink: turn ${turnId} emitted no events`);
  }
  const first = emitted[0];
  if (first === undefined || first.phase !== 'accepted') {
    throw new Error(`AgentProgressSink: turn ${turnId} must open with phase accepted`);
  }
  const terminals = emitted.filter((event) => isTerminalProgressPhase(event.phase));
  if (terminals.length !== 1) {
    throw new Error(
      `AgentProgressSink: turn ${turnId} must end in exactly one terminal phase, found ${terminals.length}`,
    );
  }
  const last = emitted[emitted.length - 1];
  if (last === undefined || !isTerminalProgressPhase(last.phase)) {
    throw new Error(`AgentProgressSink: turn ${turnId} terminal phase must be last`);
  }
  let previousElapsed = -1;
  for (const event of emitted) {
    if (event.elapsedMs < previousElapsed) {
      throw new Error(`AgentProgressSink: turn ${turnId} elapsedMs regressed`);
    }
    previousElapsed = event.elapsedMs;
  }
}

export function createAgentProgressSink(input: CreateProgressSinkInput): AgentProgressSink {
  const clock = input.clock ?? Date.now;
  const rateLimitMs = input.rateLimitMs ?? PROGRESS_RATE_LIMIT_MS;
  const heartbeatIdleMs = input.heartbeatIdleMs ?? PROGRESS_HEARTBEAT_IDLE_MS;
  const heartbeatEveryMs = input.heartbeatEveryMs ?? PROGRESS_HEARTBEAT_EVERY_MS;

  const emitted: AgentProgressEvent[] = [];
  const pending = new Map<string, ProgressEmitInput>();
  let pendingOrder: string[] = [];
  let lastEmitAt: number | null = null;
  let lastActivityAt: number | null = null;
  let lastHeartbeatAt: number | null = null;
  let currentPhase: AgentProgressPhase | null = null;
  let settled = false;
  let disposed = false;

  const publish = (event: AgentProgressEvent, nowMs: number): AgentProgressEvent => {
    assertProgressPayloadWithinBudget(event);
    emitted.push(event);
    lastEmitAt = nowMs;
    lastActivityAt = nowMs;
    currentPhase = event.phase;
    try {
      input.onEmit(event);
    } catch {
      // A failing transport must never break orchestration or leak internals.
    }
    return event;
  };

  const build = (raw: ProgressEmitInput): AgentProgressEvent =>
    createProgressEvent({
      id: raw.id,
      phase: raw.phase,
      status: raw.status ?? defaultStatusFor(raw.phase),
      labelCode: raw.labelCode,
      elapsedMs: raw.elapsedMs,
      ...(raw.callId === undefined ? {} : { callId: raw.callId }),
      ...(raw.subquestionId === undefined ? {} : { subquestionId: raw.subquestionId }),
      ...(raw.completed === undefined ? {} : { completed: raw.completed }),
      ...(raw.total === undefined ? {} : { total: raw.total }),
    });

  const enqueuePending = (raw: ProgressEmitInput): void => {
    if (!pending.has(raw.id)) pendingOrder.push(raw.id);
    pending.set(raw.id, raw);
  };

  const emitTerminal = (
    raw: ProgressEmitInput,
    terminal: 'complete' | 'degraded' | 'cancelled',
    nowMs: number,
  ): AgentProgressEvent | null => {
    if (settled || disposed) return null;
    if (raw.phase !== terminal) return null;
    pending.clear();
    pendingOrder = [];
    const event = publish(build(raw), nowMs);
    settled = true;
    return event;
  };

  const sink: AgentProgressSink = {
    turnId: input.turnId,
    get settled() {
      return settled;
    },
    get disposed() {
      return disposed;
    },
    get emittedCount() {
      return emitted.length;
    },
    emit(raw) {
      if (settled || disposed) return null;
      const nowMs = clock();
      if (emitted.length === 0 && pending.size === 0 && raw.phase !== 'accepted') {
        throw new Error(
          `AgentProgressSink: first event of turn ${input.turnId} must be phase accepted, received ${raw.phase}`,
        );
      }
      if (isTerminalProgressPhase(raw.phase)) {
        return emitTerminal(raw, raw.phase, nowMs);
      }
      if (lastEmitAt !== null && nowMs - lastEmitAt < rateLimitMs) {
        enqueuePending(raw);
        return null;
      }
      return publish(build(raw), nowMs);
    },
    heartbeat(nowMsInput) {
      if (settled || disposed || emitted.length === 0 || currentPhase === null) return null;
      const nowMs = nowMsInput ?? clock();
      if (isTerminalProgressPhase(currentPhase)) return null;
      if (lastActivityAt === null || nowMs - lastActivityAt < heartbeatIdleMs) return null;
      if (lastHeartbeatAt !== null && nowMs - lastHeartbeatAt < heartbeatEveryMs) return null;
      const event = build({
        id: `heartbeat-${input.turnId}`,
        phase: currentPhase,
        status: 'updated',
        labelCode: 'heartbeat_running',
        elapsedMs: nowMs,
      });
      lastHeartbeatAt = nowMs;
      return publish(event, nowMs);
    },
    flush(nowMsInput) {
      if (settled || disposed || pendingOrder.length === 0) return null;
      const nowMs = nowMsInput ?? clock();
      if (lastEmitAt !== null && nowMs - lastEmitAt < rateLimitMs) return null;
      const id = pendingOrder.shift();
      if (id === undefined) return null;
      const raw = pending.get(id);
      pending.delete(id);
      if (raw === undefined) return sink.flush(nowMs);
      if (isTerminalProgressPhase(raw.phase)) {
        return emitTerminal(raw, raw.phase, nowMs);
      }
      // Coalesced by ID: only the latest update per ID was retained.
      return publish(build(raw), nowMs);
    },
    complete(raw) {
      const nowMs = clock();
      return emitTerminal({ ...raw, phase: raw.phase ?? 'complete' }, 'complete', nowMs);
    },
    degrade(raw) {
      const nowMs = clock();
      return emitTerminal({ ...raw, phase: raw.phase ?? 'degraded' }, 'degraded', nowMs);
    },
    cancel(raw) {
      const nowMs = clock();
      return emitTerminal({ ...raw, phase: raw.phase ?? 'cancelled' }, 'cancelled', nowMs);
    },
    events() {
      return Object.freeze([...emitted]);
    },
    validateOrdering() {
      validateProgressOrdering(input.turnId, emitted);
    },
    assertPayloadBudget() {
      assertP99ProgressPayloadWithinBudget(emitted);
    },
    dispose() {
      disposed = true;
      pending.clear();
      pendingOrder = [];
    },
  };

  return sink;
}
