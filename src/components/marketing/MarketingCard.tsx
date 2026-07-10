import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { ArrowRight, Sparkles, Zap, ShieldCheck } from 'lucide-react';

// Server Component; Clerk's SignInButton hydrates to interactive.
export function MarketingCard() {
  return (
    <div
      className="relative isolate rounded-2xl border border-white/10 bg-surface/60 p-6 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8"
      data-testid="landing-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl"
      >
        <div
          className="absolute -right-12 -top-12 h-56 w-56 rounded-full bg-[radial-gradient(circle_at_center,var(--accent)_0%,transparent_65%)] opacity-50 blur-3xl"
        />
      </div>

      <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>Try the demo</span>
      </div>

      <h2 className="text-2xl font-semibold tracking-tight text-foreground">
        Get started
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
        Interact with the AI assistant directly or sign in to save
        your session history and track your support tickets.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        <Link
          href="/chat"
          className="group inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-lg shadow-accent/25 transition-all duration-200 ease-out-quart hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-xl hover:shadow-accent/30 active:translate-y-0"
          data-testid="home-open-chat"
        >
          Open chat
          <ArrowRight
            className="h-4 w-4 transition-transform duration-200 ease-out-quart group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded-xl border border-border bg-surface/40 px-5 py-3 text-sm font-medium text-foreground backdrop-blur transition-colors duration-150 ease-out-quart hover:bg-surface-elevated"
            data-testid="home-sign-in"
          >
            Sign in
          </button>
        </SignInButton>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-border-subtle pt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground-subtle">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Auth by Clerk
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Zap className="h-3 w-3" aria-hidden />
          Edge-runtime enabled
        </span>
      </div>
    </div>
  );
}
