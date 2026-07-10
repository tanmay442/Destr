'use client';

export default function AdminError({
  // error prop required by Next.js ErrorBoundary API
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 p-8 text-center">
      <h2 className="text-xl font-medium">Something went wrong</h2>
      <p className="text-sm text-foreground-muted">
        An unexpected error occurred. Please try again.
      </p>
      <button
        onClick={() => reset()}
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover"
      >
        Try again
      </button>
    </div>
  );
}
