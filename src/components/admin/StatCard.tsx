import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: number;
  href?: string;
  testId?: string;
}

export function StatCard({ label, value, href, testId }: StatCardProps) {
  const content = (
    <>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums text-foreground">
        {value.toLocaleString()}
      </span>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="group block rounded-xl focus-visible:outline-none"
        data-testid={testId}
      >
        <Card
          className={cn(
            'gap-2 p-4 shadow-none transition-colors duration-200',
            'group-hover:border-primary/40 group-hover:bg-surface-elevated',
          )}
        >
          {content}
        </Card>
      </Link>
    );
  }

  return (
    <Card className="gap-2 p-4 shadow-none">{content}</Card>
  );
}
