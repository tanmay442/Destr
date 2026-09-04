'use client';

import Link from 'next/link';
import { useClerk } from '@clerk/nextjs';
import {
  MessageSquare,
  LayoutDashboard,
  SquarePen,
  PanelLeft,
  LogOut,
} from 'lucide-react';
import { BrandMark } from '@/components/icons/BrandMark';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { ADMIN_LINKS, type AppRole, type AppSidebarUser, type ConversationItem, type SidebarSection } from './types';
import { AdminLink } from './AdminLink';
import { ConversationNav } from './ConversationNav';

export function SidebarBody({
  user,
  role,
  section,
  conversations,
  hasMore,
  onShowMore,
  onNewChat,
  activeConversationId,
  renamingId,
  renameValue,
  setRenameValue,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDeleteAsk,
  onNavigate,
  onSidebarToggle,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  section: SidebarSection;
  conversations: ConversationItem[];
  hasMore: boolean;
  onShowMore: () => void;
  onNewChat: () => void;
  activeConversationId: string | null;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  onRenameStart: (id: string, currentTitle: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  onDeleteAsk: (id: string) => void;
  onNavigate: () => void;
  onSidebarToggle?: () => void;
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
        {onSidebarToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onSidebarToggle}
            aria-label="Close sidebar"
            className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
            data-testid="app-sidebar-collapse"
          >
            <PanelLeft aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="shrink-0 px-3 pt-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 rounded-lg px-3 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          data-testid="app-sidebar-new-chat"
        >
          <Link
            href="/chat"
            onClick={() => {
              onNewChat();
              onNavigate();
            }}
          >
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
          <>
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
            {hasMore ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onShowMore}
                className="mt-1 w-full justify-center text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                data-testid="conversation-show-more"
              >
                Show more
              </Button>
            ) : null}
          </>
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
