import { ChatInterface } from '@/components/ChatInterface';
import { requireSession } from '@/composition';

export default async function ChatPage() {
  await requireSession();
  return (
    <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="flex shrink-0 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface)]/70 px-2.5 py-0.5 text-[11px] font-medium text-[var(--foreground-muted)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
            </span>
            Online
          </span>
          <span className="text-[11px] font-medium text-[var(--foreground-subtle)]">
            Citations on · 30 messages / min
          </span>
        </div>
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-[var(--foreground)] sm:text-[1.7rem]">
          Support Chat
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--foreground-muted)]">
          Ask a question about your docs and the support agent will answer
          from the official documentation, with the source citation
          highlighted for every reply.
        </p>
      </header>

      <ChatInterface />
    </div>
  );
}
