import type { AgentStopReason } from './agent-stop';
import type { AgentRunSummary } from './agent-telemetry';

export type AgentRunStatus = 'running' | 'awaiting_approval' | 'stopped' | 'completed' | 'failed';

export interface AgentStepToolCall {
  readonly toolName: string;
  readonly callId: string;
  readonly argsHash: string;
  readonly kind: string;
}

export interface AgentStepRecord {
  readonly stepNumber: number;
  readonly activeTools: readonly string[];
  readonly toolCalls: readonly AgentStepToolCall[];
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export type AgentEvent =
  | { readonly type: 'run_started'; readonly runId: string; readonly atMs: number }
  | {
      readonly type: 'step_started';
      readonly stepNumber: number;
      readonly activeTools: readonly string[];
      readonly atMs: number;
    }
  | {
      readonly type: 'step_finished';
      readonly stepNumber: number;
      readonly toolCalls: number;
      readonly atMs: number;
    }
  | {
      readonly type: 'tool_called';
      readonly toolName: string;
      readonly callId: string;
      readonly argsHash: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'tool_finished';
      readonly toolName: string;
      readonly callId: string;
      readonly kind: string;
      readonly durationMs: number;
    }
  | { readonly type: 'approval_interrupted'; readonly toolName: string; readonly callId: string; readonly atMs: number }
  | { readonly type: 'stopped'; readonly reason: AgentStopReason; readonly atMs: number }
  | { readonly type: 'run_completed'; readonly atMs: number; readonly summary: AgentRunSummary };

export interface AgentRunState {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly steps: readonly AgentStepRecord[];
  readonly events: readonly AgentEvent[];
  readonly stopReason: AgentStopReason | null;
}

export function createInitialRunState(runId: string): AgentRunState {
  if (runId.trim() === '') throw new Error('createInitialRunState: runId must be non-empty');
  const state: AgentRunState = {
    runId,
    status: 'running',
    steps: Object.freeze([]),
    events: Object.freeze([]),
    stopReason: null,
  };
  return Object.freeze(state);
}

function copyEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'step_started': {
      const copied: AgentEvent = {
        ...event,
        activeTools: Object.freeze([...event.activeTools]),
      };
      return Object.freeze(copied);
    }
    case 'stopped': {
      const copied: AgentEvent = { ...event, reason: Object.freeze({ ...event.reason }) };
      return Object.freeze(copied);
    }
    case 'run_completed': {
      const copied: AgentEvent = {
        ...event,
        summary: Object.freeze({
          ...event.summary,
          callsByTool: Object.freeze({ ...event.summary.callsByTool }),
        }),
      };
      return Object.freeze(copied);
    }
    default: {
      return Object.freeze({ ...event });
    }
  }
}

function withStepReplaced(
  steps: readonly AgentStepRecord[],
  index: number,
  updated: AgentStepRecord,
): readonly AgentStepRecord[] {
  return Object.freeze([...steps.slice(0, index), updated, ...steps.slice(index + 1)]);
}

export function appendEvent(state: AgentRunState, event: AgentEvent): AgentRunState {
  const events: readonly AgentEvent[] = Object.freeze([...state.events, copyEvent(event)]);
  let steps = state.steps;
  let status = state.status;
  let stopReason = state.stopReason;
  switch (event.type) {
    case 'run_started': {
      status = 'running';
      break;
    }
    case 'step_started': {
      status = 'running';
      const record: AgentStepRecord = {
        stepNumber: event.stepNumber,
        activeTools: Object.freeze([...event.activeTools]),
        toolCalls: Object.freeze([]),
        startedAtMs: event.atMs,
        endedAtMs: event.atMs,
      };
      steps = Object.freeze([...steps, Object.freeze(record)]);
      break;
    }
    case 'step_finished': {
      status = 'running';
      const index = steps.findIndex((step) => step.stepNumber === event.stepNumber);
      const previous = steps[index];
      // Unknown step numbers record the event only; the reducer never invents a step.
      if (index === -1 || previous === undefined) break;
      steps = withStepReplaced(steps, index, { ...previous, endedAtMs: event.atMs });
      break;
    }
    case 'tool_called': {
      const last = steps[steps.length - 1];
      if (last === undefined) break;
      const entry: AgentStepToolCall = {
        toolName: event.toolName,
        callId: event.callId,
        argsHash: event.argsHash,
        kind: 'called',
      };
      steps = withStepReplaced(steps, steps.length - 1, {
        ...last,
        toolCalls: Object.freeze([...last.toolCalls, Object.freeze(entry)]),
      });
      break;
    }
    case 'tool_finished': {
      let index = -1;
      for (let candidate = steps.length - 1; candidate >= 0; candidate -= 1) {
        const step = steps[candidate];
        if (step !== undefined && step.toolCalls.some((call) => call.callId === event.callId)) {
          index = candidate;
          break;
        }
      }
      const previous = steps[index];
      if (index === -1 || previous === undefined) break;
      const toolCalls = Object.freeze(
        previous.toolCalls.map((call) =>
          call.callId === event.callId ? Object.freeze({ ...call, kind: event.kind }) : call,
        ),
      );
      steps = withStepReplaced(steps, index, { ...previous, toolCalls });
      break;
    }
    case 'approval_interrupted': {
      status = 'awaiting_approval';
      break;
    }
    case 'stopped': {
      status = 'stopped';
      stopReason = event.reason;
      break;
    }
    case 'run_completed': {
      status = 'completed';
      break;
    }
  }
  const next: AgentRunState = { runId: state.runId, status, steps, events, stopReason };
  return Object.freeze(next);
}
