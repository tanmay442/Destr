import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

vi.mock('@/components/ChatInterface', () => ({
  ChatInterface: (props: {
    conversationId: string;
    initialMessages: Array<{ id: string; role: string; parts: unknown[] }>;
    initialTurnIds?: Record<string, string>;
  }) => (
    <div
      data-testid="chat-interface-stub"
      data-conversation={props.conversationId}
      data-messages={props.initialMessages.length}
      data-turn-ids={JSON.stringify(props.initialTurnIds ?? {})}
    />
  ),
}));

import { ChatConversationLoader } from './ChatConversationLoader';

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

  it('redirects to /chat when the conversation is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000009" />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/chat'));
  });

  it('mints a new chat for /chat and syncs the id into the URL without navigation', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    render(<ChatConversationLoader routeId={null} />);
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub.getAttribute('data-conversation')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(null, '', `/chat/${stub.getAttribute('data-conversation')}`),
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('keeps the UI usable when the resume fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );
    render(<ChatConversationLoader routeId="b0000000-0000-4000-8000-000000000003" />);
    const stub = await screen.findByTestId('chat-interface-stub');
    expect(stub).toHaveAttribute('data-messages', '0');
  });
});
