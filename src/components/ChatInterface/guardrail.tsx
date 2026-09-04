'use client';

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import type { GuardrailData } from '@/chat/types';

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

/** Yellow soft banner for server notices (e.g. turn deadline); never offers a ticket. */
function NoticeBanner({ message }: { message?: string | undefined }) {
  return (
    <Alert
      className="border-warning/40 bg-warning/10 text-warning"
      data-testid="chat-guardrail-notice"
      role="status"
    >
      <AlertTriangle aria-hidden />
      <div className="flex flex-col gap-1">
        <AlertTitle>Notice</AlertTitle>
        <AlertDescription className="text-xs text-warning/80">
          {message}
        </AlertDescription>
      </div>
    </Alert>
  );
}

/** Collapse stacked guardrail parts into a single banner: ticket wall > notice > last part. */
export function highestSeverityGuardrail(parts: Array<{ data: GuardrailData }>): GuardrailData | undefined {
  return (
    parts.find((p) => p.data.outOfDomain || p.data.offerTicket)?.data ??
    parts.find((p) => p.data.notice)?.data ??
    parts[parts.length - 1]?.data
  );
}

export function AssistantGuardrail({ data }: { data: GuardrailData }) {
  const isWall = data.outOfDomain || data.offerTicket;
  if (isWall) return <GuardrailWallBanner />;
  if (data.notice) return <NoticeBanner message={data.message} />;
  return null;
}
