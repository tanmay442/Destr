import Link from 'next/link';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { BrandMark } from '@/components/icons/BrandMark';

export function MarketingHeader() {
  return (
    <header
      className="sticky top-0 z-30 w-full border-b border-border-subtle bg-background/80 backdrop-blur-md"
      data-testid="landing-header"
    >
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="group inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
          data-testid="landing-header-brand"
        >
          <BrandMark size="sm" />
          <span>RAG Support</span>
        </Link>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="hidden text-xs text-foreground-muted sm:inline">
            Personal Next.js project
          </span>
          <a
            href="https://github.com/tanmay442/rag_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-foreground-muted transition-colors duration-150 hover:bg-surface hover:text-foreground"
            data-testid="landing-header-github"
          >
            <GithubIcon className="h-3.5 w-3.5" aria-hidden />
            <span>tanmay442</span>
          </a>
        </div>
      </div>
    </header>
  );
}
