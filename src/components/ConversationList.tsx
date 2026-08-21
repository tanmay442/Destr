'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';

export interface ConversationSummaryItem {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

interface ConversationListProps {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ConversationList({
  activeId,
  refreshKey,
  onSelect,
  onNew,
  onDeleted,
}: ConversationListProps) {
  const [items, setItems] = useState<ConversationSummaryItem[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/chat/conversations?limit=25')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { conversations: ConversationSummaryItem[] };
      })
      .then((data) => {
        if (!cancelled) setItems(data.conversations ?? []);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load your chats.');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setItems((prev) => prev.filter((c) => c.id !== id));
      onDeleted(id);
    } catch {
      toast.error('Could not delete this chat.');
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2" data-testid="conversation-list">
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={onNew}
          data-testid="conversation-new"
        >
          New chat
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item.id}
              className={`group inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                item.id === activeId
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border-subtle bg-card text-muted-foreground hover:bg-accent/40'
              }`}
            >
              {confirmingId === item.id ? (
                <>
                  <button
                    type="button"
                    className="text-xs font-medium text-destructive"
                    data-testid="conversation-confirm-delete"
                    onClick={() => void remove(item.id)}
                  >
                    Delete?
                  </button>
                  <button
                    type="button"
                    aria-label="Keep chat"
                    onClick={() => setConfirmingId(null)}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="truncate"
                    data-testid="conversation-item"
                    data-active={item.id === activeId}
                    onClick={() => onSelect(item.id)}
                  >
                    {item.title || 'Untitled chat'}
                    <span className="ml-1.5 opacity-60">{formatDate(item.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    className="opacity-40 transition-opacity group-hover:opacity-100"
                    data-testid="conversation-delete"
                    onClick={() => setConfirmingId(item.id)}
                  >
                    ×
                  </button>
                </>
              )}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
