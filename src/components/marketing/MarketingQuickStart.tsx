'use client';

import { useState } from 'react';
import { Copy } from 'lucide-react';
import { QUICK_START } from '@/components/marketing/marketing-content';

export function MarketingQuickStart() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(QUICK_START.commands.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section data-testid="landing-quickstart">
      <div className="relative rounded-lg border border-border-subtle bg-surface-sunken p-4 font-mono text-sm text-muted-foreground">
        <button
          type="button"
          onClick={handleCopy}
          className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-card/40 px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-surface-elevated"
          data-testid="landing-quickstart-copy"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>

        <div className="flex flex-col gap-1.5 pr-20">
          {QUICK_START.commands.map((command) => (
            <div key={command} className="whitespace-pre-wrap">
              <span className="select-none text-foreground-faint">$ </span>
              {command}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-3 text-xs text-foreground-subtle">{QUICK_START.note}</p>
    </section>
  );
}
