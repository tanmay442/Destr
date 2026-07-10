import { Check, Info } from 'lucide-react';

const FEATURES: { title: string; description: string }[] = [
  {
    title: 'Grounded Answers',
    description:
      'RAG-based context retrieval with high-accuracy vector semantic citations.',
  },
  {
    title: 'Multi-step Workflows',
    description:
      'Dynamically clarifies vague prompts, searches docs, and synthesizes answers.',
  },
  {
    title: 'Human Escalation',
    description:
      'Creates a structured support ticket when the documentation cannot solve the query.',
  },
  {
    title: 'Serverless Architecture',
    description:
      'Built entirely on edge-ready, pay-as-you-go serverless infrastructure.',
  },
];

export function MarketingHero() {
  return (
    <section className="flex flex-col gap-6" data-testid="landing-left">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
        SERVERLESS &middot; GROUNDED &middot; ESCALATION-READY
      </p>

      <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-[3.25rem] sm:leading-[1.05]">
        Serverless AI customer support.
      </h1>

      <p className="max-w-xl text-pretty text-base leading-relaxed text-foreground-muted sm:text-lg">
        A personal portfolio project showcasing a
        retrieval-augmented generation (RAG) agent that answers
        questions with cited documentation, resolves ambiguous
        requests, and escalates to a human support ticket in one
        click.
      </p>

      <ul className="mt-2 flex flex-col gap-3">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className="flex items-start gap-3 text-sm leading-relaxed"
          >
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent ring-1 ring-inset ring-accent/25"
            >
              <Check className="h-3 w-3" aria-hidden />
            </span>
            <p className="text-foreground-muted">
              <span className="font-semibold text-foreground">
                {feature.title}
              </span>
              <span className="mx-1.5 text-foreground-faint">
                &mdash;
              </span>
              <span>{feature.description}</span>
            </p>
          </li>
        ))}
      </ul>

      <div
        className="mt-4 flex items-start gap-2.5 rounded-lg border border-border-subtle bg-surface/40 px-4 py-3 text-xs italic text-foreground-muted backdrop-blur"
        role="note"
        data-testid="landing-demo-notice"
      >
        <Info
          className="mt-0.5 h-3.5 w-3.5 shrink-0 not-italic text-foreground-subtle"
          aria-hidden
        />
        <p>
          <span className="not-italic font-semibold text-foreground">
            Demo notice:
          </span>{' '}
          This is a personal portfolio project. While fully functional,
          tickets created during your session are stored in a demo
          sandbox environment.
        </p>
      </div>
    </section>
  );
}
