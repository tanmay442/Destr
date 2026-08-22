import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => activePath,
}));

vi.mock('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock('@/components/icons/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand" />,
}));

let activePath = '/chat';
let deleteOk = true;

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: { method?: string }) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      return { ok: true, status: 200 } as Response;
    }
    if (init?.method === 'DELETE') {
      return (deleteOk ? { ok: true, status: 200 } : { ok: false, status: 500 }) as Response;
    }
    if (url.includes('/api/chat/conversations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversations: [
            {
              id: 'a0000000-0000-4000-8000-000000000001',
              title: 'Dental plan',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      } as Response;
    }
    return { ok: true, status: 200 } as Response;
  });
}

import { AppSidebar } from './AppSidebar';

const user = { name: 'Tester', imageUrl: null, email: 't@x.com' };

beforeEach(() => {
  activePath = '/chat/a0000000-0000-4000-8000-000000000001';
  deleteOk = true;
  pushMock.mockClear();
  vi.stubGlobal('fetch', mockFetch());
});

describe('AppSidebar conversation nav', () => {
  it('renders grouped conversations with the active one highlighted', async () => {
    render(<AppSidebar user={user} role="admin" />);
    await waitFor(() => expect(screen.getByTestId('conversation-item')).toBeInTheDocument());
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.queryByText('All chats')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-item').closest('[data-active="true"]')).not.toBeNull();
    expect(screen.getByTestId('app-sidebar-admin-panel')).toHaveTextContent('Admin panel');
  });

  it('renames inline through the options menu', async () => {
    render(<AppSidebar user={user} role="user" />);
    await waitFor(() => expect(screen.getByTestId('conversation-item')).toBeInTheDocument());

    // Radix menus open on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId('conversation-options'), { button: 0 });
    fireEvent.click(await screen.findByTestId('conversation-rename'));
    const input = await screen.findByTestId('conversation-rename-input');
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(
        globalThis.fetch,
      ).toHaveBeenCalledWith(
        '/api/chat/conversations/a0000000-0000-4000-8000-000000000001',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect(await screen.findByText('New title')).toBeInTheDocument();
  });

  it('confirms deletion, drops the entry and navigates home when active', async () => {
    render(<AppSidebar user={user} role="user" />);
    await waitFor(() => expect(screen.getByTestId('conversation-item')).toBeInTheDocument());

    // Radix menus open on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId('conversation-options'), { button: 0 });
    fireEvent.click(await screen.findByTestId('conversation-delete'));
    fireEvent.click(await screen.findByTestId('conversation-confirm-delete'));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/chat'));
    expect(screen.queryByTestId('conversation-item')).not.toBeInTheDocument();
  });

  it('keeps the entry when deletion fails', async () => {
    deleteOk = false;
    render(<AppSidebar user={user} role="user" />);
    await waitFor(() => expect(screen.getByTestId('conversation-item')).toBeInTheDocument());

    // Radix menus open on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId('conversation-options'), { button: 0 });
    fireEvent.click(await screen.findByTestId('conversation-delete'));
    fireEvent.click(await screen.findByTestId('conversation-confirm-delete'));

    await waitFor(() =>
      expect(
        globalThis.fetch,
      ).toHaveBeenCalledWith(
        '/api/chat/conversations/a0000000-0000-4000-8000-000000000001',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('conversation-item')).toBeInTheDocument();
  });

  it('loads all pages through Show more when more conversations exist', async () => {
    const pageRows = (page: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `c${page}-${i}`,
        title: `Chat ${page}-${i}`,
        updatedAt: new Date().toISOString(),
      }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('offset=100')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ conversations: pageRows(1, 5), total: 105 }),
        } as Response;
      }
      if (url.includes('/api/chat/conversations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ conversations: pageRows(0, 100), total: 105 }),
        } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AppSidebar user={user} role="user" />);
    await waitFor(() => expect(screen.getByTestId('conversation-show-more')).toBeInTheDocument());
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(100);

    fireEvent.click(screen.getByTestId('conversation-show-more'));
    await waitFor(() => expect(screen.getAllByTestId('conversation-item')).toHaveLength(105));
    expect(screen.queryByTestId('conversation-show-more')).not.toBeInTheDocument();
  });

  it('shows admin nav on admin routes with the pinned admin panel link', () => {
    activePath = '/admin/settings';
    render(<AppSidebar user={user} role="admin" />);
    expect(screen.getByTestId('app-sidebar-admin-list')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar-admin-panel')).toHaveTextContent('Chat');
    expect(screen.getByTestId('app-sidebar-sign-out')).toBeInTheDocument();
  });
});
