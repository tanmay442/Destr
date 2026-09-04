'use client';

import type { ReactNode, Key } from 'react';
import type { LogoItem, LogoLoopProps } from './types';

export function renderLogoItem(item: LogoItem, key: Key, renderItem: LogoLoopProps['renderItem']): ReactNode {
  if (renderItem) {
    return (
      <li className="logoloop__item" key={key} role="listitem">
        {renderItem(item, key)}
      </li>
    );
  }
  const isNodeItem = 'node' in item;
  const content = isNodeItem ? (
    <span className="logoloop__node" aria-hidden={!!item.href && !item.ariaLabel}>
      {item.node}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- logos are arbitrary remote URLs with unknown dimensions; next/image would require remotePatterns config and fixed sizing that breaks the marquee.
    <img
      src={item.src}
      srcSet={item.srcSet}
      sizes={item.sizes}
      width={item.width}
      height={item.height}
      alt={item.alt ?? ''}
      title={item.title}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
  const itemAriaLabel = isNodeItem ? (item.ariaLabel ?? item.title) : (item.alt ?? item.title);
  const itemContent = item.href ? (
    <a className="logoloop__link" href={item.href} aria-label={itemAriaLabel || 'logo link'} target="_blank" rel="noreferrer noopener">
      {content}
    </a>
  ) : (
    content
  );
  return (
    <li className="logoloop__item" key={key} role="listitem">
      {itemContent}
    </li>
  );
}
