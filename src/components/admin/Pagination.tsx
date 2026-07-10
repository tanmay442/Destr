import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

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
    <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
      <span>
        Page {page} of {totalPages} ({total} total)
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={{ pathname, query: { ...query, page: page - 1 } }}
            className={linkClassName}
          >
            Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={{ pathname, query: { ...query, page: page + 1 } }}
            className={linkClassName}
          >
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
