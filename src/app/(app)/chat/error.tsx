'use client';

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
      <h2 className="text-xl font-medium text-[var(--foreground)]">
        Chat is temporarily unavailable
      </h2>
      <p className="text-sm text-[var(--foreground-muted)]">
        An error occurred while loading the chat. Please try again.
      </p>
      {error.digest ? (
        <p className="text-xs text-[var(--foreground-subtle)]">
          Error ID: <code>{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
      >
        Try again
      </button>
    </section>
  );
}
