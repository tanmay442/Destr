'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { MyUIMessage } from '@/composition';
import type { CitationData, GuardrailData } from '@/chat/types';
import { MemoMarkdown } from './markdown';
import { FeedbackControl } from './feedback';
import { AssistantGuardrail, highestSeverityGuardrail } from './guardrail';
import type { FeedbackVote } from './utils';

export const MessageItem = memo(function MessageItem({
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
              key={`${message.id}-text-${i}`}
              className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground"
              data-testid="chat-text"
            >
              {part.text}
            </div>
          ) : (
            <div
              key={`${message.id}-text-${i}`}
              className="chat-markdown w-full max-w-none text-[15px] leading-relaxed text-foreground"
              data-testid="chat-text"
            >
              <MemoMarkdown text={part.text} />
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
            const citationKey = c.data.chunkUid ?? (c.data.id != null ? String(c.data.id) : `${message.id}-citation-${i}`);
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
                key={citationKey}
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

      {(() => {
        const guardrail = highestSeverityGuardrail(guardrails);
        return guardrail ? <AssistantGuardrail data={guardrail} /> : null;
      })()}

      {!isUser && turnId ? (
        <FeedbackControl
          vote={vote}
          onVote={(feedback) => onVote(message, turnId, feedback)}
        />
      ) : null}
    </div>
  );
});
