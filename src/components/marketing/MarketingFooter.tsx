import { GithubIcon } from '@/components/icons/GithubIcon';
import { FOOTER_LINKS } from '@/components/marketing/marketing-content';

export function MarketingFooter() {
  return (
    <footer
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border-subtle bg-background/90 backdrop-blur"
      data-testid="landing-footer"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-xs text-foreground-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>RAG Support — open-source AI customer support.</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {FOOTER_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.href.startsWith('http') ? '_blank' : undefined}
              rel={
                link.href.startsWith('http')
                  ? 'noopener noreferrer'
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-muted transition-colors duration-150 hover:bg-surface hover:text-foreground"
              data-testid={
                link.href ===
                'https://github.com/tanmay442/rag_agent'
                  ? 'landing-footer-source'
                  : undefined
              }
            >
              {link.label === 'Source' ? (
                <>
                  <GithubIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>view source</span>
                </>
              ) : (
                link.label
              )}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
