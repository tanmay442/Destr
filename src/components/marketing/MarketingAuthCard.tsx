'use client';

import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { ArrowRight } from 'lucide-react';
import BorderGlow from '@/components/react-bits/BorderGlow';

type MarketingAuthCardProps = {
  floating?: boolean;
};

export function MarketingAuthCard({ floating = false }: MarketingAuthCardProps) {
  const card = (
    <BorderGlow
      edgeSensitivity={35}
      glowColor="0 0 85"
      backgroundColor="rgba(20, 20, 20, 0.85)"
      borderRadius={16}
      glowRadius={28}
      colors={['#f5f5f5', '#a3a3a3', '#525252']}
      className="backdrop-blur-md"
    >
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Get started
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
            Open the chat to talk with the assistant, or sign in to save your
            session history and track support tickets.
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          <Link
            href="/chat"
            className="group inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-neutral-900 transition-all duration-200 ease-out-quart hover:-translate-y-0.5 hover:bg-neutral-200 active:translate-y-0"
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
              className="rounded-xl border border-border bg-surface/40 px-5 py-3 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-surface-elevated"
              data-testid="home-sign-in"
            >
              Sign in
            </button>
          </SignInButton>
        </div>

        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-foreground-subtle">
          Auth by Clerk
        </p>
      </div>
    </BorderGlow>
  );

  if (floating) {
    return <div className="auth-card-float">{card}</div>;
  }

  return card;
}
