interface BrandMarkProps {
  className?: string;
  /** Size of the logo container. Default 28px (h-7). */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_MAP: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-12 w-12',
};

export function BrandMark({ className = '', size = 'sm' }: BrandMarkProps) {
  return (
    <img
      src="/logo.svg"
      alt=""
      aria-hidden
      width={28}
      height={28}
      decoding="async"
      className={[SIZE_MAP[size], 'shrink-0', className].join(' ')}
      data-testid="brand-mark"
    />
  );
}