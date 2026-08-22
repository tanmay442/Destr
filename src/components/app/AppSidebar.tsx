'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import {
  MessageSquare,
  LayoutDashboard,
  FileText,
  Inbox,
  Users,
  BarChart3,
  ScrollText,
  Settings,
  Menu,
  X,
  LogOut,
  SquarePen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { BrandMark } from '@/components/icons/BrandMark';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetOverlay,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { onConversationsChanged } from '@/chat/events';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/documents', label: 'Documents', icon: FileText },
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
] as const;

export type AppRole = 'admin' | 'user';

export interface AppSidebarUser {
  name: string;
  imageUrl: string | null;
  email?: string;
}

interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
}

const RECENT_COUNT = 3;

/** UI-only split: the three most recently active chats, then everything else. */
function sectionConversations(items: ConversationItem[]): Array<{ label: string; items: ConversationItem[] }> {
  const sections: Array<{ label: string; items: ConversationItem[] }> = [];
  const recent = items.slice(0, RECENT_COUNT);
  const rest = items.slice(RECENT_COUNT);
  if (recent.length > 0) sections.push({ label: 'Recent', items: recent });
  if (rest.length > 0) sections.push({ label: 'All chats', items: rest });
  return sections;
}

function parseConversationId(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = /^\/chat\/([0-9a-fA-F-]{36})$/.exec(pathname);
  return match ? match[1]! : null;
}

