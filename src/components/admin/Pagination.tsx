import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pathname: string;
  query: Record<string, string | number | undefined>;
  linkClassName?: string;
}

const defaultLinkClass = buttonVariants({ variant: 'outline', size: 'sm' });

export function Pagination({
  page,
  totalPages,
  total,
  pathname,
  query,
  linkClassName = defaultLinkClass,
}: PaginationProps) {
  return (
    <nav
      className="flex flex-col-reverse items-stretch gap-2 text-sm sm:flex-row sm:items-center sm:justify-between"
      aria-label="Pagination"
    >
      <span className="text-muted-foreground tabular-nums">
        Page <span className="text-foreground">{page}</span> of {totalPages} ·{' '}
        {total.toLocaleString()} total
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={{ pathname, query: { ...query, page: page - 1 } }}
            className={cn(linkClassName)}
            aria-label="Previous page"
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={{ pathname, query: { ...query, page: page + 1 } }}
            className={cn(linkClassName)}
            aria-label="Next page"
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
