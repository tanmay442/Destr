import Link from 'next/link';

interface StatCardProps {
  label: string;
  value: number;
  href?: string;
  testId?: string;
}

export function StatCard({ label, value, href, testId }: StatCardProps) {
  const content = (
    <>
      <span className="text-xs uppercase tracking-wide text-foreground-muted">
        {label}
      </span>
      <span className="text-2xl font-semibold text-foreground">
        {value}
      </span>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="group flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/60 hover:bg-surface-elevated hover:shadow-lg"
        data-testid={testId}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4">
      {content}
    </div>
  );
}