export function AppSidebar({
  user,
  role,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const onAdmin = pathname?.startsWith('/admin') ?? false;
  const activeConversationId = parseConversationId(pathname);

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refreshConversations = useCallback(() => {
    const seq = ++fetchSeq.current;
    fetch('/api/chat/conversations?limit=100')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { conversations: ConversationItem[] };
      })
      .then((data) => {
        if (fetchSeq.current === seq) setConversations(data.conversations ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshConversations();
    return onConversationsChanged(refreshConversations);
  }, [refreshConversations]);

  // Re-check the list when landing back on chat surfaces (e.g. turns that
  // completed while visiting admin pages dispatched events we already caught,
  // but a manual refresh keeps this robust without extra subscriptions).
  useEffect(() => {
    if (!onAdmin) refreshConversations();
  }, [onAdmin, refreshConversations]);

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
      // Leave the previous title in place; the next refresh reconciles.
    }
  };

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
      // Keep the entry; the next refresh reconciles.
    }
  };

  const sidebarBody = (closeDrawer: () => void) => (
    <SidebarBody
      user={user}
      role={role}
      section={onAdmin ? 'admin' : 'chat'}
      conversations={conversations}
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
    />
  );

  return (
    <>
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-border-subtle bg-card/60 backdrop-blur-md md:flex"
        data-testid="app-sidebar"
      >
        {sidebarBody(() => undefined)}
      </aside>

      {/* Mobile drawer */}
      <MobileSidebar>{sidebarBody}</MobileSidebar>

      {/* Delete confirmation */}
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

function MobileSidebar({
  children,
}: {
  children: (close: () => void) => React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const close = useCallback(() => setMobileOpen(false), []);

  return (
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border-subtle bg-background/85 px-4 backdrop-blur-md md:hidden"
        data-testid="app-mobile-topbar"
      >
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
          data-testid="app-mobile-brand"
        >
          <BrandMark size="sm" />
          <span>Destr</span>
        </Link>

        <SheetTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Open navigation"
            className="rounded-lg bg-card/90 shadow-sm hover:bg-surface-elevated"
            data-testid="app-mobile-hamburger"
          >
            <Menu aria-hidden />
          </Button>
        </SheetTrigger>
      </header>

      <SheetOverlay className="bg-black/60 backdrop-blur-sm md:hidden" />
      <SheetContent
          side="left"
          showCloseButton={false}
          className="fixed inset-y-0 left-0 z-50 flex h-full w-80 max-w-[85vw] flex-col gap-0 border-r border-border-subtle bg-card p-0 shadow-2xl outline-none data-[state=closed]:duration-300 data-[state=open]:duration-500 md:hidden"
          data-testid="app-mobile-drawer"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Primary navigation menu</SheetDescription>
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <Link
              href="/chat"
              onClick={() => setMobileOpen(false)}
              className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
            >
              <BrandMark size="sm" />
              <span>Destr</span>
            </Link>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <X aria-hidden />
              </Button>
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children(close)}</div>
        </SheetContent>
    </Sheet>
  );
}

type SidebarSection = 'chat' | 'admin';

function SidebarBody({
  user,
  role,
  section,
  conversations,
  activeConversationId,
  renamingId,
  renameValue,
  setRenameValue,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDeleteAsk,
  onNavigate,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  section: SidebarSection;
  conversations: ConversationItem[];
  activeConversationId: string | null;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  onRenameStart: (id: string, currentTitle: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  onDeleteAsk: (id: string) => void;
  onNavigate: () => void;
}) {
  const { signOut } = useClerk();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hidden h-14 shrink-0 items-center justify-between border-b border-border-subtle px-4 md:flex">
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
          data-testid="app-sidebar-brand"
        >
          <BrandMark size="sm" />
          <span>Destr</span>
        </Link>
      </div>

      <div className="shrink-0 px-3 pt-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 rounded-lg px-3 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          data-testid="app-sidebar-new-chat"
        >
          <Link href="/chat" onClick={onNavigate}>
            <SquarePen className="shrink-0" aria-hidden />
            New chat
          </Link>
        </Button>
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-2"
        aria-label={section === 'admin' ? 'Admin' : 'Chat history'}
      >
        {section === 'admin' ? (
          <ul className="flex flex-col gap-0.5" data-testid="app-sidebar-admin-list">
            {ADMIN_LINKS.map((link) => (
              <li key={link.href}>
                <AdminLink link={link} />
              </li>
            ))}
          </ul>
        ) : (
          <ConversationNav
            conversations={conversations}
            activeConversationId={activeConversationId}
            renamingId={renamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            onRenameStart={onRenameStart}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            onDeleteAsk={onDeleteAsk}
            onNavigate={onNavigate}
          />
        )}
      </nav>

      <Separator className="shrink-0 opacity-50" />

      <div className="shrink-0 space-y-1 p-3">
        {role === 'admin' ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className={cn(
              'w-full justify-start gap-2.5 rounded-lg px-3',
              section === 'admin'
                ? 'text-muted-foreground hover:bg-card hover:text-foreground'
                : 'text-muted-foreground hover:bg-card hover:text-foreground',
            )}
            data-testid="app-sidebar-admin-panel"
          >
            <Link href={section === 'admin' ? '/chat' : '/admin'} onClick={onNavigate}>
              {section === 'admin' ? (
                <MessageSquare className="shrink-0" aria-hidden />
              ) : (
                <LayoutDashboard className="shrink-0" aria-hidden />
              )}
              <span>{section === 'admin' ? 'Chat' : 'Admin panel'}</span>
            </Link>
          </Button>
        ) : null}

        {user ? (
          <div
            className="flex items-center gap-2.5 rounded-lg px-2 py-2"
            data-testid="app-sidebar-user"
          >
            <Avatar className="size-8 shrink-0 ring-1 ring-border-subtle">
              {user.imageUrl ? (
                <AvatarImage src={user.imageUrl} alt={user.name ?? 'User avatar'} />
              ) : null}
              <AvatarFallback className="bg-surface-elevated text-xs font-semibold text-foreground">
                {(user.name ?? '?').charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {user.name ?? user.email}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => signOut({ redirectUrl: '/' })}
              className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              data-testid="app-sidebar-sign-out"
              aria-label="Sign out"
            >
              <LogOut aria-hidden />
            </Button>
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">Not signed in</p>
        )}
      </div>
    </div>
  );
}

function AdminLink({ link }: { link: (typeof ADMIN_LINKS)[number] }) {
  const pathname = usePathname();
  const Icon = link.icon;
  const active = pathname === link.href || pathname?.startsWith(`${link.href}/`) || false;
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className={cn(
        'h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5',
        active
          ? 'bg-secondary text-foreground hover:bg-secondary hover:text-foreground'
          : 'text-muted-foreground hover:bg-card hover:text-foreground',
      )}
      data-testid={`app-sidebar-admin-${link.label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <Link href={link.href}>
        <Icon className="shrink-0 text-foreground-subtle" aria-hidden />
        <span>{link.label}</span>
      </Link>
    </Button>
  );
}

function ConversationNav({
  conversations,
  activeConversationId,
  renamingId,
  renameValue,
  setRenameValue,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDeleteAsk,
  onNavigate,
}: {
  conversations: ConversationItem[];
  activeConversationId: string | null;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  onRenameStart: (id: string, currentTitle: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  onDeleteAsk: (id: string) => void;
  onNavigate: () => void;
}) {
  if (conversations.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground" data-testid="conversation-empty">
        No chats yet — start one below.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="conversation-list">
      {sectionConversations(conversations).map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
            {group.label}
          </p>
          {group.items.map((item) =>
            renamingId === item.id ? (
              <Input
                key={item.id}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => onRenameCommit(item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRenameCommit(item.id);
                  if (e.key === 'Escape') onRenameCancel();
                }}
                className="h-8 rounded-md border-border-subtle bg-background text-[13px]"
                data-testid="conversation-rename-input"
                aria-label="Rename chat"
              />
            ) : (
              <ConversationRow
                key={item.id}
                item={item}
                active={item.id === activeConversationId}
                onRenameStart={onRenameStart}
                onDeleteAsk={onDeleteAsk}
                onNavigate={onNavigate}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function ConversationRow({
  item,
  active,
  onRenameStart,
  onDeleteAsk,
  onNavigate,
}: {
  item: ConversationItem;
  active: boolean;
  onRenameStart: (id: string, currentTitle: string) => void;
  onDeleteAsk: (id: string) => void;
  onNavigate: () => void;
}) {
  return (
    <div
      className={cn(
        'group/row relative flex items-center rounded-lg pr-1 transition-colors',
        active ? 'bg-secondary text-foreground' : 'hover:bg-accent/50',
      )}
      data-active={active}
    >
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-9 min-w-0 flex-1 justify-start overflow-hidden px-2.5 font-normal hover:bg-transparent"
      >
        <Link href={`/chat/${item.id}`} onClick={onNavigate} data-testid="conversation-item" title={item.title}>
          <span className="truncate text-[13px]">{item.title || 'Untitled chat'}</span>
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Options for ${item.title || 'Untitled chat'}`}
            className={cn(
              'size-7 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100',
              active && 'opacity-100',
            )}
            data-testid="conversation-options"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40 rounded-lg border-border-subtle">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => onRenameStart(item.id, item.title || 'Untitled chat')}
              data-testid="conversation-rename"
            >
              <Pencil aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDeleteAsk(item.id)}
              data-testid="conversation-delete"
            >
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

