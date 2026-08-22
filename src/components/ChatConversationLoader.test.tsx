import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const pushMock = vi.fn();
const replaceMock = vi.fn();
const routerStub = { push: pushMock, replace: replaceMock };

vi.mock('next/navigation', () => ({
  useRouter: () => routerStub,
}));

vi.mock('@/components/ChatInterface', () => ({
  ChatInterface: (props: {
    conversationId: string;
    initialMessages: Array<{ id: string; role: string; parts: unknown[] }>;
    initialTurnIds?: Record<string, string>;
    conversationLimitReached?: boolean;
    truncated?: boolean;
  }) => (
    <div
      data-testid="chat-interface-stub"
      data-conversation={props.conversationId}
      data-messages={props.initialMessages.length}
      data-turn-ids={JSON.stringify(props.initialTurnIds ?? {})}
      data-limit-reached={props.conversationLimitReached ? 'true' : 'false'}
      data-truncated={props.truncated ? 'true' : 'false'}
    />
  ),
}));

import { ChatConversationLoader } from './ChatConversationLoader';
import { requestNewChat } from '@/chat/events';

function conversationPayload(messageCount = 2) {
  return {
    conversation: { id: 'b0000000-0000-4000-8000-000000000002', title: 'T', messageCount },
    messages: [
      {
        id: 1,
        turnId: null,
        role: 'user',
        content: { id: 'm1', parts: [{ type: 'text', text: 'q' }] },
      },
      {
        id: 2,
        turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        role: 'assistant',
        content: { id: 'a1', parts: [{ type: 'text', text: 'a' }] },
      },
    ],
  };
}

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
});

describe('ChatConversationLoader', () => {
  it('shows a skeleton while the resume request is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000002" />);
    expect(screen.getByTestId('chat-resume-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-interface-stub')).not.toBeInTheDocument();
  });

  it('renders the resumed conversation with rebuilt messages and turn ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => conversationPayload() }) as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000002" />);
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub).toHaveAttribute('data-conversation', 'b0000000-0000-4000-8000-000000000002');
    expect(stub).toHaveAttribute('data-messages', '2');
    expect(JSON.parse(stub.getAttribute('data-turn-ids')!)).toEqual({
      a1: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    expect(screen.queryByTestId('chat-resume-skeleton')).not.toBeInTheDocument();
  });

  it('flags truncated resumes so the interface shows the window notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => conversationPayload(350),
      }) as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000002" />);
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub).toHaveAttribute('data-messages', '2');
    expect(stub).toHaveAttribute('data-truncated', 'true');
  });

  it('falls back to a fresh draft instead of an error panel when the conversation is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000009" />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/chat'));
    expect(screen.queryByTestId('chat-resume-error')).not.toBeInTheDocument();
  });

  it('mints a new chat for /chat and syncs the id into the URL without navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [], total: 0 }) }) as Response),
    );
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    render(<ChatConversationLoader routeId={null} />);
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub.getAttribute('data-conversation')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith({}, '', `/chat/${stub.getAttribute('data-conversation')}`),
    );
    expect(replaceState.mock.calls.every((call) => call[0] !== null)).toBe(true);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('preserves existing Next router history state when syncing the URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [], total: 0 }) }) as Response),
    );
    const replaceState = vi.fn();
    const routerState = { __NA: true, __PRIVATE_TREE: [1, 2] };
    vi.stubGlobal('history', { replaceState, state: routerState });
    render(<ChatConversationLoader routeId={null} />);
    const stub = await screen.findByTestId('chat-interface-stub');
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(
        routerState,
        '',
        `/chat/${stub.getAttribute('data-conversation')}`,
      ),
    );
  });

  it('resets its own state when a new-chat request arrives while already on /chat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [], total: 0 }) }) as Response),
    );
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    render(<ChatConversationLoader routeId={null} />);
    const stub = await screen.findByTestId('chat-interface-stub');
    const firstId = stub.getAttribute('data-conversation');
    act(() => requestNewChat());
    await waitFor(() =>
      expect(screen.getByTestId('chat-interface-stub').getAttribute('data-conversation')).not.toBe(firstId),
    );
    const newId = screen.getByTestId('chat-interface-stub').getAttribute('data-conversation');
    await waitFor(() => expect(replaceState).toHaveBeenCalledWith({}, '', `/chat/${newId}`));
  });

  it('shows an error state with retry when the resume fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => conversationPayload(),
        } as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000003" />);
    const panel = await screen.findByTestId('chat-resume-error');
    expect(panel).toHaveTextContent('status 500');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub).toHaveAttribute('data-messages', '2');
  });

  it('labels a 400 resume response as an invalid conversation link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400 }) as Response),
    );
    render(<ChatConversationLoader routeId="not-a-uuid" />);
    const panel = await screen.findByTestId('chat-resume-error');
    expect(panel).toHaveTextContent('Invalid conversation link');
  });

  it('flags the composer when the conversation cap is already reached on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [], total: 512 }) }) as Response),
    );
    render(<ChatConversationLoader routeId={null} />);
    const stub = await screen.findByTestId('chat-interface-stub');
    await waitFor(() => expect(stub).toHaveAttribute('data-limit-reached', 'true'));
  });

  it('surfaces a timeout error when the resume request hangs', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('The operation was aborted.'));
            });
          });
        }),
      );
      render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000004" />);
      expect(screen.getByTestId('chat-resume-skeleton')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      const panel = await screen.findByTestId('chat-resume-error');
      expect(panel).toHaveTextContent('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
