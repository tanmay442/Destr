'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatInterface } from '@/components/ChatInterface';
import { toResumedConversation, type StoredMessagePayload } from '@/chat/resume';
import { onConversationsChanged } from '@/chat/events';
import { MAX_CONVERSATIONS_PER_USER } from '@app/domain';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { MyUIMessage } from '@/composition';

const RESUME_TIMEOUT_MS = 10_000;

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

interface ResumeError {
  title: string;
  detail: string;
}

function ResumeErrorPanel({
  error,
  onRetry,
  onNewChat,
}: {
  error: ResumeError;
  onRetry: () => void;
  onNewChat: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      role="alert"
      data-testid="chat-resume-error"
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold">{error.title}</p>
        <p className="text-sm text-muted-foreground">{error.detail}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onNewChat}>
          Start new chat
        </Button>
        <Button onClick={onRetry}>Try again</Button>
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
  const [error, setError] = useState<ResumeError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [limitReached, setLimitReached] = useState(false);

  useEffect(() => {
    if (routeId !== null) return;
    let cancelled = false;
    const checkLimit = () => {
      Promise.resolve()
        .then(() => fetch('/api/chat/conversations?limit=1'))
        .then(async (res) => (res.ok ? ((await res.json()) as { total?: number }) : null))
        .then((data) => {
          if (cancelled || !data) return;
          setLimitReached(Number(data.total ?? 0) >= MAX_CONVERSATIONS_PER_USER);
        })
        .catch(() => undefined);
    };
    checkLimit();
    const off = onConversationsChanged(checkLimit);
    return () => {
      cancelled = true;
      off();
    };
  }, [routeId]);

  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RESUME_TIMEOUT_MS);

    fetch(`/api/chat/conversations/${routeId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as {
          conversation: { messageCount: number };
          messages: StoredMessagePayload[];
        };
      })
      .then((payload) => {
        if (cancelled) return;
        const resumed = toResumedConversation({
          messages: payload.messages ?? [],
          messageCount: payload.conversation?.messageCount,
        });
        setResume(resumed.messages.length > 0 ? resumed : null);
        setLoaded(true);
      })
      .catch((cause) => {
        if (cancelled) return;
        const status = Number(cause instanceof Error ? cause.message : NaN);
        if (timedOut) {
          setError({
            title: 'Loading timed out',
            detail: 'The conversation took too long to load. Try again.',
          });
        } else if (status === 404) {
          setError({
            title: 'Conversation not found',
            detail: 'It may have been deleted or belongs to a different account.',
          });
        } else {
          setError({
            title: 'Could not load conversation',
            detail:
              Number.isInteger(status) && status > 0
                ? `The server responded with status ${status}. Try again.`
                : 'The server could not be reached. Try again.',
          });
        }
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [routeId, attempt]);

  // Sync freshly-minted ids into the URL without triggering a remount.
  useEffect(() => {
    if (routeId === null && loaded) {
      window.history.replaceState(null, '', `/chat/${conversationId}`);
    }
  }, [routeId, loaded, conversationId]);

  if (error) {
    return (
      <ResumeErrorPanel
        error={error}
        onRetry={() => {
          setError(null);
          setLoaded(false);
          setAttempt((prev) => prev + 1);
        }}
        onNewChat={() => router.push('/chat')}
      />
    );
  }
  if (!loaded) return <ResumeSkeleton />;

  return (
    <ChatInterface
      key={conversationId}
      conversationId={conversationId}
      initialMessages={resume?.messages ?? []}
      initialTurnIds={resume?.turnIds ?? {}}
      {...(resume?.messageCount !== undefined ? { initialMessageCount: resume.messageCount } : {})}
      conversationLimitReached={limitReached}
      truncated={resume !== null && resume.messageCount > resume.messages.length}
    />
  );
}
