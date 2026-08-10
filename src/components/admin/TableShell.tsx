import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export function TableShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-border-strong bg-card/50',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TableEmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function TableSkeleton({
  rows = 8,
  rowClassName = 'h-14',
  delay,
}: {
  rows?: number;
  rowClassName?: string;
  delay?: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-strong bg-card/50">
      <Skeleton className="h-10 rounded-none" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn('rounded-none border-t border-border-strong', rowClassName)}
          style={delay ? { animationDelay: `${i * delay}ms` } : undefined}
        />
      ))}
    </div>
  );
}
