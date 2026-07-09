import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Mock useChat to drive messages from the test.
const useChatMock = vi.fn();
vi.mock('@ai-sdk/react', () => ({
  useChat: (...args: unknown[]) => useChatMock(...args),
}));

// No-op class mock; real impl not needed.
vi.mock('ai', () => ({
  DefaultChatTransport: class {
    constructor() {}
  },
}));

import { ChatInterface } from './ChatInterface';

type Msg = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'data-citation'; data: { similarity: number; snippet: string } }
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
});

describe('ChatInterface', () => {
  it('renders a welcome intro when there are no messages', () => {
    setupChat();
    render(<ChatInterface />);
    // Assert inside intro's testid to avoid colliding with the quick-prompt "open a ticket" copy.
    const intro = screen.getByTestId('chat-intro');
    expect(intro).toBeInTheDocument();
    expect(
      within(intro).getByText(/support assistant/i),
    ).toBeInTheDocument();
    expect(
      within(intro).getByText(/file a support ticket/i),
    ).toBeInTheDocument();
    expect(
      within(intro).getAllByTestId('chat-quick-prompt').length,
    ).toBeGreaterThan(0);
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
    // Similarity rendered as a percentage match.
    expect(within(citation).getByText(/92% match/i)).toBeInTheDocument();
    expect(
      within(citation).getByText(/dental plan covers two cleanings/i),
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
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ text: 'What is the dental plan?' }));
    expect((input).value).toBe('');
  });

  it('disables the send button while streaming', () => {
    setupChat([], { status: 'streaming' });
    render(<ChatInterface />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'q' } });
    expect(input).toBeDisabled();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('renders the messages container as the vertically scrollable region of the chat frame', () => {
    setupChat();
    render(<ChatInterface />);
    // flex-1 + min-h-0 give the flex column height; assert on className (jsdom no layout).
    const container = screen.getByTestId('chat-messages');
    const cls = container.className;
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-h-0');
    expect(cls).toContain('overflow-y-auto');
  });
});
