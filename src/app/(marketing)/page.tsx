import { Check, Info } from 'lucide-react';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LandingCard } from '@/components/landing/LandingCard';
import { LandingFooter } from '@/components/landing/LandingFooter';

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

export default function MarketingHome() {
  return (
    <>
      <LandingHeader />

      <main
        className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-16 sm:py-24"
        data-testid="landing-main"
      >
        {/* Background depth: a single accent wash + a faint grid mask,
            matching the rest of the app's visual vocabulary. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute left-1/2 top-1/3 h-[520px] w-[520px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
            style={{
              background:
                'radial-gradient(circle at center, var(--accent) 0%, transparent 65%)',
            }}
          />
          <div
            className="absolute inset-0 opacity-[0.035]"
            style={{
              backgroundImage:
                'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
              backgroundSize: '32px 32px',
              maskImage:
                'radial-gradient(ellipse at center, black 30%, transparent 70%)',
              WebkitMaskImage:
                'radial-gradient(ellipse at center, black 30%, transparent 70%)',
            }}
          />
        </div>

        <div className="grid w-full max-w-6xl grid-cols-1 gap-12 md:grid-cols-[3fr_2fr] md:gap-14 lg:gap-20">
          <section
            className="flex flex-col gap-6"
            data-testid="landing-left"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-subtle)]">
              SERVERLESS &middot; GROUNDED &middot; ESCALATION-READY
            </p>

            <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--foreground)] sm:text-[3.25rem] sm:leading-[1.05]">
              Serverless AI customer support.
            </h1>

            <p className="max-w-xl text-pretty text-base leading-relaxed text-[var(--foreground-muted)] sm:text-lg">
              A personal portfolio project showcasing a
              retrieval-augmented generation (RAG) agent that
              answers questions with cited documentation, resolves
              ambiguous requests, and escalates to a human support
              ticket in one click.
            </p>

            <ul className="mt-2 flex flex-col gap-3">
              {FEATURES.map((feature) => (
                <li
                  key={feature.title}
                  className="flex items-start gap-3 text-sm leading-relaxed"
                >
                  <span
                    aria-hidden
                    className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/25"
                  >
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                  <p className="text-[var(--foreground-muted)]">
                    <span className="font-semibold text-[var(--foreground)]">
                      {feature.title}
                    </span>
                    <span className="mx-1.5 text-[var(--foreground-faint)]">
                      &mdash;
                    </span>
                    <span>{feature.description}</span>
                  </p>
                </li>
              ))}
            </ul>

            <div
              className="mt-4 flex items-start gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)]/40 px-4 py-3 text-xs italic text-[var(--foreground-muted)] backdrop-blur"
              role="note"
              data-testid="landing-demo-notice"
            >
              <Info
                className="mt-0.5 h-3.5 w-3.5 shrink-0 not-italic text-[var(--foreground-subtle)]"
                aria-hidden
              />
              <p>
                <span className="not-italic font-semibold text-[var(--foreground)]">
                  Demo notice:
                </span>{' '}
                This is a personal portfolio project. While fully
                functional, tickets created during your session are
                stored in a demo sandbox environment.
              </p>
            </div>
          </section>

          <section
            className="flex items-center"
            data-testid="landing-right"
          >
            <LandingCard />
          </section>
        </div>
      </main>

      <LandingFooter />
    </>
  );
}
