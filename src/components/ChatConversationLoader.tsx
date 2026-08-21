'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChatInterface } from '@/components/ChatInterface';
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

/**
 * Route-driven chat session: `/chat` starts a fresh conversation (id is minted
 * client-side and synced into the URL after the first send), `/chat/[id]`
 * resumes a stored one. The sidebar list refreshes via chat events.
 */
export function ChatConversationLoader() {
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const routeId = typeof params?.id === 'string' && params.id ? params.id : null;

  const [conversationId] = useState<string>(() => routeId ?? uuidv4());
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [loaded, setLoaded] = useState(routeId === null);

  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    fetch(`/api/chat/conversations/${routeId}`)
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as {
          conversation: { messageCount: number };
          messages: StoredMessagePayload[];
        };
      })
      .then((payload) => {
        if (cancelled) return;
        if (!payload) {
          router.replace('/chat');
          return;
        }
        const resumed = toResumedConversation({
          messages: payload.messages ?? [],
          messageCount: payload.conversation?.messageCount,
        });
        setResume(resumed.messages.length > 0 ? resumed : null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [routeId, router]);

  // Sync freshly-minted ids into the URL without triggering a remount.
  useEffect(() => {
    if (routeId === null && loaded) {
      window.history.replaceState(null, '', `/chat/${conversationId}`);
    }
  }, [routeId, loaded, conversationId]);

  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-border-subtle border-t-foreground/70" />
      </div>
    );
  }

  return (
    <ChatInterface
      key={conversationId}
      conversationId={conversationId}
      initialMessages={resume?.messages ?? []}
      initialTurnIds={resume?.turnIds ?? {}}
      {...(resume?.messageCount !== undefined ? { initialMessageCount: resume.messageCount } : {})}
    />
  );
}
