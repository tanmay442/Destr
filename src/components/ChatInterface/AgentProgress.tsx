'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clock, FileCheck, FileStack, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Truthful agent progress renderer (WP-8 Task A, F-29/F-42).
 *
 * Renders only server-emitted transient `data-agent-progress` events. Every
 * label comes from the bounded `labelCode` vocabulary mapped below to fixed
 * safe text: raw planner rationale, queries, tool arguments, scores, provider
 * errors, and document text can never reach this component because the
 * application schema has no field for them.
 *
 * Delivery behavior:
 * - The indicator waits `showDelayMs` (default 400ms, inside the 300-500ms
 *   band) so fast answers never flicker; terminal events render immediately.
 * - Updates for the same event ID coalesce (latest wins); at most one
 *   non-terminal render per `coalesceWindowMs` (default 1s) per turn, with a
 *   trailing flush so the newest state is never dropped.
 * - After `heartbeatAfterMs` (default 10s) of silence a quiet heartbeat line
 *   says the current operation is still running.
 * - Accessibility: exactly one polite `aria-live` region announces phase
 *   text only. Counters render in an `aria-hidden` span and are never
 *   announced per update.
 */

export interface AgentProgressViewEvent {
  readonly id: string;
  readonly phase: string;
  readonly labelCode: string;
  readonly completed?: number | undefined;
  readonly total?: number | undefined;
}

export interface AgentProgressProps {
  readonly events: readonly AgentProgressViewEvent[];
  readonly showDelayMs?: number;
  readonly coalesceWindowMs?: number;
  readonly heartbeatAfterMs?: number;
}

export const AGENT_PROGRESS_SHOW_DELAY_MS = 400 as const;
export const AGENT_PROGRESS_COALESCE_WINDOW_MS = 1_000 as const;
export const AGENT_PROGRESS_HEARTBEAT_AFTER_MS = 10_000 as const;

const LABEL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  request_accepted: 'Request received',
  cache_checking: 'Checking for a saved answer',
  cache_hit: 'Found a saved answer',
  plan_ready: 'Planning the search',
  search_running: 'Searching documentation',
  search_partial: 'Searching documentation',
  rerank_running: 'Ranking the most relevant sources',
  sources_reading: 'Checking sources',
  draft_ready: 'Drafting the answer',
  verify_running: 'Verifying the answer',
  save_done: 'Saving the conversation',
  answer_complete: 'Done',
  degraded_partial: 'Search is taking longer; using the sources already found',
  request_cancelled: 'Cancelled',
  heartbeat_running: 'Still working on your request',
});

export const AGENT_PROGRESS_FALLBACK_TEXT = 'Working on your request';

export function progressLabelText(labelCode: string): string {
  // hasOwnProperty (not `??`): `LABEL_TEXT['__proto__']` would otherwise
  // resolve to Object.prototype through the prototype chain.
  if (Object.prototype.hasOwnProperty.call(LABEL_TEXT, labelCode)) {
    const text = LABEL_TEXT[labelCode];
    if (typeof text === 'string') return text;
  }
  return AGENT_PROGRESS_FALLBACK_TEXT;
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set(['complete', 'degraded', 'cancelled']);

function isTerminalEvent(event: AgentProgressViewEvent): boolean {
  return TERMINAL_PHASES.has(event.phase);
}

function PhaseGlyph({ phase, spinning }: { readonly phase: string; readonly spinning: boolean }): ReactNode {
  const className = cn('size-4', spinning && 'animate-pulse');
  switch (phase) {
    case 'checking_cache':
    case 'planning':
    case 'searching':
      return <Search className={className} aria-hidden />;
    case 'reranking':
    case 'reading_sources':
      return <FileStack className={className} aria-hidden />;
    case 'complete':
    case 'verifying':
      return <FileCheck className={className} aria-hidden />;
    default:
      return <Clock className={className} aria-hidden />;
  }
}

interface DisplaySelection {
  readonly event: AgentProgressViewEvent;
  readonly terminal: boolean;
}

/**
 * Coalesces updates by event ID (latest wins) and selects what to display:
 * the terminal event when one exists (sticky), otherwise the latest arrival.
 */
export function selectProgressDisplay(
  events: readonly AgentProgressViewEvent[],
): DisplaySelection | null {
  if (events.length === 0) return null;
  const latestById = new Map<string, AgentProgressViewEvent>();
  for (const event of events) {
    latestById.set(event.id, event);
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && isTerminalEvent(event)) {
      return { event, terminal: true };
    }
  }
  const last = events[events.length - 1];
  if (last === undefined) return null;
  return { event: latestById.get(last.id) ?? last, terminal: false };
}

