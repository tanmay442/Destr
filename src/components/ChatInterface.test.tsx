import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

const useChatMock = vi.fn();
vi.mock('@ai-sdk/react', () => ({
  useChat: (...args: unknown[]) => useChatMock(...args),
}));

vi.mock('ai', () => ({
  DefaultChatTransport: class {
    constructor() {}
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from '@/components/ui/sonner';
import { ChatInterface } from './ChatInterface';

type Msg = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<
    | { type: 'text'; text: string }
    | {
        type: 'data-citation';
        data: {
          id?: number;
          documentId?: number;
          similarity: number;
          snippet: string;
          fileName?: string | null;
          page?: number | null;
          sectionTitle?: string | null;
          source?: string | null;
        };
      }
    | { type: 'data-guardrail'; data: {
        outOfDomain: boolean;
        offerTicket: boolean;
        notice?: boolean;
        message?: string;
        isEmpty?: boolean;
        resultState?: string;
      } }
    | { type: 'data-conversation-persisted'; data: { conversationId: string } }
  >;
};

function setupChat(messages: Msg[] = [], opts: { status?: string; send?: (m: { text: string }) => void } = {}) {
  const sendMessage = opts.send ?? vi.fn();
  useChatMock.mockReturnValue({
    messages,
    sendMessage,
    status: opts.status ?? 'ready',
    error: undefined,
    stop: vi.fn(),
  });
  return { sendMessage };
}

beforeEach(() => {
  useChatMock.mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type OnFinish = (options: {
  message: Msg;
  messages: Msg[];
  isAbort: boolean;
  isDisconnect: boolean;
  isError: boolean;
}) => void;

async function renderWithBoundTurn(assistant: Msg) {
  const sendMessage = vi.fn();
  setupChat([], { send: sendMessage });
  const view = render(<ChatInterface conversationId="conv-test" />);
  fireEvent.change(screen.getByTestId('chat-input'), {
    target: { value: 'Question?' },
  });
  fireEvent.click(screen.getByTestId('chat-send'));
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  const firstCall = sendMessage.mock.calls[0]!;
  const { id } = firstCall[0] as { id: string };
  const turnId = (firstCall[1] as { body: { turnId: string } }).body.turnId;
  setupChat(
    [{ id, role: 'user', parts: [{ type: 'text', text: 'Question?' }] }, assistant],
    { send: sendMessage },
  );
  view.rerender(<ChatInterface conversationId="conv-test" />);
  const chatOptions = useChatMock.mock.calls.at(-1)![0] as { onFinish: OnFinish };
  act(() =>
    chatOptions.onFinish({
      message: assistant,
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: false,
    }),
  );
  return { turnId, view };
}

const ASSISTANT_WITH_CITATIONS: Msg = {
  id: 'a1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Answer.' },
    {
      type: 'data-citation',
      data: { id: 11, documentId: 7, similarity: 0.9, snippet: 'First chunk.' },
    },
    {
      type: 'data-citation',
      data: { id: 12, documentId: 7, similarity: 0.8, snippet: 'Second chunk.' },
    },
  ],
};

describe('ChatInterface', () => {
  it('renders a welcome intro when there are no messages', () => {
    setupChat();
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.getByText(/Answers grounded in your docs/i)).toBeInTheDocument();
    expect(
      screen.getByText(/answer from the official documentation/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByTestId('chat-quick-prompt').length,
    ).toBeGreaterThan(0);
  });

  it('shows a fallback bubble with Retry when an assistant turn ends empty (§T7)', () => {
    useChatMock.mockReturnValue({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'help' }] },
        { id: 'a1', role: 'assistant', parts: [] },
      ],
      sendMessage: vi.fn(),
      status: 'ready',
      error: undefined,
      stop: vi.fn(),
    });
    render(<ChatInterface conversationId="conv-test" />);
    const bubble = screen.getByTestId('chat-empty-fallback');
    expect(bubble).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show the empty-fallback bubble when the answer has visible content', () => {
    useChatMock.mockReturnValue({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'help' }] },
        ASSISTANT_WITH_CITATIONS,
      ],
      sendMessage: vi.fn(),
      status: 'ready',
      error: undefined,
      stop: vi.fn(),
    });
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.queryByTestId('chat-empty-fallback')).not.toBeInTheDocument();
  });

  it('shows status stages while the assistant is generating with no text yet', () => {
    useChatMock.mockReturnValue({
      messages: [],
      sendMessage: vi.fn(),
      status: 'submitted',
      error: undefined,
      stop: vi.fn(),
    });
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.getByTestId('chat-thinking')).toBeInTheDocument();
    expect(screen.getByText('Searching from the sources')).toBeInTheDocument();
  });

  it('renders citation cards for data-citation parts', () => {
    setupChat([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'According to the policy…' },
          {
            type: 'data-citation',
            data: { similarity: 0.92, snippet: 'The dental plan covers two cleanings per year.' },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const citation = screen.getByTestId('chat-citation');
    expect(citation).toBeInTheDocument();
    expect(within(citation).getByText(/92% match/i)).toBeInTheDocument();
    expect(
      within(citation).getByText(/dental plan covers two cleanings/i),
    ).toBeInTheDocument();
  });

  it('renders provenance metadata on citation cards when present', () => {
    setupChat([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-citation',
            data: {
              similarity: 0.92,
              snippet: 'Two cleanings per year are covered.',
              fileName: 'employee-benefits.pdf',
              page: 5,
              sectionTitle: 'Dental Coverage',
              source: 'https://blob.example.com/employee-benefits.pdf',
            },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const citation = screen.getByTestId('chat-citation');
    expect(within(citation).getByTestId('chat-citation-file')).toHaveTextContent(
      'employee-benefits.pdf — p.5',
    );
    expect(
      within(citation).getByTestId('chat-citation-section'),
    ).toHaveTextContent('§ Dental Coverage');
    expect(citation.textContent).not.toContain('blob.example.com');
  });

  it('omits the page suffix when page is absent', () => {
    setupChat([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-citation',
            data: {
              similarity: 0.8,
              snippet: 'Snippet.',
              fileName: 'handbook.md',
              page: null,
              sectionTitle: null,
            },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const citation = screen.getByTestId('chat-citation');
    expect(within(citation).getByTestId('chat-citation-file')).toHaveTextContent(
      /^handbook\.md$/,
    );
    expect(
      within(citation).queryByTestId('chat-citation-section'),
    ).not.toBeInTheDocument();
  });

  it('hides the section title when it matches the file name', () => {
    setupChat([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-citation',
            data: {
              similarity: 0.7,
              snippet: 'Snippet.',
              fileName: 'policy.pdf',
              sectionTitle: 'policy.pdf',
            },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    expect(
      screen.queryByTestId('chat-citation-section'),
    ).not.toBeInTheDocument();
  });

  it('renders citations without provenance fields gracefully', () => {
    setupChat([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-citation',
            data: { similarity: 0.65, snippet: 'Legacy citation snippet.' },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const citation = screen.getByTestId('chat-citation');
    expect(
      within(citation).queryByTestId('chat-citation-file'),
    ).not.toBeInTheDocument();
    expect(
      within(citation).getByText(/legacy citation snippet/i),
    ).toBeInTheDocument();
  });

  it('renders text parts in the conversation', () => {
    setupChat([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello!' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi there.' }] },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there.')).toBeInTheDocument();
  });

  it('renders a soft notice banner without a ticket offer for noticed turns', () => {
    setupChat([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Best-effort answer.' },
          {
            type: 'data-guardrail',
            data: {
              outOfDomain: false,
              notice: true,
              isEmpty: false,
              offerTicket: false,
              message: 'Based on best-effort matches (4) — may be incomplete. Please verify.',
            },
          },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const banner = screen.getByTestId('chat-guardrail-notice');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain(
      'Based on best-effort matches (4) — may be incomplete. Please verify.',
    );
    expect(screen.queryByTestId('chat-guardrail-wall')).not.toBeInTheDocument();
    expect(banner.textContent).not.toMatch(/ticket/i);
  });

  it('shows the Notice title on the soft banner even without a message', () => {
    setupChat([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Answer.' },
          { type: 'data-guardrail', data: { outOfDomain: false, offerTicket: false, notice: true, isEmpty: false } },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const banner = screen.getByTestId('chat-guardrail-notice');
    expect(within(banner).getByText('Notice')).toBeInTheDocument();
  });

  it('renders the red blocking wall with a ticket offer for out-of-domain turns', () => {
    setupChat([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'I could not find this.' },
          { type: 'data-guardrail', data: { outOfDomain: true, offerTicket: true } },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    const wall = screen.getByTestId('chat-guardrail-wall');
    expect(wall).toBeInTheDocument();
    expect(wall.textContent).toMatch(/knowledge ticket/i);
    expect(screen.queryByTestId('chat-guardrail-notice')).not.toBeInTheDocument();
  });

  it('collapses stacked notice + wall guardrail parts into a single wall banner', () => {
    setupChat([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Answer with two guardrails.' },
          {
            type: 'data-guardrail',
            data: {
              outOfDomain: false,
              offerTicket: false,
              notice: true,
              isEmpty: false,
              message: 'Based on best-effort matches (4) — may be incomplete. Please verify.',
            },
          },
          { type: 'data-guardrail', data: { outOfDomain: false, offerTicket: true } },
        ],
      },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.getAllByTestId('chat-guardrail-wall')).toHaveLength(1);
    expect(screen.queryByTestId('chat-guardrail-notice')).not.toBeInTheDocument();
  });

  it('sends a message when the form is submitted', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-test" />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'What is the dental plan?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        {
          parts: [{ type: 'text', text: 'What is the dental plan?' }],
          id: expect.any(String),
          role: 'user',
        },
        {
          body: {
            turnId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            ),
            conversationId: 'conv-test',
          },
        },
      ),
    );
    expect(sendMessage.mock.calls[0]![0]).not.toHaveProperty('messageId');
    expect((input).value).toBe('');
  });

  it('sends a message when Enter is pressed in the composer', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-test" />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Enter question?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const call = sendMessage.mock.calls[0]![0] as {
      parts: Array<{ type: 'text'; text: string }>;
    };
    expect(call.parts[0]?.text).toBe('Enter question?');
  });

  it('sends a quick prompt when clicked', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-test" />);
    fireEvent.click(screen.getAllByTestId('chat-quick-prompt')[0]!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const call = sendMessage.mock.calls[0]![0] as {
      parts: Array<{ type: 'text'; text: string }>;
    };
    expect(call.parts[0]?.text).toBe('How do I change my password?');
  });

  it('shows a toast and unlocks the composer when sending fails', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-test" />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'First attempt?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Second attempt?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });

  it('falls back to a non-crypto id generator in insecure contexts', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    vi.stubGlobal('crypto', {});
    render(<ChatInterface conversationId="conv-test" />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Insecure question?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const call = sendMessage.mock.calls[0]![0] as { id: string };
    expect(call.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('stops generation when the stop button is clicked while streaming', async () => {
    const stop = vi.fn();
    useChatMock.mockReturnValue({
      messages: [],
      sendMessage: vi.fn(),
      status: 'streaming',
      error: undefined,
      stop,
    });
    render(<ChatInterface conversationId="conv-test" />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'q' } });
    expect(input).toBeDisabled();
    const button = screen.getByTestId('chat-send');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-label', 'Stop generating');
    fireEvent.click(button);
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('does not render a feedback control for assistant messages without a bound turn', () => {
    setupChat([
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi.' }] },
    ]);
    render(<ChatInterface conversationId="conv-test" />);
    expect(screen.queryByTestId('chat-feedback')).not.toBeInTheDocument();
  });

  it('posts feedback with deduplicated document and chunk ids from citations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const { turnId } = await renderWithBoundTurn(ASSISTANT_WITH_CITATIONS);

    const control = screen.getByTestId('chat-feedback');
    expect(control).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-feedback-up'));

    expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnId,
          feedback: 1,
          documentIds: [7],
          chunkIds: [11, 12],
        }),
      }),
    );
    expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-feedback-down')).toHaveAttribute('aria-pressed', 'false');
  });

  it('omits documentIds and chunkIds when the message has no citations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const { turnId } = await renderWithBoundTurn({
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Answer without sources.' }],
    });

    fireEvent.click(screen.getByTestId('chat-feedback-down'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/feedback',
        expect.objectContaining({ body: JSON.stringify({ turnId, feedback: -1 }) }),
      ),
    );
  });

  it('re-posts when the vote changes to the other thumb', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const { turnId } = await renderWithBoundTurn(ASSISTANT_WITH_CITATIONS);

    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('chat-feedback-down'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    ) as { turnId: string; feedback: number };
    expect(secondBody.turnId).toBe(turnId);
    expect(secondBody.feedback).toBe(-1);
    expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('chat-feedback-down')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not re-post when the same thumb is clicked twice', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await renderWithBoundTurn(ASSISTANT_WITH_CITATIONS);

    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reverts the optimistic vote and shows a toast on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    await renderWithBoundTurn(ASSISTANT_WITH_CITATIONS);

    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() =>
      expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it('retries once after a 404 before succeeding', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await renderWithBoundTurn(ASSISTANT_WITH_CITATIONS);

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('chat-feedback-up')).toHaveAttribute('aria-pressed', 'true');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('binds each turn to its own user message even when a failed stream finishes late', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    const view = render(<ChatInterface conversationId="conv-test" />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'A?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const callA = sendMessage.mock.calls[0]!;
    const msgA = (callA[0] as { id: string }).id;
    const turnA = (callA[1] as { body: { turnId: string } }).body.turnId;

    setupChat(
      [{ id: msgA, role: 'user', parts: [{ type: 'text', text: 'A?' }] }],
      { send: sendMessage, status: 'error' },
    );
    view.rerender(<ChatInterface conversationId="conv-test" />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'B?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    const callB = sendMessage.mock.calls[1]!;
    const msgB = (callB[0] as { id: string }).id;
    const turnB = (callB[1] as { body: { turnId: string } }).body.turnId;

    const assistantB: Msg = {
      id: 'a-b',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Answer B.' }],
    };
    setupChat(
      [
        { id: msgA, role: 'user', parts: [{ type: 'text', text: 'A?' }] },
        { id: msgB, role: 'user', parts: [{ type: 'text', text: 'B?' }] },
        assistantB,
      ],
      { send: sendMessage },
    );
    view.rerender(<ChatInterface conversationId="conv-test" />);
    const chatOptions = useChatMock.mock.calls.at(-1)![0] as { onFinish: OnFinish };

    act(() =>
      chatOptions.onFinish({
        message: assistantB,
        messages: [],
        isAbort: false,
        isDisconnect: false,
        isError: false,
      }),
    );
    act(() =>
      chatOptions.onFinish({
        message: { id: 'a-a', role: 'assistant', parts: [{ type: 'text', text: 'partial A' }] } as Msg,
        messages: [],
        isAbort: false,
        isDisconnect: false,
        isError: true,
      }),
    );

    fireEvent.click(screen.getByTestId('chat-feedback-up'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    ) as { turnId: string };
    expect(body.turnId).toBe(turnB);
    expect(body.turnId).not.toBe(turnA);
  });

  it('renders the messages container as the vertically scrollable region of the chat frame', () => {
    setupChat();
    render(<ChatInterface conversationId="conv-test" />);
    const container = screen.getByTestId('chat-scroll');
    const cls = container.className;
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-h-0');
    expect(cls).toContain('overflow-y-auto');
  });
});

describe('ChatInterface history integration', () => {
  it('syncs a fresh conversation only after the server confirms persistence', async () => {
    const sendMessage = vi.fn();
    const onConversationPersisted = vi.fn();
    setupChat([], { send: sendMessage });
    const view = render(
      <ChatInterface conversationId="conv-fresh" onConversationPersisted={onConversationPersisted} />,
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const userMessage = sendMessage.mock.calls[0]![0] as Msg;
    const assistant: Msg = {
      id: 'assistant-fresh',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'answer' },
        { type: 'data-conversation-persisted', data: { conversationId: 'conv-fresh' } },
      ],
    };
    setupChat([userMessage, assistant], { send: sendMessage });
    view.rerender(
      <ChatInterface conversationId="conv-fresh" onConversationPersisted={onConversationPersisted} />,
    );
    const options = useChatMock.mock.calls.at(-1)![0] as { onFinish: OnFinish };
    act(() =>
      options.onFinish({
        message: assistant,
        messages: [userMessage],
        isAbort: false,
        isDisconnect: false,
        isError: false,
      }),
    );
    expect(onConversationPersisted).toHaveBeenCalledTimes(1);
  });

  it('sends the conversation id with every message', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-abc" />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const body = (sendMessage.mock.calls[0]![1] as { body: { conversationId: string } }).body;
    expect(body.conversationId).toBe('conv-abc');
  });

  it('seeds the chat hook with the conversation id and resumed messages', () => {
    const initialMessages: Msg[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'question' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'answer' },
          {
            type: 'data-citation',
            data: { id: 3, documentId: 1, similarity: 0.9, snippet: 'snap', fileName: 'f.pdf' },
          },
        ],
      },
    ];
    setupChat(initialMessages, {});
    render(
      <ChatInterface
        conversationId="conv-resumed"
        initialMessages={initialMessages}
        initialTurnIds={{ a1: 'turn-9' }}
      />,
    );
    const options = useChatMock.mock.calls[0]![0] as { id?: string; messages?: Msg[] };
    expect(options.id).toBe('conv-resumed');
    expect(options.messages).toEqual(initialMessages);
    expect(screen.getByTestId('chat-message-user')).toBeInTheDocument();
    expect(screen.getByTestId('chat-citation')).toBeInTheDocument();
    expect(screen.getByTestId('chat-feedback-up')).toBeInTheDocument();
  });

  it('shows a truncation notice only when the resumed chat is truncated', () => {
    const initialMessages: Msg[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
    ];
    setupChat(initialMessages, {});
    const view = render(
      <ChatInterface conversationId="conv-trunc" initialMessages={initialMessages} truncated />,
    );
    expect(screen.getByTestId('chat-truncated-notice')).toHaveTextContent(
      'Showing the last 200 messages of this chat',
    );
    view.rerender(
      <ChatInterface conversationId="conv-trunc" initialMessages={initialMessages} />,
    );
    expect(screen.queryByTestId('chat-truncated-notice')).not.toBeInTheDocument();
  });

  it('disables the composer when the message cap is reached', () => {
    setupChat([], {});
    render(<ChatInterface conversationId="conv-test" initialMessageCount={500} />);
    expect(screen.getByTestId('chat-cap-message')).toBeInTheDocument();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('blocks submits with the cap message when the conversation limit is reached', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface conversationId="conv-limited" conversationLimitReached />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You've reached the maximum of 512 chats — delete older ones to start a new one.",
      ),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retry sends a fresh turn id with retry and the conversation id', async () => {
    const sendMessage = vi.fn(async (...args: unknown[]) => {
      void args;
    });
    useChatMock.mockReturnValue({
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'oops' }] },
      ],
      sendMessage,
      status: 'error',
      error: new Error('stream failed'),
      stop: vi.fn(),
    });
    render(<ChatInterface conversationId="conv-retry" />);
    fireEvent.click(screen.getByTestId('chat-retry'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const call = sendMessage.mock.calls[0]!;
    expect(call[0]).toBeUndefined();
    const body = (call[1] as { body: Record<string, unknown> }).body;
    expect(body.retry).toBe(true);
    expect(body.conversationId).toBe('conv-retry');
  });

  it('keeps the message count stable when a retried turn finishes', async () => {
    const initialMessages: Msg[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
    ];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useChatMock.mockReturnValue({
      messages: initialMessages,
      sendMessage,
      status: 'error',
      error: new Error('stream failed'),
      stop: vi.fn(),
    });
    const view = render(
      <ChatInterface conversationId="conv-count" initialMessages={initialMessages} initialMessageCount={498} />,
    );
    fireEvent.click(screen.getByTestId('chat-retry'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const chatOptions = useChatMock.mock.calls.at(-1)![0] as { onFinish: OnFinish };
    const retried: Msg = { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'retry answer' }] };
    setupChat([...initialMessages, retried], { send: sendMessage });
    view.rerender(
      <ChatInterface conversationId="conv-count" initialMessages={initialMessages} initialMessageCount={498} />,
    );
    act(() =>
      chatOptions.onFinish({
        message: retried,
        messages: [],
        isAbort: false,
        isDisconnect: false,
        isError: false,
      }),
    );
    expect(screen.queryByTestId('chat-cap-message')).not.toBeInTheDocument();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('still increments the message count by two on a normal finish', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    const view = render(<ChatInterface conversationId="conv-count" initialMessageCount={498} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Question?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const { id } = sendMessage.mock.calls[0]![0] as { id: string };
    const assistant: Msg = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] };
    setupChat(
      [{ id, role: 'user', parts: [{ type: 'text', text: 'Question?' }] }, assistant],
      { send: sendMessage },
    );
    view.rerender(<ChatInterface conversationId="conv-count" initialMessageCount={498} />);
    const chatOptions = useChatMock.mock.calls.at(-1)![0] as { onFinish: OnFinish };
    act(() =>
      chatOptions.onFinish({
        message: assistant,
        messages: [],
        isAbort: false,
        isDisconnect: false,
        isError: false,
      }),
    );
    expect(screen.getByTestId('chat-cap-message')).toBeInTheDocument();
  });
});
