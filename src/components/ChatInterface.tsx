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
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';

/** Single breathing circle — like chatgpt.com's "thinking" indicator. */
function ThinkingDot() {
  return (
    <span
      aria-label="Generating response"
      className="relative flex size-5 items-center justify-center"
      data-testid="chat-thinking"
    >
      <span className="absolute size-2 rounded-full bg-primary/40 motion-safe:animate-[breathe_1.6s_ease-in-out_infinite]" />
      <span className="absolute size-2 rounded-full bg-primary/70 motion-safe:animate-[breathe_1.6s_ease-in-out_infinite_reverse]" />
    </span>
  );
}

const QUICK_PROMPTS: Array<{ label: string; text: string }> = [
  { label: 'Reset password', text: 'How do I change my password?' },
  { label: 'Invite teammate', text: 'How do I invite a teammate to my workspace?' },
  { label: 'API rate limit', text: "What's the API rate limit on the Team plan?" },
  { label: 'Open a ticket', text: "I'd like to open a support ticket." },
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

  // Auto-scroll: follow the stream, settle smoothly when idle.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distance < 160;
    if ((nearBottom || isStreaming) && typeof anchorRef.current?.scrollIntoView === 'function') {
      anchorRef.current.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    }
  }, [messages, status, isStreaming]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-8 text-center mt-[22vh]">
              <div className="flex flex-col gap-3">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  Answers grounded in your docs
                </h1>
                <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                  I&apos;ll answer from the official documentation and cite the
                  source I used — or raise a ticket if I can&apos;t help.
                </p>
              </div>

              <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => submit(q.text)}
                    className="flex h-auto items-start justify-between gap-3 rounded-xl border border-border-subtle bg-card/60 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-surface-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    data-testid="chat-quick-prompt"
                  >
                    <span className="text-[13.5px] leading-relaxed">{q.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
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
                    'flex flex-col gap-2.5',
                    isUser ? 'items-end' : 'items-start',
                  )}
                  data-testid={isUser ? 'chat-message-user' : 'chat-message-assistant'}
                >
                  {textParts.map((part, i) =>
                    part.type === 'text' ? (
                      isUser ? (
                        <div
                          key={i}
                          className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground"
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
                          <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
                        </div>
                      )
                    ) : null,
                  )}

                  {citations.length > 0 && !isUser && (
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
                            className="flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl border border-border-subtle bg-surface-sunken/70 p-3"
                            data-testid="chat-citation"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
                                Source {i + 1}
                              </span>
                              <span
                                className="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
                                style={{
                                  color: simTone,
                                  background: `color-mix(in oklch, ${simTone} 14%, transparent)`,
                                }}
                                title="Cosine similarity to your question"
                              >
                                {simPct}% match
                              </span>
                            </div>
                            <p className="line-clamp-4 text-[12.5px] leading-relaxed text-muted-foreground">
                              {c.data.snippet}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
                  <ThinkingDot />
                  <span className="text-sm text-muted-foreground">Thinking…</span>
                </div>
              );
            })()}

          <div ref={anchorRef} />

          {error && (
            <Alert
              variant="destructive"
              className="flex items-start gap-2.5 rounded-xl border-destructive/30 bg-destructive/10 p-3 text-destructive"
              data-testid="chat-error"
            >
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
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 sm:px-6">
        <form
          onSubmit={onSubmit}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border-subtle bg-card/70 p-2 backdrop-blur-md transition-colors focus-within:border-primary/50"
          data-testid="chat-composer"
        >
          <Textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isStreaming}
            placeholder="Message the support assistant…"
            rows={1}
            className="min-h-[24px] max-h-[200px] flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-foreground-subtle focus-visible:ring-0 disabled:opacity-60"
            data-testid="chat-input"
          />
          <Button
            type={isStreaming ? 'button' : 'submit'}
            disabled={!isStreaming && !input.trim()}
            aria-label={isStreaming ? 'Stop generating' : 'Send message'}
            onClick={isStreaming ? () => stop() : undefined}
            size="icon"
            className="size-9 shrink-0 rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="chat-send"
          >
            {isStreaming ? (
              <SquareIcon data-icon="inline" className="size-4" />
            ) : (
              <ArrowUpIcon data-icon="inline" className="size-4" />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
