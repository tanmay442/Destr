'use client';

// Root global error boundary; catches unhandled errors. Must be a Client Component per Next.js.
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
        className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]"
        style={{
          // Inline because globals.css may not have loaded.
          colorScheme: 'dark',
        }}
      >
        <div className="max-w-md text-center" role="alert">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-[var(--foreground-muted)]">
            An unexpected error occurred. Please try again.
          </p>
          {error.digest ? (
            <p className="mt-1 text-xs text-[var(--foreground-subtle)]">
              Error ID: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-block rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
