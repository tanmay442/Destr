'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import {
  MessageSquare,
  ChevronRight,
  LayoutDashboard,
  Upload,
  FileText,
  Inbox,
  Users,
  BarChart,
  ScrollText,
  Menu,
  X,
  LogOut,
} from 'lucide-react';
import { BrandMark } from '@/components/icons/BrandMark';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/upload', label: 'Upload', icon: Upload },
  { href: '/admin/documents', label: 'Documents', icon: FileText },
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart },
  { href: '/admin/audit', label: 'Audit Log', icon: ScrollText },
] as const;

export type AppRole = 'admin' | 'user';

export interface AppSidebarUser {
  name: string;
  imageUrl: string | null;
  email?: string;
}

export function AppSidebar({
  user,
  role,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
}) {
  const pathname = usePathname();
  const { signOut } = useClerk();

  // Admin accordion: open by default on /admin/* so deep links show context,
  // but the user can collapse it; it reopens automatically on the next admin visit.
  const onAdmin = pathname?.startsWith('/admin') ?? false;
  const [adminOpen, setAdminOpen] = useState<boolean>(onAdmin);
  // Rerender-derived reset: when the route goes non-admin → admin, reopen the
  // accordion via the "adjust state in render" pattern (no effect).
  const [prevOnAdmin, setPrevOnAdmin] = useState<boolean>(onAdmin);
  if (prevOnAdmin !== onAdmin) {
    setPrevOnAdmin(onAdmin);
    if (onAdmin) setAdminOpen(true);
  }


  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  // Close the mobile drawer on route change using the same render-derived pattern (no effect).
  const [lastPath, setLastPath] = useState<string | null>(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, [mobileOpen]);

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // Toggle the admin accordion (a no-op when off /admin/*).
  const toggleAdmin = () => {
    setAdminOpen((open) => !open);
  };

  const isActive = (href: string) => {
    if (!pathname) return false;
    if (href === '/chat') return pathname === '/chat';
    if (href === '/admin') return pathname === '/admin';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      {/* Mobile top bar (below md): brand left, single hamburger right. */}
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--background)]/85 px-4 backdrop-blur-md md:hidden"
        data-testid="app-mobile-topbar"
      >
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[var(--foreground)]"
          data-testid="app-mobile-brand"
        >
          <BrandMark size="sm" />
          <span>RAG Support</span>
        </Link>

        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="app-mobile-drawer"
          onClick={() => setMobileOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)]/90 text-[var(--foreground)] shadow-sm transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-elevated)]"
          data-testid="app-mobile-hamburger"
        >
          <Menu className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {/* Desktop sidebar: fixed left, full height; hidden below md. */}
      <aside
        className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col md:border-r md:border-[var(--border-subtle)] md:bg-[var(--surface)]/60 md:backdrop-blur-md"
        data-testid="app-sidebar"
      >
        <SidebarBody
          user={user}
          role={role}
          adminOpen={adminOpen}
          toggleAdmin={toggleAdmin}
          isActive={isActive}
          onSignOut={() => signOut({ redirectUrl: '/' })}
        />
      </aside>

      {/* Mobile drawer overlay; hidden at md+. */}
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-50 md:hidden"
          data-testid="app-mobile-drawer"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          {/* TODO: Add a focus trap so keyboard focus stays within the drawer when open. */}
          <nav
            id="app-mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex h-full w-72 max-w-[85vw] flex-col border-r border-[var(--border-subtle)] bg-[var(--surface)] p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-subtle)]">
                Menu
              </span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--foreground-muted)] transition-colors hover:bg-[var(--surface-elevated)] hover:text-[var(--foreground)]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarBody
                user={user}
                role={role}
                adminOpen={adminOpen}
                toggleAdmin={toggleAdmin}
                isActive={isActive}
                onSignOut={() => signOut({ redirectUrl: '/' })}
              />
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}

function SidebarBody({
  user,
  role,
  adminOpen,
  toggleAdmin,
  isActive,
  onSignOut,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  adminOpen: boolean;
  toggleAdmin: () => void;
  isActive: (href: string) => boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-[var(--border-subtle)] px-4">
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[var(--foreground)]"
          data-testid="app-sidebar-brand"
        >
          <BrandMark size="sm" />
          <span>RAG Support</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto p-3" aria-label="Primary">
        <NavItem
          href="/chat"
          label="Chat"
          icon={MessageSquare}
          active={isActive('/chat')}
          testId="app-sidebar-chat"
        />

        {role === 'admin' ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={toggleAdmin}
              aria-expanded={adminOpen}
              className={[
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-[var(--dur-fast)]',
                isActive('/admin')
                  ? 'bg-[var(--surface-elevated)] text-[var(--foreground)]'
                  : 'text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]',
              ].join(' ')}
              data-testid="app-sidebar-admin-toggle"
            >
              <LayoutDashboard
                className="h-4 w-4 shrink-0"
                aria-hidden
              />
              <span className="flex-1 text-left">Admin</span>
              <ChevronRight
                className={[
                  'h-3.5 w-3.5 text-[var(--foreground-subtle)] transition-transform duration-[var(--dur-base)]',
                  adminOpen ? 'rotate-90' : '',
                ].join(' ')}
                aria-hidden
              />
            </button>

            {adminOpen ? (
              <ul
                className="mt-1 ml-4 flex flex-col border-l border-[var(--border-subtle)] pl-3"
                data-testid="app-sidebar-admin-list"
              >
                {ADMIN_LINKS.map((link) => {
                  const Icon = link.icon;
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className={[
                          'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors duration-[var(--dur-fast)]',
                          isActive(link.href)
                            ? 'bg-[var(--surface-elevated)] text-[var(--foreground)]'
                            : 'text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]',
                        ].join(' ')}
                        data-testid={`app-sidebar-admin-${link.label
                          .toLowerCase()
                          .replace(/\s+/g, '-')}`}
                      >
                        <Icon
                          className="h-3.5 w-3.5 shrink-0 text-[var(--foreground-subtle)]"
                          aria-hidden
                        />
                        <span>{link.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </nav>

      <div className="border-t border-[var(--border-subtle)] p-3">
        {user ? (
          <div
            className="flex items-center gap-2.5 rounded-lg px-2 py-2"
            data-testid="app-sidebar-user"
          >
            {user.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.imageUrl}
                alt={user.name ?? 'User avatar'}
                className="h-8 w-8 shrink-0 rounded-full ring-1 ring-[var(--border-subtle)]"
              />
            ) : (
              <span
                aria-hidden
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-xs font-semibold text-[var(--foreground)]"
              >
                {(user.name ?? '?').charAt(0).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--foreground)]">
              {user.name ?? user.email}
            </span>
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--foreground-muted)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-elevated)] hover:text-[var(--foreground)]"
              data-testid="app-sidebar-sign-out"
            >
              <LogOut className="h-3 w-3" aria-hidden />
              <span>Sign out</span>
            </button>
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-[var(--foreground-subtle)]">
            Not signed in
          </p>
        )}
      </div>
    </div>
  );
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  testId,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  active: boolean;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      className={[
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-[var(--dur-fast)]',
        active
          ? 'bg-[var(--surface-elevated)] text-[var(--foreground)]'
          : 'text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]',
      ].join(' ')}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span>{label}</span>
    </Link>
  );
}
