'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatInterface } from '@/components/ChatInterface';
import { toResumedConversation, type StoredMessagePayload } from '@/chat/resume';
import { Skeleton } from '@/components/ui/skeleton';
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

function ResumeSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-8 sm:px-6"
      aria-busy="true"
      aria-label="Loading conversation"
      data-testid="chat-resume-skeleton"
    >
      <div className="flex justify-end">
        <Skeleton className="h-10 w-2/5 rounded-2xl" />
      </div>
      <div className="flex flex-col items-start gap-3">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-16 w-3/5 rounded-2xl" />
        <Skeleton className="h-4 w-24 rounded-md" />
      </div>
      <div className="flex flex-col items-start gap-3">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-12 w-1/2 rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * Route-driven chat session: `/chat` starts a fresh conversation (id is minted
 * client-side and synced into the URL after the first send), `/chat/[id]`
 * resumes a stored one behind a skeleton while the network round-trip runs.
 */
export function ChatConversationLoader({ routeId }: { routeId: string | null }) {
  const router = useRouter();
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

  if (!loaded) return <ResumeSkeleton />;

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
