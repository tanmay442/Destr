import { GithubIcon } from '@/components/icons/GithubIcon';

const STACK = ['Next.js', 'Tailwind', 'AI SDK', 'pgvector'];

/**
 * Landing footer. The tech list is a non-linked visual badge
 * ("built with") for a quick scannable overview.
 */
export function LandingFooter() {
  return (
    <footer
      className="mt-16 border-t border-[var(--border-subtle)]"
      data-testid="landing-footer"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-xs text-[var(--foreground-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>RAG Support - personal portfolio project.</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[var(--foreground-subtle)]">
            {STACK.join(' \u00b7 ')}
          </span>
          <span className="hidden h-3 w-px bg-[var(--border-subtle)] sm:inline-block" />
          <a
            href="https://github.com/tanmay442/rag_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
            data-testid="landing-footer-source"
          >
            <GithubIcon className="h-3.5 w-3.5" aria-hidden />
            <span>view source</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
