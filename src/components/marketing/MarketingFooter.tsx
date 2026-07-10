import { GithubIcon } from '@/components/icons/GithubIcon';

const STACK = ['Next.js', 'Tailwind', 'AI SDK', 'pgvector'];

export function MarketingFooter() {
  return (
    <footer
      className="mt-16 border-t border-border-subtle"
      data-testid="landing-footer"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-xs text-foreground-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>RAG Support - personal portfolio project.</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-foreground-subtle">
            {STACK.join(' \u00b7 ')}
          </span>
          <span className="hidden h-3 w-px bg-border-subtle sm:inline-block" />
          <a
            href="https://github.com/tanmay442/rag_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-muted transition-colors duration-150 hover:bg-surface hover:text-foreground"
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
