'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/sonner';
import { onConversationsChanged, requestNewChat } from '@/chat/events';
import { MAX_LIST_LIMIT } from '@app/domain';
import { parseConversationId } from './utils';
import { SidebarBody } from './SidebarBody';
import { MobileSidebar } from './MobileSidebar';
import type { AppSidebarUser, AppRole, ConversationItem } from './types';

export function AppSidebar({
  user,
  role,
  open = true,
  onToggle,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  open?: boolean;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const onAdmin = pathname?.startsWith('/admin') ?? false;
  const [freshActiveId, setFreshActiveId] = useState<string | null>(null);
  const activeConversationId =
    parseConversationId(pathname) ?? (pathname === '/chat' ? freshActiveId : null);

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [totalConversations, setTotalConversations] = useState(0);
  const [pages, setPages] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    if (onAdmin) return;
    const seq = ++fetchSeq.current;
    void (async () => {
      const accumulated: ConversationItem[] = [];
      let total = 0;
      for (let page = 0; page < pages; page += 1) {
        try {
          const res = await fetch(
            `/api/chat/conversations?limit=${MAX_LIST_LIMIT}&offset=${page * MAX_LIST_LIMIT}`,
          );
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as { conversations: ConversationItem[]; total: number };
          if (fetchSeq.current !== seq) return;
          total = Number(data.total ?? 0);
          const rows = data.conversations ?? [];
          accumulated.push(...rows);
          if (rows.length < MAX_LIST_LIMIT) break;
        } catch {
          toast.error('Could not load your chats. Please try again.');
          return;
        }
      }
      if (fetchSeq.current === seq) {
        setConversations(accumulated);
        setTotalConversations(total);
      }
    })();
  }, [pages, refreshKey, onAdmin]);

  const refreshConversations = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    return onConversationsChanged((activeId) => {
      setFreshActiveId(activeId ?? null);
      refreshConversations();
    });
  }, [refreshConversations]);

  const commitRename = async (id: string) => {
    setRenamingId(null);
    const title = renameValue.trim();
    if (!title) return;
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
    } catch {
      toast.error('Could not rename the chat. Please try again.');
    }
  };

  const handleNewChat = useCallback(() => {
    setFreshActiveId(null);
    requestNewChat();
  }, []);

  const confirmDelete = async () => {
    const id = deletingId;
    if (!id) return;
    setDeletingId(null);
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeConversationId) router.push('/chat');
    } catch {
      toast.error('Could not delete the chat. Please try again.');
    }
  };

  const sidebarBody = (closeDrawer: () => void, onSidebarToggle?: () => void) => (
    <SidebarBody
      user={user}
      role={role}
      section={onAdmin ? 'admin' : 'chat'}
      conversations={conversations}
      hasMore={conversations.length < totalConversations}
      onShowMore={() => setPages((count) => count + 1)}
      onNewChat={handleNewChat}
      activeConversationId={activeConversationId}
      renamingId={renamingId}
      renameValue={renameValue}
      setRenameValue={setRenameValue}
      onRenameStart={(id, current) => {
        setRenamingId(id);
        setRenameValue(current);
      }}
      onRenameCommit={commitRename}
      onRenameCancel={() => setRenamingId(null)}
      onDeleteAsk={setDeletingId}
      onNavigate={closeDrawer}
      {...(onSidebarToggle ? { onSidebarToggle } : {})}
    />
  );

  return (
    <>
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden flex-col overflow-hidden border-r border-border-subtle bg-card/60 backdrop-blur-md transition-[width] duration-200 md:flex',
          open ? 'w-72' : 'w-0 border-r-0',
        )}
        inert={!open}
        data-testid="app-sidebar"
        data-open={open}
      >
        <div className="flex h-full w-72 flex-col">{sidebarBody(() => undefined, onToggle)}</div>
      </aside>

      <MobileSidebar>{sidebarBody}</MobileSidebar>

      <Dialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <DialogContent className="max-w-sm rounded-xl border-border-subtle bg-card p-5 shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-base text-foreground">Delete chat?</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              This will permanently remove the conversation and its messages.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDeletingId(null)}
              data-testid="conversation-delete-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void confirmDelete()}
              data-testid="conversation-confirm-delete"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
