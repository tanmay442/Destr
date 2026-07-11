'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import type { MyUIMessage } from '@/composition';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';

const QUICK_PROMPTS: Array<{ label: string; text: string }> = [
  {
    label: 'Reset password',
    text: 'How do I change my password?',
  },
  {
    label: 'Add teammate',
    text: 'How do I invite a teammate to my workspace?',
  },
  {
    label: 'API rate limit',
    text: "What's the API rate limit on the Team plan?",
  },
  {
    label: 'Open a ticket',
    text: "I'd like to open a support ticket.",
  },
];

export function ChatInterface() {
  const [input, setInput] = useState('');
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);
  const { messages, sendMessage, status, error, stop } = useChat<MyUIMessage>({
    transport,
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage({ text: trimmed });
    setInput('');
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(input);
    }
  };

  const isStreaming = status === 'submitted' || status === 'streaming';

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Throttle auto-scroll to avoid excessive scrolling during rapid streaming.
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      const el = messagesScrollRef.current;
      if (!(el instanceof HTMLElement)) return;
      if (!el.isConnected) return;
      if (typeof el.scrollTo !== 'function') return;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: status === 'streaming' ? 'auto' : 'smooth',
      });
    }, 100);
    return () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [messages, status]);

  useEffect(() => {
    if (!error) return;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'Request was aborted.'
          : error.message || 'Something went wrong.'
        : 'Something went wrong.';
    toast.error(message);
  }, [error]);

  return (
    <Card
      data-testid="chat-frame"
      className="flex h-[600px] md:h-[700px] max-h-full w-full min-h-0 flex-col gap-0 overflow-hidden rounded-2xl border-border-subtle bg-card/40 p-0"
    >
      <div
        ref={messagesScrollRef}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6"
        data-testid="chat-messages"
      >
        {messages.length === 0 && (
          <div
            className="mx-auto mt-4 flex w-full max-w-xl flex-col gap-8 px-1 py-2"
            data-testid="chat-intro"
          >
            <div className="flex flex-col items-start gap-4">
              <span
                aria-hidden
                className="inline-flex size-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-4"
                >
                  <path d="M4 4h16v12H7l-3 4V4z" />
                </svg>
              </span>
              <div className="flex flex-col gap-2 break-words">
                <p className="text-[15px] font-semibold text-foreground">
                  Hi! I&apos;m the support assistant.
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Ask a question about your docs and I&apos;ll search the
                  official documentation and cite the source I used.
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  If I can&apos;t find an answer, just ask me to file a support
                  ticket and I&apos;ll get one started for you.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
                Try one of these
              </span>
              <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => {
                      setInput(q.text);
                      composerRef.current?.focus();
                    }}
                    className="group flex h-auto w-full cursor-pointer items-start justify-between gap-4 overflow-hidden rounded-xl border border-border-subtle bg-card/70 p-4 text-left text-sm text-muted-foreground transition-all duration-150 ease-out-quart hover:border-primary/40 hover:bg-surface-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:p-5"
                    data-testid="chat-quick-prompt"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground-subtle">
                        {q.label}
                      </span>
                      <span className="text-[13.5px] leading-relaxed text-muted-foreground group-hover:text-foreground [overflow-wrap:anywhere]">
                        {q.text}
                      </span>
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 size-4 shrink-0 text-foreground-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                      aria-hidden
                    >
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m) => {
          const isUser = m.role === 'user';
          const textParts = m.parts.filter((p) => p.type === 'text');
          const citations = m.parts.filter(
            (p) => p.type === 'data-citation',
          ) as Array<{
            type: 'data-citation';
            data: { similarity: number; snippet: string };
          }>;
          return (
            <div
              key={m.id}
              className={cn(
                isUser
                  ? 'flex flex-col items-end gap-2'
                  : 'flex flex-col items-start gap-2.5',
              )}
              data-testid={isUser ? 'chat-message-user' : 'chat-message-assistant'}
            >
              <span
                className={cn(
                  isUser
                    ? 'text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground-subtle'
                    : 'text-[10px] font-semibold uppercase tracking-[0.14em] text-primary',
                )}
              >
                {isUser ? 'You' : 'Assistant'}
              </span>
              {textParts.map((part, i) => {
                if (part.type === 'text') {
                   return isUser ? (
                    <div
                      key={i}
                      className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm"
                      data-testid="chat-text"
                    >
                      {part.text}
                    </div>
                  ) : (
                    <Card
                      key={i}
                      className={cn(
                        'chat-markdown flex w-fit max-w-[90%] flex-col gap-0 rounded-2xl rounded-bl-md border-border-subtle bg-secondary/80 px-4 py-3 text-[14.5px] leading-relaxed text-foreground shadow-sm',
                      )}
                      data-testid="chat-text"
                    >
                      <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
                    </Card>
                  );
                }
                return null;
              })}
              {citations.length > 0 && !isUser && (
                <div
                  className="-mx-1 flex w-full max-w-[90%] snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1"
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
                      <Card
                        key={i}
                        className="flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl border-border-subtle bg-surface-sunken/70 p-3 shadow-sm"
                        data-testid="chat-citation"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                                className="size-3"
                              aria-hidden
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            Source {i + 1}
                          </span>
                          <Badge
                            variant="outline"
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
                            style={{
                              color: simTone,
                              background: `color-mix(in oklch, ${simTone} 14%, transparent)`,
                            }}
                            title="Cosine similarity to your question"
                          >
                            {simPct}% match
                          </Badge>
                        </div>
                        <div
                          className="h-1 w-full overflow-hidden rounded-full bg-surface-elevated"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${simPct}%`,
                              background: 'var(--success)',
                            }}
                          />
                        </div>
                        <p className="line-clamp-4 text-[12.5px] leading-relaxed text-muted-foreground">
                          {c.data.snippet}
                        </p>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {isStreaming && (
          <div
            className="flex items-center gap-2 self-start rounded-full border border-border-subtle bg-card/80 px-2.5 py-1 text-xs text-muted-foreground"
            data-testid="chat-streaming"
          >
            <span className="flex gap-1" aria-hidden>
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
            </span>
            <span>Generating</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => stop()}
              className="ml-1 px-1.5 py-0.5 text-[11px] font-medium text-foreground-subtle transition-colors hover:bg-surface-elevated hover:text-foreground"
            >
              Stop
            </Button>
          </div>
        )}

        {error && (
          <Alert
            variant="destructive"
            className="flex items-start gap-2.5 rounded-xl border-destructive/30 bg-destructive/10 p-3 text-destructive"
            data-testid="chat-error"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-0.5 shrink-0"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div className="flex flex-col gap-0.5">
              <AlertTitle className="font-medium">
                {error instanceof Error
                  ? error.name === 'AbortError'
                    ? 'Request was aborted.'
                    : error.message || 'Something went wrong.'
                  : 'Something went wrong.'}
              </AlertTitle>
              <AlertDescription className="text-[12px] text-destructive/80">
                {error instanceof Error && error.name === 'AbortError'
                  ? ''
                  : 'Try again in a moment.'}
              </AlertDescription>
            </div>
          </Alert>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="group/composer flex shrink-0 items-end gap-2 border-t border-border-subtle bg-card/60 p-2 backdrop-blur-md transition-colors duration-150 focus-within:border-primary/60"
        data-testid="chat-composer"
      >
        <Textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isStreaming}
          placeholder="Type your question…"
          rows={1}
          className="min-h-[40px] max-h-[160px] flex-1 resize-none rounded-xl border-0 bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-foreground-subtle focus-visible:ring-0 disabled:opacity-60"
          data-testid="chat-input"
        />
        <Button
          type={isStreaming ? 'button' : 'submit'}
          disabled={!isStreaming && !input.trim()}
          aria-label={isStreaming ? 'Stop generating' : 'Send message'}
          onClick={isStreaming ? () => stop() : undefined}
          className="h-10 w-10 shrink-0 rounded-xl transition-all duration-150 ease-out-quart hover:bg-primary active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="chat-send"
        >
          {isStreaming ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </Button>
      </form>
    </Card>
  );
}