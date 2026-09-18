import { describe, expect, it } from 'vitest';
import {
  createAgentProgressSink,
  validateProgressOrdering,
  PROGRESS_HEARTBEAT_EVERY_MS,
  PROGRESS_HEARTBEAT_IDLE_MS,
  PROGRESS_RATE_LIMIT_MS,
  type ProgressEmitInput,
} from '../progress-sink';
import type { AgentProgressEvent } from '../progress-event';

function manualClock(startMs = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

function accepted(id = 'p-accepted', elapsedMs = 0): ProgressEmitInput {
  return { id, phase: 'accepted', labelCode: 'request_accepted', elapsedMs };
}

function searching(id = 'p-search', elapsedMs = 100): ProgressEmitInput {
  return {
    id,
    phase: 'searching',
    labelCode: 'search_running',
    elapsedMs,
    callId: 'call-1',
    subquestionId: 'sq-1',
    completed: 1,
    total: 2,
  };
}

describe('progress ordering', () => {
  it('requires the first event to be accepted', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    expect(() => sink.emit(searching())).toThrow(/must be phase accepted/);
    expect(emitted).toHaveLength(0);
    expect(sink.emit(accepted())).not.toBeNull();
  });

  it('validates real phase order ending in exactly one terminal', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now, rateLimitMs: 0 });
    sink.emit(accepted('p-accepted', 0));
    sink.emit({ id: 'p-cache', phase: 'checking_cache', labelCode: 'cache_checking', elapsedMs: 50 });
    sink.emit({ id: 'p-plan', phase: 'planning', labelCode: 'plan_ready', elapsedMs: 150 });
    sink.emit(searching('p-search', 300));
    sink.emit({ id: 'p-rerank', phase: 'reranking', labelCode: 'rerank_running', elapsedMs: 900 });
    sink.emit({ id: 'p-read', phase: 'reading_sources', labelCode: 'sources_reading', elapsedMs: 1200 });
    sink.emit({ id: 'p-draft', phase: 'drafting', labelCode: 'draft_ready', elapsedMs: 2000 });
    sink.emit({ id: 'p-verify', phase: 'verifying', labelCode: 'verify_running', elapsedMs: 2600 });
    sink.emit({ id: 'p-save', phase: 'saving', labelCode: 'save_done', elapsedMs: 2900 });
    sink.complete({ id: 'p-done', labelCode: 'answer_complete', elapsedMs: 3000 });
    expect(() => sink.validateOrdering()).not.toThrow();
    expect(() => sink.assertPayloadBudget()).not.toThrow();
    expect(sink.settled).toBe(true);
  });

  it('rejects missing, duplicated, or misplaced terminal phases', () => {
    const events = (phases: string[]): AgentProgressEvent[] =>
      phases.map(
        (phase, index) =>
          ({
            id: `p-${index}`,
            phase,
            status: 'updated',
            labelCode: 'search_running',
            elapsedMs: index * 100,
          }) as AgentProgressEvent,
      );
    const check = (turnEvents: AgentProgressEvent[]): string | null => {
      try {
        validateProgressOrdering('turn-x', turnEvents);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return null;
    };
    expect(check([])).toMatch(/no events/);
    expect(check(events(['searching', 'complete']))).toMatch(/must open with phase accepted/);
    expect(check(events(['accepted', 'searching']))).toMatch(/exactly one terminal/);
    expect(check(events(['accepted', 'complete', 'complete']))).toMatch(/exactly one terminal/);
    expect(check(events(['accepted', 'complete', 'searching']))).toMatch(/terminal phase must be last/);
  });

  it('rejects elapsedMs regression', () => {
    const collected: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({
      turnId: 'turn-1',
      onEmit: (event) => collected.push(event),
      clock: clock.now,
      rateLimitMs: 0,
    });
    sink.emit(accepted('p-accepted', 500));
    sink.emit({ id: 'p-search', phase: 'searching', labelCode: 'search_running', elapsedMs: 100 });
    sink.complete({ id: 'p-done', labelCode: 'answer_complete', elapsedMs: 600 });
    expect(() => sink.validateOrdering()).toThrow(/regressed/);
  });
});

describe('progress coalescing and rate limiting', () => {
  it('coalesces updates for the same event ID and flushes only the latest', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    expect(sink.emit(accepted())).not.toBeNull();
    clock.advance(PROGRESS_RATE_LIMIT_MS);
    expect(sink.emit({ ...searching('p-search', 1100), completed: 0 })).not.toBeNull();
    // Within the 1s window: coalesced, not emitted.
    expect(sink.emit({ ...searching('p-search', 1200), completed: 1 })).toBeNull();
    expect(sink.emit({ ...searching('p-search', 1300), completed: 2, total: 2 })).toBeNull();
    expect(emitted).toHaveLength(2);
    clock.advance(PROGRESS_RATE_LIMIT_MS);
    const flushed = sink.flush();
    expect(flushed?.completed).toBe(2);
    expect(flushed?.elapsedMs).toBe(1300);
    expect(emitted).toHaveLength(3);
    expect(sink.flush()).toBeNull();
  });

  it('emits at most one non-terminal event per second per turn', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    sink.emit(accepted());
    sink.emit({ id: 'p-plan', phase: 'planning', labelCode: 'plan_ready', elapsedMs: 10 });
    // Second non-terminal inside the window is held even for a new ID.
    expect(sink.emit({ id: 'p-other', phase: 'planning', labelCode: 'plan_ready', elapsedMs: 20 })).toBeNull();
    expect(emitted).toHaveLength(1);
    clock.advance(999);
    expect(sink.flush()).toBeNull();
    clock.advance(1);
    expect(sink.flush()).not.toBeNull();
    expect(emitted).toHaveLength(2);
  });
});

