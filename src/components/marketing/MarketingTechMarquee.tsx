'use client';

import LogoLoop from '@/components/react-bits/LogoLoop';
import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  Atom,
  BrainCircuit,
  Cloud,
  Container,
  Database,
  FileCode,
  FlaskConical,
  KeyRound,
  Search,
  Table,
  Triangle,
  Wind,
  Zap,
} from 'lucide-react';

const ICON_MAP: Record<string, { Icon: LucideIcon; href: string }> = {
  Docker: { Icon: Container, href: 'https://www.docker.com' },
  Vercel: { Icon: Triangle, href: 'https://vercel.com' },
  'Next.js': { Icon: AppWindow, href: 'https://nextjs.org' },
  TypeScript: { Icon: FileCode, href: 'https://www.typescriptlang.org' },
  'Tailwind CSS': { Icon: Wind, href: 'https://tailwindcss.com' },
  React: { Icon: Atom, href: 'https://react.dev' },
  Ollama: { Icon: BrainCircuit, href: 'https://ollama.com' },
  Clerk: { Icon: KeyRound, href: 'https://clerk.com' },
  Cloudflare: { Icon: Cloud, href: 'https://www.cloudflare.com' },
  Neon: { Icon: Database, href: 'https://neon.tech' },
  Vitest: { Icon: FlaskConical, href: 'https://vitest.dev' },
  Drizzle: { Icon: Table, href: 'https://orm.drizzle.team' },
  Google: { Icon: Search, href: 'https://aistudio.google.com' },
  Upstash: { Icon: Zap, href: 'https://upstash.com' },
};

const MARQUEE_TECH = [
  'Docker',
  'Vercel',
  'Next.js',
  'TypeScript',
  'Tailwind CSS',
  'React',
  'Ollama',
  'Clerk',
  'Cloudflare',
  'Neon',
  'Vitest',
  'Drizzle',
  'Google',
  'Upstash',
];

export function MarketingTechMarquee() {
  const logos = MARQUEE_TECH.map((name) => {
    const { Icon, href } = ICON_MAP[name]!;
    return {
      node: <Icon className="h-11 w-11 text-muted-foreground" aria-hidden />,
      title: name,
      href,
    };
  });

  return (
    <section
      data-testid="landing-marquee"
      className="mt-14 w-full sm:mt-16"
    >
      <LogoLoop
        logos={logos}
        speed={80}
        direction="left"
        logoHeight={44}
        gap={56}
        scaleOnHover
        ariaLabel="Built with"
      />
    </section>
  );
}
