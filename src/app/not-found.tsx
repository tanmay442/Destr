import Link from 'next/link';

export default function RootNotFound() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      role="alert"
    >
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