describe('progress heartbeat', () => {
  it('stays silent before the idle threshold and beats every 10s after', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now, rateLimitMs: 0 });
    expect(sink.heartbeat()).toBeNull();
    sink.emit(accepted());
    clock.advance(PROGRESS_HEARTBEAT_IDLE_MS - 1);
    expect(sink.heartbeat()).toBeNull();
    clock.advance(1);
    const beat = sink.heartbeat();
    expect(beat?.labelCode).toBe('heartbeat_running');
    expect(beat?.phase).toBe('accepted');
    // Second heartbeat inside the 10s cadence is suppressed.
    clock.advance(PROGRESS_HEARTBEAT_EVERY_MS - 1);
    expect(sink.heartbeat()).toBeNull();
    clock.advance(1);
    expect(sink.heartbeat()).not.toBeNull();
  });

  it('emits no heartbeat after the terminal event', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now, rateLimitMs: 0 });
    sink.emit(accepted());
    sink.complete({ id: 'p-done', labelCode: 'answer_complete', elapsedMs: 50 });
    clock.advance(60_000);
    expect(sink.heartbeat()).toBeNull();
    expect(sink.flush()).toBeNull();
  });
});

describe('progress terminal states', () => {
  it('emits complete immediately, bypassing the rate limit, exactly once', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    sink.emit(accepted());
    sink.emit(searching());
    const terminal = sink.complete({ id: 'p-done', labelCode: 'answer_complete', elapsedMs: 200 });
    expect(terminal?.phase).toBe('complete');
    expect(terminal?.status).toBe('completed');
    expect(sink.settled).toBe(true);
    // Exactly once: every later delivery path is a no-op.
    expect(sink.complete({ id: 'p-done-2', labelCode: 'answer_complete', elapsedMs: 300 })).toBeNull();
    expect(sink.emit(searching('p-late', 400))).toBeNull();
    expect(sink.flush()).toBeNull();
    expect(emitted.filter((event) => event.phase === 'complete')).toHaveLength(1);
    expect(() => sink.validateOrdering()).not.toThrow();
  });

  it('supports degraded and cancelled terminals with failure status', () => {
    const degraded: AgentProgressEvent[] = [];
    const clock = manualClock();
    const degradedSink = createAgentProgressSink({
      turnId: 'turn-d',
      onEmit: (event) => degraded.push(event),
      clock: clock.now,
      rateLimitMs: 0,
    });
    degradedSink.emit(accepted());
    const terminal = degradedSink.degrade({ id: 'p-deg', labelCode: 'degraded_partial', elapsedMs: 900 });
    expect(terminal?.phase).toBe('degraded');
    expect(terminal?.status).toBe('failed');
    expect(degradedSink.settled).toBe(true);

    const cancelled: AgentProgressEvent[] = [];
    const cancelledSink = createAgentProgressSink({
      turnId: 'turn-c',
      onEmit: (event) => cancelled.push(event),
      clock: clock.now,
      rateLimitMs: 0,
    });
    cancelledSink.emit(accepted());
    const cancelTerminal = cancelledSink.cancel({ id: 'p-cancel', labelCode: 'request_cancelled', elapsedMs: 100 });
    expect(cancelTerminal?.phase).toBe('cancelled');
    expect(cancelledSink.settled).toBe(true);
    expect(() => cancelledSink.validateOrdering()).not.toThrow();
  });

  it('clears coalesced pending work when the terminal arrives', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    sink.emit(accepted());
    sink.emit(searching());
    sink.emit({ id: 'p-plan', phase: 'planning', labelCode: 'plan_ready', elapsedMs: 150 });
    sink.complete({ id: 'p-done', labelCode: 'answer_complete', elapsedMs: 200 });
    expect(sink.flush()).toBeNull();
    expect(emitted.map((event) => event.phase)).toEqual(['accepted', 'complete']);
  });
});

describe('progress sink robustness', () => {
  it('survives a throwing transport without breaking orchestration', () => {
    const clock = manualClock();
    const sink = createAgentProgressSink({
      turnId: 'turn-1',
      onEmit: () => {
        throw new Error('transport down');
      },
      clock: clock.now,
      rateLimitMs: 0,
    });
    expect(sink.emit(accepted())).not.toBeNull();
    expect(sink.emittedCount).toBe(1);
    expect(sink.events()).toHaveLength(1);
  });

  it('exposes a frozen event log and disposes cleanly', () => {
    const emitted: AgentProgressEvent[] = [];
    const clock = manualClock();
    const sink = createAgentProgressSink({ turnId: 'turn-1', onEmit: (event) => emitted.push(event), clock: clock.now });
    sink.emit(accepted());
    expect(Object.isFrozen(sink.events())).toBe(true);
    sink.dispose();
    expect(sink.disposed).toBe(true);
    expect(sink.emit(searching())).toBeNull();
    expect(sink.flush()).toBeNull();
    expect(sink.heartbeat()).toBeNull();
    expect(emitted).toHaveLength(1);
  });
});
