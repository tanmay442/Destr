'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Search,
  FileStack,
  FileCheck,
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
