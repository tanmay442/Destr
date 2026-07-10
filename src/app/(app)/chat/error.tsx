'use client';

import { Button } from '@/components/ui/button';

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="flex flex-col items-center gap-3 py-12"
      role="alert"
    >
      <h2 className="text-xl font-medium text-foreground">
        Chat is temporarily unavailable
      </h2>
      <p className="text-sm text-muted-foreground">
        An error occurred while loading the chat. Please try again.
      </p>
      {error.digest ? (
        <p className="text-xs text-foreground-subtle">
          Error ID: <code>{error.digest}</code>
        </p>
      ) : null}
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </section>
  );
}
