import Link from 'next/link';

export default function RootNotFound() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4"
      role="alert"
    >
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Page not found</h1>
        <p className="mt-2 text-sm text-[var(--foreground-muted)]">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
