import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';
import { ConversationList } from './ConversationList';

const CONVERSATIONS = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    title: 'Dental plan',
    messageCount: 4,
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    title: 'VPN setup',
    messageCount: 2,
    updatedAt: '2026-08-02T10:00:00.000Z',
  },
];

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: { method?: string }) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      const res = overrides.deleteOk === false ? { ok: false, status: 500 } : { ok: true, status: 200 };
      return res as Response;
    }
    if (url.includes('/api/chat/conversations')) {
      return { ok: true, status: 200, json: async () => ({ conversations: CONVERSATIONS }) } as Response;
    }
    return { ok: true, status: 200 } as Response;
  });
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});

describe('ConversationList', () => {
  it('fetches and renders conversations with the active one highlighted', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<ConversationList activeId={CONVERSATIONS[1]!.id} refreshKey={0} onSelect={() => {}} onNew={() => {}} onDeleted={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(2));
    const items = screen.getAllByTestId('conversation-item');
    expect(items[0]).toHaveTextContent('Dental plan');
    expect(screen.getByText('VPN setup').closest('span')).toHaveClass('border-primary/50');
  });

  it('shows a toast when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    render(<ConversationList activeId={null} refreshKey={0} onSelect={() => {}} onNew={() => {}} onDeleted={() => {}} />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your chats.'));
  });

  it('selects a conversation on click', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onSelect = vi.fn();
    render(<ConversationList activeId={null} refreshKey={0} onSelect={onSelect} onNew={() => {}} onDeleted={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(2));
    fireEvent.click(screen.getByText('VPN setup'));
    expect(onSelect).toHaveBeenCalledWith('b0000000-0000-4000-8000-000000000002');
  });

  it('starts a new chat via the New chat button', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onNew = vi.fn();
    render(<ConversationList activeId={null} refreshKey={0} onSelect={() => {}} onNew={onNew} onDeleted={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('conversation-new'));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation and then deletes a conversation', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onDeleted = vi.fn();
    render(<ConversationList activeId={null} refreshKey={0} onSelect={() => {}} onNew={() => {}} onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId('conversation-delete')[0]!);
    expect(screen.getByTestId('conversation-confirm-delete')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('conversation-confirm-delete'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('a0000000-0000-4000-8000-000000000001'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/a0000000-0000-4000-8000-000000000001',
      { method: 'DELETE' },
    );
  });

  it('toasts when deletion fails and keeps the entry', async () => {
    vi.stubGlobal('fetch', mockFetch({ deleteOk: false }));
    const onDeleted = vi.fn();
    render(<ConversationList activeId={null} refreshKey={0} onSelect={() => {}} onNew={() => {}} onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('conversation-delete')[0]!);
    fireEvent.click(screen.getByTestId('conversation-confirm-delete'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not delete this chat.'));
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
