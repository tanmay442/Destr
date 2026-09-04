'use client';

import { memo, type ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAllowedUrl } from '@/lib/isAllowedUrl';

export const MemoMarkdown = memo(function MemoMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: SafeLink }}>
      {text}
    </Markdown>
  );
});

function SafeLink({ href, children, ...props }: ComponentProps<'a'>) {
  const url = typeof href === 'string' ? href.trim() : '';
  if (!isAllowedUrl(url)) {
    return <span {...props}>{children}</span>;
  }
  return (
    <a {...props} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
