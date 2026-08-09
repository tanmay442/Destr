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
  const view = render(<ChatInterface />);
  fireEvent.change(screen.getByTestId('chat-input'), {
    target: { value: 'Question?' },
  });
  fireEvent.click(screen.getByTestId('chat-send'));
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  const options = sendMessage.mock.calls[0]![1] as { body: { turnId: string } };
  const turnId = options.body.turnId;
  setupChat(
    [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Question?' }] }, assistant],
    { send: sendMessage },
  );
  view.rerender(<ChatInterface />);
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
    render(<ChatInterface />);
    expect(screen.getByText(/Answers grounded in your docs/i)).toBeInTheDocument();
    expect(
      screen.getByText(/answer from the official documentation/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByTestId('chat-quick-prompt').length,
    ).toBeGreaterThan(0);
  });

  it('shows status stages while the assistant is generating with no text yet', () => {
    useChatMock.mockReturnValue({
      messages: [],
      sendMessage: vi.fn(),
      status: 'submitted',
      error: undefined,
      stop: vi.fn(),
    });
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there.')).toBeInTheDocument();
  });

  it('sends a message when the form is submitted', async () => {
    const sendMessage = vi.fn();
    setupChat([], { send: sendMessage });
    render(<ChatInterface />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'What is the dental plan?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        { text: 'What is the dental plan?' },
        {
          body: {
            turnId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            ),
          },
        },
      ),
    );
    expect((input).value).toBe('');
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
    render(<ChatInterface />);
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
    render(<ChatInterface />);
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

  it('renders the messages container as the vertically scrollable region of the chat frame', () => {
    setupChat();
    render(<ChatInterface />);
    const container = screen.getByTestId('chat-scroll');
    const cls = container.className;
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-h-0');
    expect(cls).toContain('overflow-y-auto');
  });
});
