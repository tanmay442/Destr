'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ADMIN_LINKS } from './types';

export function AdminLink({ link }: { link: (typeof ADMIN_LINKS)[number] }) {
  const pathname = usePathname();
  const Icon = link.icon;
  const active = pathname === link.href || pathname?.startsWith(`${link.href}/`) || false;
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className={cn(
        'h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5',
        active
          ? 'bg-secondary text-foreground hover:bg-secondary hover:text-foreground'
          : 'text-muted-foreground hover:bg-card hover:text-foreground',
      )}
      data-testid={`app-sidebar-admin-${link.label.toLowerCase().replace(/\s+/g, '-')}`}
      aria-current={active ? 'page' : undefined}
    >
      <Link href={link.href}>
        <Icon className="shrink-0 text-foreground-subtle" aria-hidden />
        <span>{link.label}</span>
      </Link>
    </Button>
  );
}
