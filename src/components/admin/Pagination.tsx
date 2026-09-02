import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  nextCursor: string | null;
  previousCursor: string | null;
  pathname: string;
  query: Record<string, string | number | undefined>;
  linkClassName?: string;
}

const defaultLinkClass = buttonVariants({ variant: 'outline', size: 'sm' });
const paginationQueryKeys = new Set(['page', 'offset', 'cursor', 'before']);

function buildPaginationQuery(
  query: Record<string, string | number | undefined>,
  page: number,
  cursorKey: 'cursor' | 'before' | null,
  cursor: string | null,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (paginationQueryKeys.has(key) || value === undefined) continue;
    result[key] = value;
  }
  result.page = page;
  if (cursorKey !== null && cursor !== null) result[cursorKey] = cursor;
  return result;
}

export function Pagination({
  page,
  totalPages,
  total,
  nextCursor,
  previousCursor,
  pathname,
  query,
  linkClassName = defaultLinkClass,
}: PaginationProps) {
  const pageCount = Math.max(totalPages, 1);
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const canPrevious = previousCursor !== null;
  const canNext = nextCursor !== null;
  const previousQuery = buildPaginationQuery(query, Math.max(safePage - 1, 1), 'before', previousCursor);
  const nextQuery = buildPaginationQuery(query, Math.min(safePage + 1, pageCount), 'cursor', nextCursor);
  return (
    <nav
      className="flex flex-col-reverse items-stretch gap-2 text-sm sm:flex-row sm:items-center sm:justify-between"
      aria-label="Pagination"
    >
      <span className="text-muted-foreground tabular-nums">
        Page <span className="text-foreground">{safePage}</span> of {pageCount} ·{' '}
        {total.toLocaleString()} total
      </span>
      <div className="flex items-center gap-2">
        {canPrevious ? (
          <Link
            href={{ pathname, query: previousQuery }}
            className={cn(linkClassName)}
            aria-label="Previous page"
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Link>
        ) : (
          <span
            className={cn(linkClassName, 'pointer-events-none opacity-50')}
            aria-disabled="true"
            aria-label="Previous page"
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </span>
        )}
        {canNext ? (
          <Link
            href={{ pathname, query: nextQuery }}
            className={cn(linkClassName)}
            aria-label="Next page"
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Link>
        ) : (
          <span
            className={cn(linkClassName, 'pointer-events-none opacity-50')}
            aria-disabled="true"
            aria-label="Next page"
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </span>
        )}
      </div>
    </nav>
  );
}
