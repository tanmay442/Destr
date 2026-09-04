'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { BrandMark } from '@/components/icons/BrandMark';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetOverlay,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from '@/components/ui/sheet';

export function MobileSidebar({
  children,
}: {
  children: (close: () => void) => React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const close = useCallback(() => setMobileOpen(false), []);

  return (
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <header
        className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border-subtle bg-background/85 px-4 backdrop-blur-md md:hidden"
        data-testid="app-mobile-topbar"
      >
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open navigation"
            className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
            data-testid="app-mobile-hamburger"
          >
            <PanelLeft aria-hidden />
          </Button>
        </SheetTrigger>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
          data-testid="app-mobile-brand"
        >
          <BrandMark size="sm" />
          <span>Destr</span>
        </Link>
      </header>

      <SheetOverlay className="bg-black/60 backdrop-blur-sm md:hidden" />
      <SheetContent
          side="left"
          showCloseButton={false}
          className="fixed inset-y-0 left-0 z-50 flex h-full w-80 max-w-[85vw] flex-col gap-0 border-r border-border-subtle bg-card p-0 shadow-2xl outline-none data-[state=closed]:duration-300 data-[state=open]:duration-500 md:hidden"
          data-testid="app-mobile-drawer"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Primary navigation menu</SheetDescription>
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <Link
              href="/chat"
              onClick={() => setMobileOpen(false)}
              className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
            >
              <BrandMark size="sm" />
              <span>Destr</span>
            </Link>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <PanelLeft aria-hidden />
              </Button>
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children(close)}</div>
        </SheetContent>
    </Sheet>
  );
}
