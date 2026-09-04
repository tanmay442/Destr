import type { ReactNode, CSSProperties, Key } from 'react';

export const ANIMATION_CONFIG = { SMOOTH_TAU: 0.25, MIN_COPIES: 2, COPY_HEADROOM: 2 };

type NodeLogoItem = {
  node: ReactNode;
  href?: string;
  title?: string;
  ariaLabel?: string;
};

type ImageLogoItem = {
  src: string;
  srcSet?: string;
  sizes?: string;
  width?: number | string;
  height?: number | string;
  alt?: string;
  title?: string;
  href?: string;
};

export type LogoItem = NodeLogoItem | ImageLogoItem;

export type Direction = 'left' | 'right' | 'up' | 'down';

export type LogoLoopProps = {
  logos: LogoItem[];
  speed?: number;
  direction?: Direction;
  width?: number | string;
  logoHeight?: number;
  gap?: number;
  pauseOnHover?: boolean;
  hoverSpeed?: number;
  fadeOut?: boolean;
  fadeOutColor?: string;
  scaleOnHover?: boolean;
  renderItem?: (item: LogoItem, key: Key) => ReactNode;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
};

export const toCssLength = (value: number | string | undefined): string | undefined =>
  typeof value === 'number' ? `${value}px` : (value ?? undefined);
