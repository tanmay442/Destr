'use client';

import Link from 'next/link';
import Image from 'next/image';
import { SignInButton } from '@clerk/nextjs';
import { ArrowRight } from 'lucide-react';
import BorderGlow from '@/components/marketing/BorderGlow';
import { Button, buttonVariants } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/utils';

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
        <div className="flex flex-col gap-3">
          <Image
            src="/logo.svg"
            alt=""
            aria-hidden
            width={48}
            height={48}
            className="size-12"
          />
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Get started
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Open the chat to talk with the assistant, or sign in to save your
              session history and track knowledge tickets.
            </p>
          </div>
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
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'w-full',
              )}
              data-testid="home-sign-in"
            >
              Sign in
            </button>
          </SignInButton>
        </div>

        <Eyebrow className="tracking-[0.12em] text-foreground-subtle">
          Auth by Clerk
        </Eyebrow>
      </div>
    </BorderGlow>
  );

  if (floating) {
    return <div className="auth-card-float">{card}</div>;
  }

  return card;
}
