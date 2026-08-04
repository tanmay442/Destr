interface BrandMarkProps {
  className?: string;
  /** Size of the logo container. Default 42px (150% of the original 28px). */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_MAP: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'h-[42px] w-[42px]',
  md: 'h-[54px] w-[54px]',
  lg: 'h-[72px] w-[72px]',
};

export function BrandMark({ className = '', size = 'sm' }: BrandMarkProps) {
  return (
    <img
      src="/logo.svg"
      alt=""
      aria-hidden
      width={42}
      height={42}
      decoding="async"
      className={[SIZE_MAP[size], 'shrink-0', className].join(' ')}
      data-testid="brand-mark"
    />
  );
}