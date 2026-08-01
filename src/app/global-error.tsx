'use client';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"
        style={{ colorScheme: 'dark' }}
      >
        <div className="max-w-md text-center" role="alert">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An unexpected error occurred. Please try again.
          </p>
          {error.digest ? (
            <p className="mt-2 text-xs text-foreground-subtle">
              Error ID: <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}
          <Button onClick={reset} className="mt-6">
            Try again
          </Button>
        </div>
      </body>
    </html>
  );
}
