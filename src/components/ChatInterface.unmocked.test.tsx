import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { ChatInterface } from './ChatInterface';

type Msg = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

const SEED: Msg[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What is covered?' }] }];

function sseResponse() {
  const chunks = [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Grounded smoke answer' },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatInterface with the real useChat hook', () => {
  it('seeds initial messages through the real hook', () => {
    render(<ChatInterface conversationId="conv-smoke" initialMessages={SEED} />);
    expect(screen.getByTestId('chat-message-user')).toHaveTextContent('What is covered?');
    expect(screen.getByTestId('chat-input')).toBeEnabled();
  });

  it('posts through DefaultChatTransport and renders the streamed answer', async () => {
    render(<ChatInterface conversationId="conv-smoke" />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'What is the dental plan?' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByText(/Grounded smoke answer/)).toBeInTheDocument());

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect(init).toMatchObject({ method: 'POST' });
    const body = JSON.parse((init as { body: string }).body) as {
      id: string;
      turnId: string;
      conversationId: string;
      messages: Msg[];
    };
    expect(body.id).toBe('conv-smoke');
    expect(body.conversationId).toBe('conv-smoke');
    expect(body.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(
      body.messages.some((m) => m.parts.some((p) => p.text === 'What is the dental plan?')),
    ).toBe(true);

    expect(screen.queryByTestId('chat-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeEnabled();
  });
});
