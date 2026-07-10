import { ChatInterface } from '@/components/ChatInterface';
import { requireSession } from '@/composition';
import { Badge } from '@/components/ui/badge';

export default async function ChatPage() {
  await requireSession();
  return (
    <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="flex shrink-0 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="gap-1.5 rounded-full border-border-subtle bg-card/70 px-2.5 py-0.5 text-[11px] text-muted-foreground"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            Online
          </Badge>
          <span className="text-[11px] font-medium text-foreground-subtle">
            Citations on · 30 messages / min
          </span>
        </div>
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-[1.7rem]">
          Support Chat
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Ask a question about your docs and the support agent will answer
          from the official documentation, with the source citation
          highlighted for every reply.
        </p>
      </header>

      <ChatInterface />
    </div>
  );
}
