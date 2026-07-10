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
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
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
        className="group block"
        data-testid={testId}
      >
        <Card
          className={cn(
            'gap-1 p-4 shadow-none transition-all duration-200',
            'group-hover:-translate-y-0.5 group-hover:border-primary/60 group-hover:bg-surface-elevated group-hover:shadow-lg',
          )}
        >
          {content}
        </Card>
      </Link>
    );
  }

  return (
    <Card className="gap-1 p-4 shadow-none">{content}</Card>
  );
}
