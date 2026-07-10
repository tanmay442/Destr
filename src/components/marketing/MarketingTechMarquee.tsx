'use client';

import LogoLoop from '@/components/react-bits/LogoLoop';
import {
  SiDocker,
  SiVercel,
  SiNextdotjs,
  SiTypescript,
  SiTailwindcss,
  SiReact,
  SiOllama,
  SiClerk,
  SiCloudflare,
  SiNeon,
  SiVitest,
  SiDrizzle,
  SiGoogle,
  SiUpstash,
} from 'react-icons/si';
import type { ComponentType, SVGProps } from 'react';

const ICON_MAP: Record<
  string,
  { Icon: ComponentType<SVGProps<SVGSVGElement>>; href: string }
> = {
  Docker: { Icon: SiDocker, href: 'https://www.docker.com' },
  Vercel: { Icon: SiVercel, href: 'https://vercel.com' },
  'Next.js': { Icon: SiNextdotjs, href: 'https://nextjs.org' },
  TypeScript: { Icon: SiTypescript, href: 'https://www.typescriptlang.org' },
  'Tailwind CSS': { Icon: SiTailwindcss, href: 'https://tailwindcss.com' },
  React: { Icon: SiReact, href: 'https://react.dev' },
  Ollama: { Icon: SiOllama, href: 'https://ollama.com' },
  Clerk: { Icon: SiClerk, href: 'https://clerk.com' },
  Cloudflare: { Icon: SiCloudflare, href: 'https://www.cloudflare.com' },
  Neon: { Icon: SiNeon, href: 'https://neon.tech' },
  Vitest: { Icon: SiVitest, href: 'https://vitest.dev' },
  Drizzle: { Icon: SiDrizzle, href: 'https://orm.drizzle.team' },
  Google: { Icon: SiGoogle, href: 'https://aistudio.google.com' },
  Upstash: { Icon: SiUpstash, href: 'https://upstash.com' },
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
    const entry = ICON_MAP[name];
    if (entry) {
      const { Icon, href } = entry;
      return {
        node: <Icon className="h-11 w-11 text-foreground-muted" aria-hidden />,
        title: name,
        href,
      };
    }
    return {
      node: (
        <span className="font-medium tracking-tight text-foreground-muted">
          {name}
        </span>
      ),
      title: name,
    };
  });

  return (
    <section data-testid="landing-marquee">
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
