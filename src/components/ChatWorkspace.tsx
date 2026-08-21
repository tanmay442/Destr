'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChatInterface } from '@/components/ChatInterface';
import { ConversationList } from '@/components/ConversationList';
import { toResumedConversation, type StoredMessagePayload } from '@/chat/resume';
import type { MyUIMessage } from '@/composition';

function uuidv4(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface ResumeState {
  messages: MyUIMessage[];
  turnIds: Record<string, string>;
  messageCount: number;
}

export function ChatWorkspace() {
  const [conversationId, setConversationId] = useState<string>(() => uuidv4());
  const [resume, setResume] = useState<(ResumeState & { id: string }) | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chat/conversations/${conversationId}`)
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as {
          conversation: { messageCount: number };
          messages: StoredMessagePayload[];
        };
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        const resumed = toResumedConversation({
          messages: payload.messages ?? [],
          messageCount: payload.conversation?.messageCount,
        });
        if (resumed.messages.length > 0) {
          setResume({ ...resumed, id: conversationId });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const activeResume = resume?.id === conversationId ? resume : null;

  const startNewChat = useCallback(() => {
    setResume(null);
    setConversationId(uuidv4());
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 px-4 pt-4 sm:px-6">
        <ConversationList
          activeId={conversationId}
          refreshKey={listRefreshKey}
          onSelect={(id) => {
            if (id !== conversationId) setConversationId(id);
          }}
          onNew={startNewChat}
          onDeleted={(id) => {
            if (id === conversationId) startNewChat();
            setListRefreshKey((k) => k + 1);
          }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatInterface
          key={conversationId}
          conversationId={conversationId}
          initialMessages={activeResume?.messages ?? []}
          initialTurnIds={activeResume?.turnIds ?? {}}
          {...(activeResume?.messageCount !== undefined
            ? { initialMessageCount: activeResume.messageCount }
            : {})}
          onConversationUsed={() => setListRefreshKey((k) => k + 1)}
        />
      </div>
    </div>
  );
}
