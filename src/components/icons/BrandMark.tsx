// RAG Support brand mark: chat-bubble retrieval metaphor, strokeWidth 2.5 for 16px legibility.

interface BrandMarkProps {
  className?: string;
  /** Size of the square container. Default 28px (h-7). */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_MAP: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-12 w-12',
};

const ICON_SIZE_MAP: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
};

export function BrandMark({ className = '', size = 'sm' }: BrandMarkProps) {
  return (
    <span
      aria-hidden
      className={[
        'relative inline-flex items-center justify-center rounded-[10px] bg-primary/15 text-primary ring-1 ring-inset ring-primary/25',
        SIZE_MAP[size],
        className,
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={ICON_SIZE_MAP[size]}
        aria-hidden
      >
        <path d="M4 4h16v12H7l-3 4V4z" />
      </svg>
    </span>
  );
}
