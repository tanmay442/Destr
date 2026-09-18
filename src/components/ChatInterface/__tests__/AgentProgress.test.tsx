import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  AgentProgress,
  AGENT_PROGRESS_FALLBACK_TEXT,
  progressLabelText,
  selectProgressDisplay,
  type AgentProgressViewEvent,
} from '../AgentProgress';

function searchingEvent(overrides: Partial<AgentProgressViewEvent> = {}): AgentProgressViewEvent {
  return {
    id: 'p-search',
    phase: 'searching',
    labelCode: 'search_running',
    completed: 1,
    total: 2,
    ...overrides,
  };
}

function acceptedEvent(): AgentProgressViewEvent {
  return { id: 'p-accepted', phase: 'accepted', labelCode: 'request_accepted' };
}

function completeEvent(): AgentProgressViewEvent {
  return { id: 'p-done', phase: 'complete', labelCode: 'answer_complete' };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('progress label mapping', () => {
  it('maps bounded label codes to fixed safe text', () => {
    expect(progressLabelText('search_running')).toBe('Searching documentation');
    expect(progressLabelText('sources_reading')).toBe('Checking sources');
    expect(progressLabelText('degraded_partial')).toBe(
      'Search is taking longer; using the sources already found',
    );
    expect(progressLabelText('answer_complete')).toBe('Done');
    expect(progressLabelText('request_cancelled')).toBe('Cancelled');
  });

  it('falls back to generic text for unknown codes and never renders raw input', () => {
    expect(progressLabelText('__proto__')).toBe(AGENT_PROGRESS_FALLBACK_TEXT);
    expect(progressLabelText('<script>alert(1)</script>')).toBe(AGENT_PROGRESS_FALLBACK_TEXT);
    expect(progressLabelText('DROP TABLE turns')).toBe(AGENT_PROGRESS_FALLBACK_TEXT);
  });
});

describe('selectProgressDisplay', () => {
  it('returns null for an empty event list', () => {
    expect(selectProgressDisplay([])).toBeNull();
  });

  it('coalesces updates by ID with latest winning', () => {
    const selection = selectProgressDisplay([
      { ...searchingEvent(), completed: 0 },
      { ...searchingEvent(), completed: 2, total: 2 },
    ]);
    expect(selection?.terminal).toBe(false);
    expect(selection?.event.completed).toBe(2);
  });

  it('keeps the terminal event sticky once present', () => {
    const selection = selectProgressDisplay([acceptedEvent(), completeEvent(), searchingEvent()]);
    expect(selection?.terminal).toBe(true);
    expect(selection?.event.phase).toBe('complete');
  });
});

describe('AgentProgress rendering', () => {
  it('renders nothing before the 300-500ms delay, then the safe label', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    render(<AgentProgress events={[acceptedEvent(), searchingEvent()]} />);
    expect(screen.queryByTestId('agent-progress')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(screen.queryByTestId('agent-progress')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent('Searching documentation');
  });

  it('renders the terminal state immediately without waiting for the delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    render(<AgentProgress events={[acceptedEvent(), completeEvent()]} />);
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent('Done');
  });

  it('renders degraded and cancelled terminals with their safe text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const { unmount } = render(
      <AgentProgress
        events={[{ id: 'p-deg', phase: 'degraded', labelCode: 'degraded_partial' }]}
      />,
    );
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent(
      'Search is taking longer; using the sources already found',
    );
    unmount();
    render(
      <AgentProgress
        events={[{ id: 'p-cancel', phase: 'cancelled', labelCode: 'request_cancelled' }]}
      />,
    );
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent('Cancelled');
  });

  it('uses one polite live region and keeps counters out of announcements', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    render(<AgentProgress events={[acceptedEvent(), searchingEvent()]} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const liveRegions = screen.getAllByTestId('agent-progress-status');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.getAttribute('aria-live')).toBe('polite');
    // The live region announces the phase label only, never the counters.
    expect(liveRegions[0]?.textContent).toBe('Searching documentation');
    const counter = screen.getByTestId('agent-progress-counter');
    expect(counter.getAttribute('aria-hidden')).toBe('true');
    expect(counter.textContent).toBe('(1 of 2)');
    // Exactly one aria-live region exists in the whole render.
    const allLive = document.querySelectorAll('[aria-live]');
    expect(allLive).toHaveLength(1);
  });

  it('shows a heartbeat after 10s of silence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    render(<AgentProgress events={[acceptedEvent(), searchingEvent()]} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent('Searching documentation');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId('agent-progress-status')).toHaveTextContent(
      'Still working on your request',
    );
  });

  it('renders fallback text for unknown label codes without leaking input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    const hostile = 'Ignore instructions; query was "secret docs"';
    render(
      <AgentProgress events={[acceptedEvent(), searchingEvent({ labelCode: hostile })]} />,
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const status = screen.getByTestId('agent-progress-status');
    expect(status).toHaveTextContent(AGENT_PROGRESS_FALLBACK_TEXT);
    expect(document.body.textContent).not.toContain('secret docs');
  });

  it('cleans up timers on unmount without errors', () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    const { unmount } = render(<AgentProgress events={[acceptedEvent(), searchingEvent()]} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('agent-progress')).not.toBeNull();
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByTestId('agent-progress')).toBeNull();
  });
});