function formatCounter(event: AgentProgressViewEvent): string | null {
  if (event.completed === undefined || event.total === undefined) return null;
  if (!Number.isInteger(event.completed) || !Number.isInteger(event.total)) return null;
  if (event.completed < 0 || event.total <= 0 || event.completed > event.total) return null;
  return `${event.completed} of ${event.total}`;
}

export function AgentProgress({
  events,
  showDelayMs = AGENT_PROGRESS_SHOW_DELAY_MS,
  coalesceWindowMs = AGENT_PROGRESS_COALESCE_WINDOW_MS,
  heartbeatAfterMs = AGENT_PROGRESS_HEARTBEAT_AFTER_MS,
}: AgentProgressProps): ReactNode {
  const selection = useMemo(() => selectProgressDisplay(events), [events]);
  const [revealed, setRevealed] = useState(false);
  const [throttled, setThrottled] = useState<DisplaySelection | null>(null);
  const [heartbeat, setHeartbeat] = useState(false);
  const lastFlushAtRef = useRef<number>(0);
  const lastChangeAtRef = useRef<number>(0);

  // Track the latest selection arrival for the heartbeat. Ref writes inside
  // effects keep render pure; no setState happens here.
  useEffect(() => {
    lastChangeAtRef.current = Date.now();
  }, [selection]);

  // Reveal timer: non-terminal progress waits out the anti-flicker delay.
  // Terminal events skip the wait by derivation below, not by state.
  useEffect(() => {
    if (selection === null || selection.terminal || revealed) return;
    const timer = setTimeout(() => {
      lastFlushAtRef.current = Date.now();
      setThrottled(selectProgressDisplay(events));
      setRevealed(true);
    }, showDelayMs);
    return () => clearTimeout(timer);
  }, [selection, revealed, showDelayMs, events]);

  // Coalescing throttle: at most one non-terminal render per window, with a
  // trailing flush. All state updates happen in timer callbacks, never
  // synchronously in the effect body.
  useEffect(() => {
    if (selection === null || selection.terminal || !revealed) return;
    const wait = Math.max(0, coalesceWindowMs - (Date.now() - lastFlushAtRef.current));
    const timer = setTimeout(() => {
      lastFlushAtRef.current = Date.now();
      setThrottled(selectProgressDisplay(events));
    }, wait);
    return () => clearTimeout(timer);
  }, [selection, revealed, coalesceWindowMs, events]);

  // Shown event: terminal selections render immediately and stick; otherwise
  // the throttled snapshot renders once revealed.
  const shown = selection?.terminal === true ? selection : revealed ? throttled : null;

  // Heartbeat ticker: announces nothing itself, it only flips to the quiet
  // heartbeat line after sustained silence. Cleared on unmount/terminal.
  useEffect(() => {
    if (shown === null || shown.terminal) return;
    const timer = setInterval(() => {
      setHeartbeat(Date.now() - lastChangeAtRef.current >= heartbeatAfterMs);
    }, 1000);
    return () => clearInterval(timer);
  }, [shown, heartbeatAfterMs]);

  if (shown === null) return null;

  const text =
    heartbeat && !shown.terminal
      ? progressLabelText('heartbeat_running')
      : progressLabelText(shown.event.labelCode);
  const counter = shown.terminal ? null : formatCounter(shown.event);

  return (
    <span
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="agent-progress"
    >
      <PhaseGlyph phase={shown.event.phase} spinning={!shown.terminal} />
      <span aria-live="polite" data-testid="agent-progress-status">
        {text}
      </span>
      {counter !== null ? (
        <span aria-hidden="true" data-testid="agent-progress-counter">
          ({counter})
        </span>
      ) : null}
    </span>
  );
}
