'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Clock,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import type { FeedbackVote } from './utils';

export function FeedbackControl({
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

export function StatusStages() {
  // WP-8 F-29: timer-invented phases removed. This is a truthful static
  // indicator that claims no specific server phase. Real phase progress
  // renders through AgentProgress when the server emits transient
  // data-agent-progress events (see AgentProgress.tsx).
  return (
    <span
      aria-label="Generating response"
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="chat-thinking"
    >
      <Clock className="size-4 animate-pulse" aria-hidden />
      <span>Working on your request</span>
    </span>
  );
}
