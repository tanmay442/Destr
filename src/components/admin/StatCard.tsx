import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
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
      <Eyebrow>{label}</Eyebrow>
      <span className="text-2xl font-semibold text-foreground tabular-nums">
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
