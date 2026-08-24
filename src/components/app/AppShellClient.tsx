'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { PanelLeft } from 'lucide-react';
import { AppSidebar, type AppRole, type AppSidebarUser } from '@/components/app/AppSidebar';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'destr:sidebar-open';

let cachedOpen: boolean | null = null;
const listeners = new Set<() => void>();

function readOpen(): boolean {
  if (cachedOpen !== null) return cachedOpen;
  try {
    cachedOpen = window.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    cachedOpen = true;
  }
  return cachedOpen;
}

function writeOpen(next: boolean): void {
  cachedOpen = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
  }
  listeners.forEach((listener) => listener());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Sidebar visibility: expanded by default, persisted across visits. */
export function useSidebarOpen(): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, readOpen, () => true);
  const toggle = useCallback(() => writeOpen(!readOpen()), []);
  return [open, toggle];
}

export function AppShellClient({
  user,
  role,
  children,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  children: React.ReactNode;
}) {
  const [open, toggle] = useSidebarOpen();

  return (
    <>
      <AppSidebar user={user} role={role} open={open} onToggle={toggle} />
      {!open ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          aria-label="Open sidebar"
          className="fixed top-4 left-4 z-40 hidden text-muted-foreground hover:bg-surface-elevated hover:text-foreground md:inline-flex"
          data-testid="app-sidebar-reveal"
        >
          <PanelLeft aria-hidden />
        </Button>
      ) : null}
      <main
        className={`flex min-h-0 flex-1 flex-col pt-14 transition-[padding] duration-200 md:pt-0 ${
          open ? 'md:pl-72' : 'md:pl-0'
        }`}
        data-testid="app-main"
      >
        {children}
      </main>
    </>
  );
}
