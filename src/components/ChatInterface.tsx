'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Image from 'next/image';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import type { MyUIMessage } from '@/composition';
import type { CitationData, GuardrailData } from '@/chat/types';
import {
  MAX_CONVERSATIONS_PER_USER,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_RESUME_MESSAGES,
  DEGRADED_BANNER_MESSAGE,
} from '@app/domain';
import { notifyConversationsChanged } from '@/chat/events';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { toast } from '@/components/ui/sonner';
import {
  ArrowUp,
  Square,
  Search,
  FileStack,
  FileCheck,
  Clock,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';

const FEEDBACK_RETRY_DELAY_MS = 1500;

/** Default copy for the soft degraded banner when the server sends no custom message. */
const DEGRADED_BANNER_FALLBACK = DEGRADED_BANNER_MESSAGE;

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

function errorDigest(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return undefined;
  let hash = 2166136261;
  for (let i = 0; i < message.length; i += 1) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ref-${(hash >>> 0).toString(36)}`;
}

type FeedbackVote = 1 | -1;

function uniqueIds(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === 'number'))];
}

function postFeedback(payload: {
  turnId: string;
  feedback: FeedbackVote;
  documentIds?: number[];
  chunkIds?: number[];
}): Promise<Response> {
  return fetch('/api/chat/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function FeedbackControl({
  vote,
  onVote,
}: {
  vote: FeedbackVote | undefined;
  onVote: (feedback: FeedbackVote) => void;
}) {
  return (
    <div className="flex items-center gap-0.5" data-testid="chat-feedback">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Helpful answer"
        aria-pressed={vote === 1}
        onClick={() => onVote(1)}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          vote === 1 && 'text-success hover:text-success',
        )}
        data-testid="chat-feedback-up"
      >
        <ThumbsUp className={cn(vote === 1 && '[&_svg]:fill-current')} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Unhelpful answer"
        aria-pressed={vote === -1}
        onClick={() => onVote(-1)}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          vote === -1 && 'text-destructive hover:text-destructive',
        )}
        data-testid="chat-feedback-down"
      >
        <ThumbsDown className={cn(vote === -1 && '[&_svg]:fill-current')} />
      </Button>
    </div>
  );
}

function StatusStages() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (stage >= 3) return;
    const timer = setTimeout(() => setStage((s) => s + 1), 5000);
    return () => clearTimeout(timer);
  }, [stage]);

  const stages = [
    { icon: Search, label: 'Searching from the sources' },
    { icon: FileStack, label: 'Compiling them' },
    { icon: FileCheck, label: 'Finalizing output' },
    { icon: Clock, label: 'Just a moment' },
  ];

  const { icon: Icon, label } = stages[stage]!;

  return (
    <span
      aria-label="Generating response"
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="chat-thinking"
    >
      <Icon className="size-4 animate-pulse" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function SafeLink({ href, children, ...props }: ComponentProps<'a'>) {
  const url = typeof href === 'string' ? href.trim() : '';
  if (!/^(https?:)\/\//i.test(url)) {
    return <span {...props}>{children}</span>;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

/** Red blocking wall: retrieval found nothing or the answer was not grounded — offers a ticket. */
function GuardrailWallBanner() {
  return (
    <Alert
      variant="destructive"
      className="border-destructive/30 bg-destructive/10 text-destructive"
      data-testid="chat-guardrail-wall"
    >
      <AlertCircle aria-hidden />
      <div className="flex flex-col gap-1">
        <AlertTitle>I couldn&apos;t find this in the documentation</AlertTitle>
        <AlertDescription className="text-xs text-destructive/80">
          I couldn&apos;t find a reliable answer in the official docs. Want me to open a
          knowledge ticket so a human can follow up?
        </AlertDescription>
      </div>
    </Alert>
  );
}

/** Yellow soft banner for degraded best-effort answers (top-4 fallback); never offers a ticket. */
function DegradedBanner({ message }: { message?: string | undefined }) {
  return (
    <Alert
      className="border-warning/40 bg-warning/10 text-warning"
      data-testid="chat-guardrail-degraded"
      role="status"
    >
      <AlertTriangle aria-hidden />
      <div className="flex flex-col gap-1">
        <AlertTitle>Best-effort answer</AlertTitle>
        <AlertDescription className="text-xs text-warning/80">
          {message || DEGRADED_BANNER_FALLBACK}
        </AlertDescription>
      </div>
    </Alert>
  );
}

function AssistantGuardrail({ data }: { data: GuardrailData }) {
  const isWall = data.outOfDomain || data.offerTicket;
  if (isWall) return <GuardrailWallBanner />;
  if (data.degraded) return <DegradedBanner message={data.message} />;
  return null;
}

const MessageItem = memo(function MessageItem({
  message,
  turnId,
  vote,
  onVote,
}: {
  message: MyUIMessage;
  turnId: string | undefined;
  vote: FeedbackVote | undefined;
  onVote: (message: MyUIMessage, turnId: string, feedback: FeedbackVote) => void;
}) {
  const isUser = message.role === 'user';
  const textParts = message.parts.filter((p) => p.type === 'text');
  const citations = message.parts.filter(
    (p) => p.type === 'data-citation',
  ) as Array<{
    type: 'data-citation';
    data: CitationData;
  }>;
  const guardrails = isUser
    ? []
    : (message.parts.filter((p) => p.type === 'data-guardrail') as Array<{
        type: 'data-guardrail';
        data: GuardrailData;
      }>);

  return (
    <div
      className={cn(
        'flex w-full animate-in flex-col gap-3 duration-300 fade-in-0 slide-in-from-bottom-2',
        isUser ? 'items-end' : 'items-start',
      )}
      data-testid={isUser ? 'chat-message-user' : 'chat-message-assistant'}
    >
      {textParts.map((part, i) =>
        part.type === 'text' ? (
          isUser ? (
            <div
              key={i}
              className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground"
              data-testid="chat-text"
            >
              {part.text}
            </div>
          ) : (
            <div
              key={i}
              className="chat-markdown w-full max-w-none text-[15px] leading-relaxed text-foreground"
              data-testid="chat-text"
            >
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: SafeLink }}>
                {part.text}
              </Markdown>
            </div>
          )
        ) : null,
      )}

      {citations.length > 0 && !isUser ? (
        <div
          className="-mx-1 flex w-full max-w-none snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1"
          data-testid="chat-citations"
        >
          {citations.map((c, i) => {
            const sim = c.data.similarity;
            const simPct = Math.round(sim * 100);
            const simTone =
              sim >= 0.8
                ? 'var(--success)'
                : sim >= 0.6
                  ? 'var(--primary)'
                  : 'var(--warning)';
            return (
              <div
                key={i}
                className="flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl border border-border-subtle bg-surface-sunken/60 p-3"
                data-testid="chat-citation"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                    Source {i + 1}
                  </span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                    style={{
                      color: simTone,
                      background: `color-mix(in oklch, ${simTone} 14%, transparent)`,
                    }}
                    title="Cosine similarity to your question"
                  >
                    {simPct}% match
                  </span>
                </div>
                {c.data.fileName ? (
                  <div className="flex flex-col gap-0.5">
                    <span
                      className="truncate text-[11.5px] font-medium text-foreground"
                      title={c.data.fileName}
                      data-testid="chat-citation-file"
                    >
                      {c.data.fileName}
                      {c.data.page != null ? (
                        <span className="text-muted-foreground">
                          {' '}
                          — p.{c.data.page}
                        </span>
                      ) : null}
                    </span>
                    {c.data.sectionTitle && c.data.sectionTitle !== c.data.fileName ? (
                      <span
                        className="truncate text-[11px] text-muted-foreground"
                        title={c.data.sectionTitle}
                        data-testid="chat-citation-section"
                      >
                        § {c.data.sectionTitle}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <p className="line-clamp-4 text-[12.5px] leading-relaxed text-muted-foreground">
                  {c.data.snippet}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      {guardrails.map((g, i) => (
        <AssistantGuardrail key={i} data={g.data} />
      ))}

      {!isUser && turnId ? (
        <FeedbackControl
          vote={vote}
          onVote={(feedback) => onVote(message, turnId, feedback)}
        />
      ) : null}
    </div>
  );
});

const QUICK_PROMPTS: Array<{ label: string; text: string }> = [
  { label: 'Reset password', text: 'How do I change my password?' },
  { label: 'Invite teammate', text: 'How do I invite a teammate to my workspace?' },
  { label: 'API rate limit', text: "What's the API rate limit on the Team plan?" },
  { label: 'Open a ticket', text: "I'd like to open a knowledge ticket." },
];

function precedingUserMessageId(
  messages: MyUIMessage[],
  assistant: MyUIMessage,
): string | undefined {
  const index = messages.findIndex((m) => m.id === assistant.id);
  for (let i = index >= 0 ? index - 1 : messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') return m.id;
  }
  return undefined;
}

export function ChatInterface({
  conversationId,
  initialMessages = [],
  initialTurnIds = {},
  initialMessageCount,
  conversationLimitReached = false,
  truncated = false,
}: {
  conversationId: string;
  initialMessages?: MyUIMessage[];
  initialTurnIds?: Record<string, string>;
  initialMessageCount?: number;
  conversationLimitReached?: boolean;
  truncated?: boolean;
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
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="chat-scroll"
        aria-live="polite"
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
