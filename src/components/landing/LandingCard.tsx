import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { ArrowRight, Sparkles, Zap, ShieldCheck } from 'lucide-react';

/**
 * "Get started" card: primary chat CTA + secondary sign-in. Kept a Server
 * Component; Clerk's SignInButton becomes interactive on hydration.
 */
export function LandingCard() {
  return (
    <div
      className="relative isolate rounded-2xl border border-white/10 bg-[var(--surface)]/60 p-6 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8"
      data-testid="landing-card"
    >
      {/* Soft accent glow behind the card, clipped to its rounded shape for depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl"
      >
        <div
          className="absolute -right-12 -top-12 h-56 w-56 rounded-full opacity-50 blur-3xl"
          style={{
            background:
              'radial-gradient(circle at center, var(--accent) 0%, transparent 65%)',
          }}
        />
      </div>

      <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>Try the demo</span>
      </div>

      <h2 className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">
        Get started
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--foreground-muted)]">
        Interact with the AI assistant directly or sign in to save
        your session history and track your support tickets.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        <Link
          href="/chat"
          className="group inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-[var(--accent-foreground)] shadow-lg shadow-[var(--accent)]/25 transition-all duration-[var(--dur-base)] ease-[var(--ease-out-quart)] hover:-translate-y-0.5 hover:bg-[var(--accent-hover)] hover:shadow-xl hover:shadow-[var(--accent)]/30 active:translate-y-0"
          data-testid="home-open-chat"
        >
          Open chat
          <ArrowRight
            className="h-4 w-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-out-quart)] group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 px-5 py-3 text-sm font-medium text-[var(--foreground)] backdrop-blur transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out-quart)] hover:bg-[var(--surface-elevated)]"
            data-testid="home-sign-in"
          >
            Sign in
          </button>
        </SignInButton>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-[var(--border-subtle)] pt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--foreground-subtle)]">
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
