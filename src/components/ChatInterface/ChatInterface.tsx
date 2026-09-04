'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';
import type { MyUIMessage } from '@/composition';
import type { CitationData } from '@/chat/types';
import {
  MAX_CONVERSATIONS_PER_USER,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_RESUME_MESSAGES,
} from '@app/domain';
import { notifyConversationsChanged } from '@/chat/events';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { toast } from '@/components/ui/sonner';
import { ArrowUp, Square, AlertCircle } from 'lucide-react';
import {
  FEEDBACK_RETRY_DELAY_MS,
  QUICK_PROMPTS,
  errorDigest,
  postFeedback,
  precedingUserMessageId,
  uniqueIds,
  uuidv4,
  type FeedbackVote,
} from './utils';
import { StatusStages } from './feedback';
import { MessageItem } from './MessageItem';

export function ChatInterface({
  conversationId,
  initialMessages = [],
  initialTurnIds = {},
  initialMessageCount,
  conversationLimitReached = false,
  truncated = false,
  onConversationPersisted,
}: {
  conversationId: string;
  initialMessages?: MyUIMessage[];
  initialTurnIds?: Record<string, string>;
  initialMessageCount?: number;
  conversationLimitReached?: boolean;
  truncated?: boolean;
  onConversationPersisted?: () => void;
}) {
  const [input, setInput] = useState('');
  const [turnIds, setTurnIds] = useState<Record<string, string>>(initialTurnIds);
  const [votes, setVotes] = useState<Record<string, FeedbackVote>>({});
  const [messageCount, setMessageCount] = useState(
    initialMessageCount ?? initialMessages.length,
  );
  const pendingTurnIdRef = useRef<Map<string, string>>(new Map());
  const retriedMessageIdRef = useRef<string | null>(null);
  const messagesRef = useRef<MyUIMessage[]>([]);
  const submittingRef = useRef(false);
  const notifiedConversationRef = useRef(false);
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);
  const { messages, sendMessage, status, error, stop } = useChat<MyUIMessage>({
    id: conversationId,
    transport,
    messages: initialMessages,
    onFinish: ({ message, isAbort, isDisconnect, isError }) => {
      if (isAbort || isDisconnect || isError) return;
      if (message.role !== 'assistant') return;
      const userMessageId = precedingUserMessageId(messagesRef.current, message);
      if (!userMessageId) return;
      const turnId = pendingTurnIdRef.current.get(userMessageId);
      if (!turnId) return;
      pendingTurnIdRef.current.delete(userMessageId);
      const isRetry = retriedMessageIdRef.current === userMessageId;
      if (isRetry) retriedMessageIdRef.current = null;
      setTurnIds((prev) => ({ ...prev, [message.id]: turnId }));
      if (!isRetry) setMessageCount((prev) => prev + 2);
      if (!notifiedConversationRef.current) {
        notifiedConversationRef.current = true;
        const persistedPart = message.parts.find(
          (part) =>
            part.type === 'data-conversation-persisted' &&
            part.data.conversationId === conversationId,
        );
        if (persistedPart) onConversationPersisted?.();
        notifyConversationsChanged(conversationId);
      }
    },
  });
  useEffect(() => {
    messagesRef.current = messages;
  });

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (submittingRef.current) return;
    if (conversationLimitReached) {
      toast.error(
        `You've reached the maximum of ${MAX_CONVERSATIONS_PER_USER} chats — delete older ones to start a new one.`,
      );
      return;
    }
    if (messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
      toast.error('This chat is full — start a new one.');
      return;
    }
    submittingRef.current = true;
    let userMessageId: string | undefined;
    try {
      const turnId = uuidv4();
      userMessageId = uuidv4();
      pendingTurnIdRef.current.set(userMessageId, turnId);
      await sendMessage(
        { parts: [{ type: 'text', text: trimmed }], id: userMessageId, role: 'user' },
        { body: { turnId, conversationId } },
      );
      setInput('');
    } catch {
      if (userMessageId) {
        pendingTurnIdRef.current.delete(userMessageId);
      }
      toast.error('Could not send your message. Please try again.');
    } finally {
      submittingRef.current = false;
    }
  };

  const submitFeedback = useCallback(
    async (
      message: MyUIMessage,
      turnId: string,
      feedback: FeedbackVote,
    ) => {
      const previous = votes[turnId];
      if (previous === feedback) return;
      setVotes((prev) => ({ ...prev, [turnId]: feedback }));
      const citationData = message.parts
        .filter((p) => p.type === 'data-citation')
        .map((p) => (p as { data: CitationData }).data);
      const documentIds = uniqueIds(citationData.map((c) => c.documentId));
      const chunkIds = uniqueIds(citationData.map((c) => c.id));
      const payload = {
        turnId,
        feedback,
        ...(documentIds.length > 0 ? { documentIds } : {}),
        ...(chunkIds.length > 0 ? { chunkIds } : {}),
      };
      try {
        let res = await postFeedback(payload);
        if (res.status === 404) {
          await new Promise((resolve) => setTimeout(resolve, FEEDBACK_RETRY_DELAY_MS));
          res = await postFeedback(payload);
        }
        if (!res.ok) throw new Error(`Feedback request failed (${res.status})`);
      } catch {
        setVotes((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[turnId];
          else next[turnId] = previous;
          return next;
        });
        toast.error('Could not save your feedback. Please try again.');
      }
    },
    [votes],
  );

  const handleVote = useCallback(
    (message: MyUIMessage, turnId: string, feedback: FeedbackVote) => {
      void submitFeedback(message, turnId, feedback);
    },
    [submitFeedback],
  );

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(input);
    }
  };

  const isStreaming = status === 'submitted' || status === 'streaming';

  let lastUserMessage: MyUIMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    lastUserMessage = m;
    break;
  }
  const lastUserText = lastUserMessage
    ? lastUserMessage.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('\n')
    : '';

  const retryLastMessage = () => {
    const target = lastUserMessage;
    if (!target || isStreaming) return;
    const turnId = uuidv4();
    retriedMessageIdRef.current = target.id;
    pendingTurnIdRef.current.set(target.id, turnId);
    sendMessage(undefined, { body: { turnId, conversationId, retry: true } }).catch(() => {
      toast.error('Could not send your message. Please try again.');
    });
  };

  useEffect(() => {
    if (status === 'ready' || status === 'error') {
      submittingRef.current = false;
    }
  }, [status]);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distance < 160;
    if (nearBottom && typeof anchorRef.current?.scrollIntoView === 'function') {
      anchorRef.current.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    }
  }, [messages, status, isStreaming]);

  useEffect(() => {
    if (!error || (error instanceof Error && error.name === 'AbortError')) return;
    const digest = errorDigest(error);
    toast.error(digest ? `Something went wrong. Reference: ${digest}` : 'Something went wrong.');
  }, [error]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {isStreaming ? 'Generating response…' : ''}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="chat-scroll"
        aria-live="off"
        aria-atomic="false"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
          {truncated && messages.length > 0 ? (
            <p
              className="text-center text-xs text-muted-foreground"
              data-testid="chat-truncated-notice"
            >
              Showing the last {MAX_RESUME_MESSAGES} messages of this chat
            </p>
          ) : null}
          {messages.length === 0 ? (
            <div className="flex animate-in flex-col items-center gap-10 pt-[18vh] text-center duration-500 fade-in-0 slide-in-from-bottom-2">
              <div className="flex flex-col items-center gap-4">
                <Image
                  src="/logo.svg"
                  alt=""
                  aria-hidden
                  width={42}
                  height={42}
                  className="h-[42px] w-[42px]"
                />
                <div className="flex flex-col gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    Answers grounded in your docs
                  </h1>
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                    I&apos;ll answer from the official documentation and cite the
                    source I used — or raise a ticket if I can&apos;t help.
                  </p>
                </div>
              </div>

              <div className="hidden w-full max-w-2xl grid-cols-1 gap-2 sm:grid sm:grid-cols-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    disabled={isStreaming}
                    onClick={() => void submit(q.text)}
                    className="group flex h-auto items-start gap-3 rounded-xl border border-border-subtle bg-card/60 px-4 py-3 text-left text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-surface-elevated disabled:opacity-50"
                    data-testid="chat-quick-prompt"
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 size-1.5 shrink-0 rounded-full bg-foreground-subtle transition-colors group-hover:bg-primary"
                    />
                    <span className="text-[13.5px] leading-relaxed text-muted-foreground group-hover:text-foreground">
                      {q.text}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const turnId = turnIds[m.id];
              return (
                <MessageItem
                  key={m.id}
                  message={m}
                  turnId={turnId}
                  vote={turnId ? votes[turnId] : undefined}
                  onVote={handleVote}
                />
              );
            })
          )}

          {isStreaming &&
            (() => {
              const last = messages[messages.length - 1];
              const lastHasText =
                last?.role === 'assistant' &&
                last.parts.some((p) => p.type === 'text' && p.text.length > 0);
              if (lastHasText) return null;
              return (
                <div
                  key="thinking"
                  className="flex items-center gap-3"
                  data-testid="chat-message-assistant"
                >
                  <StatusStages />
                </div>
              );
            })()}

          {(() => {
            if ((status !== 'ready' && status !== 'error') || messages.length === 0) return null;
            const last = messages[messages.length - 1];
            if (!last || last.role !== 'assistant') return null;
            const hasVisibleParts = last.parts.some(
              (p) =>
                p.type === 'text'
                  ? p.text.trim().length > 0
                  : p.type === 'data-citation' ||
                    p.type === 'data-guardrail' ||
                    String(p.type).startsWith('tool') ||
                    p.type === 'reasoning' ||
                    p.type === 'file' ||
                    p.type === 'dynamic-tool',
            );
            if (hasVisibleParts) return null;
            return (
              <div
                className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-card/60 px-4 py-3 text-sm text-muted-foreground"
                data-testid="chat-empty-fallback"
              >
                <span>I couldn&apos;t finish that answer. Please try again.</span>
                {lastUserText ? (
                  <Button variant="outline" size="xs" onClick={retryLastMessage} disabled={isStreaming}>
                    Retry
                  </Button>
                ) : null}
              </div>
            );
          })()}

          <div ref={anchorRef} />

          {error && !(error instanceof Error && error.name === 'AbortError') ? (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10 text-destructive"
              data-testid="chat-error"
            >
              <AlertCircle aria-hidden />
              <div className="flex flex-col gap-2">
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription className="text-xs text-destructive/80">
                  {(() => {
                    const digest = errorDigest(error);
                    return digest ? `Reference: ${digest}` : 'Try again in a moment.';
                  })()}
                </AlertDescription>
                {lastUserText ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isStreaming}
                    onClick={retryLastMessage}
                    data-testid="chat-retry"
                    className="w-fit"
                  >
                    Try again
                  </Button>
                ) : null}
              </div>
            </Alert>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-4 pt-2 pb-4 sm:px-6 sm:pb-6">
        {messageCount >= MAX_MESSAGES_PER_CONVERSATION ? (
          <p
            className="mx-auto mb-2 max-w-3xl rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-center text-xs text-warning"
            data-testid="chat-cap-message"
          >
            This chat is full ({MAX_MESSAGES_PER_CONVERSATION} messages) — start a new one to keep chatting.
          </p>
        ) : null}
        <form
          onSubmit={onSubmit}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border-subtle bg-card/80 p-2 shadow-lg shadow-black/20 backdrop-blur-md transition-all duration-200 focus-within:border-primary/40 focus-within:shadow-xl focus-within:shadow-primary/5"
          data-testid="chat-composer"
        >
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isStreaming || messageCount >= MAX_MESSAGES_PER_CONVERSATION}
            placeholder="Message the knowledge assistant…"
            rows={1}
            className={cn(
              'max-h-[220px] min-h-[36px] flex-1 resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-relaxed text-foreground shadow-none transition-colors outline-none',
              'placeholder:text-foreground-faint focus:ring-0 focus:outline-none focus-visible:ring-0 disabled:opacity-60',
            )}
            data-testid="chat-input"
            aria-label="Chat message"
          />
          <Button
            type={isStreaming ? 'button' : 'submit'}
            disabled={!isStreaming && !input.trim()}
            aria-label={isStreaming ? 'Stop generating' : 'Send message'}
            onClick={isStreaming ? () => stop() : undefined}
            size="icon"
            className={cn(
              'size-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed',
              isStreaming
                ? 'bg-secondary text-foreground hover:bg-surface-elevated'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40',
            )}
            data-testid="chat-send"
          >
            {isStreaming ? (
              <Square className="size-3.5" fill="currentColor" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-foreground-faint">
          Press <kbd className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">Enter</kbd>{' '}
          to send ·{' '}
          <kbd className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">Shift</kbd>{' '}
          +{' '}
          <kbd className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">Enter</kbd>{' '}
          for a new line
        </p>
      </div>
    </div>
  );
}
