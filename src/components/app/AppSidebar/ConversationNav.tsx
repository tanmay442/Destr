'use client';

import Link from 'next/link';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { sectionConversations } from './utils';
import type { ConversationItem } from './types';

export function ConversationNav({
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
        aria-current={active ? 'page' : undefined}
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
