import Link from 'next/link';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { BrandMark } from '@/components/icons/BrandMark';

/**
 * Landing-page header (brand left; project note + GitHub link right).
 * Minimal by design: no nav/auth since the card carries the primary CTAs.
 */
export function LandingHeader() {
  return (
    <header
      className="sticky top-0 z-30 w-full border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md"
      data-testid="landing-header"
    >
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="group inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[var(--foreground)]"
          data-testid="landing-header-brand"
        >
          <BrandMark size="sm" />
          <span>RAG Support</span>
        </Link>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="hidden text-xs text-[var(--foreground-muted)] sm:inline">
            Personal Next.js project
          </span>
          <a
            href="https://github.com/tanmay442/rag_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--foreground-muted)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
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
