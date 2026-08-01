import Link from 'next/link';
import { Button } from '@/components/ui/button';

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
        <Button asChild className="mt-6">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
