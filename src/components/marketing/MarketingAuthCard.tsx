'use client';

import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { ArrowRight } from 'lucide-react';
import BorderGlow from '@/components/react-bits/BorderGlow';
import { Button } from '@/components/ui/button';

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
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Open the chat to talk with the assistant, or sign in to save your
            session history and track support tickets.
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          <Button asChild size="lg" className="w-full rounded-xl" data-testid="home-open-chat">
            <Link href="/chat">
              Open chat
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>

          <SignInButton mode="modal">
            <button
              type="button"
              className="inline-flex w-full items-center justify-center rounded-xl border border-border bg-card/40 px-5 py-3 text-sm font-medium text-foreground transition-colors duration-150 hover:border-primary/50 hover:bg-surface-elevated"
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
