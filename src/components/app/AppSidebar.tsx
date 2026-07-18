'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
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
  Settings,
  Menu,
  X,
  LogOut,
} from 'lucide-react';
import { BrandMark } from '@/components/icons/BrandMark';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  Sheet,
  SheetOverlay,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/upload', label: 'Upload', icon: Upload },
  { href: '/admin/documents', label: 'Documents', icon: FileText },
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart },
  { href: '/admin/audit', label: 'Audit Log', icon: ScrollText },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
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

  // Open by default on /admin/* so deep links show context, and
  // stay open when navigated to client-side. Remains toggdleable off-admin.
  const onAdmin = pathname?.startsWith('/admin') ?? false;
  const [adminToggled, setAdminToggled] = useState<boolean>(false);
  const adminOpen = onAdmin || adminToggled;

  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const handleNavigate = () => {
    setMobileOpen(false);
  };

  const toggleAdmin = () => {
    setAdminToggled((open) => !open);
  };

  const isActive = (href: string) => {
    if (!pathname) return false;
    if (href === '/chat') return pathname === '/chat';
    if (href === '/admin') return pathname === '/admin';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border-subtle bg-background/85 px-4 backdrop-blur-md md:hidden"
        data-testid="app-mobile-topbar"
      >
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
          data-testid="app-mobile-brand"
        >
          <BrandMark size="sm" />
          <span>RAG Support</span>
        </Link>

        <SheetTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Open navigation"
            className="rounded-lg bg-card/90 shadow-sm hover:bg-surface-elevated"
            data-testid="app-mobile-hamburger"
          >
            <Menu aria-hidden />
          </Button>
        </SheetTrigger>
      </header>

      <aside
        className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col md:border-r md:border-border-subtle md:bg-card/60 md:backdrop-blur-md"
        data-testid="app-sidebar"
      >
        <SidebarBody
          user={user}
          role={role}
          adminOpen={adminOpen}
          setAdminOpen={setAdminToggled}
          toggleAdmin={toggleAdmin}
          isActive={isActive}
          onNavigate={handleNavigate}
          onSignOut={() => signOut({ redirectUrl: '/' })}
        />
      </aside>

      <SheetOverlay className="bg-black/60 backdrop-blur-sm md:hidden" />
      <SheetContent
        side="left"
        showCloseButton={false}
        className="fixed inset-y-0 left-0 z-50 flex h-full w-72 max-w-[85vw] flex-col border-r border-border-subtle bg-card p-4 shadow-2xl outline-none data-[state=closed]:duration-300 data-[state=open]:duration-500 md:hidden"
        data-testid="app-mobile-drawer"
      >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Primary navigation menu
          </SheetDescription>
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
              Menu
            </span>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <X aria-hidden />
              </Button>
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarBody
              user={user}
              role={role}
              adminOpen={adminOpen}
              setAdminOpen={setAdminToggled}
              toggleAdmin={toggleAdmin}
              isActive={isActive}
              onNavigate={handleNavigate}
              onSignOut={() => signOut({ redirectUrl: '/' })}
            />
          </div>
        </SheetContent>
    </Sheet>
  );
}

function SidebarBody({
  user,
  role,
  adminOpen,
  setAdminOpen,
  toggleAdmin,
  isActive,
  onNavigate,
  onSignOut,
}: {
  user: AppSidebarUser | null;
  role: AppRole;
  adminOpen: boolean;
  setAdminOpen: (open: boolean) => void;
  toggleAdmin: () => void;
  isActive: (href: string) => boolean;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-border-subtle px-4">
        <Link
          href="/chat"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground"
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
          onNavigate={onNavigate}
        />

        {role === 'admin' ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleAdmin}
              aria-expanded={adminOpen}
              className={cn(
                'w-full justify-start gap-2.5 rounded-lg px-3',
                isActive('/admin')
                  ? 'bg-secondary text-foreground hover:bg-secondary hover:text-foreground'
                  : 'text-muted-foreground hover:bg-card hover:text-foreground'
              )}
              data-testid="app-sidebar-admin-toggle"
            >
              <LayoutDashboard className="shrink-0" aria-hidden />
              <span className="flex-1 text-left">Admin</span>
              <ChevronRight
                className={cn(
                  'text-foreground-subtle transition-transform duration-200',
                  adminOpen && 'rotate-90'
                )}
                aria-hidden
              />
            </Button>

            {adminOpen ? (
              <ul
                className="mt-1 ml-4 flex flex-col border-l border-border-subtle pl-3"
                data-testid="app-sidebar-admin-list"
              >
                {ADMIN_LINKS.map((link) => {
                  const Icon = link.icon;
                  return (
                    <li key={link.href}>
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className={cn(
                          'h-auto w-full justify-start gap-2.5 rounded-lg px-3 py-1.5',
                          isActive(link.href)
                            ? 'bg-secondary text-foreground hover:bg-secondary hover:text-foreground'
                            : 'text-muted-foreground hover:bg-card hover:text-foreground'
                        )}
                        data-testid={`app-sidebar-admin-${link.label
                          .toLowerCase()
                          .replace(/\s+/g, '-')}`}
                      >
                        <Link href={link.href} onClick={() => { setAdminOpen(true); onNavigate(); }}>
                          <Icon
                            className="shrink-0 text-foreground-subtle"
                            aria-hidden
                          />
                          <span>{link.label}</span>
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </nav>

      <div className="border-t border-border-subtle p-3">
        {user ? (
          <div
            className="flex items-center gap-2.5 rounded-lg px-2 py-2"
            data-testid="app-sidebar-user"
          >
            <Avatar className="size-8 shrink-0 ring-1 ring-border-subtle">
              {user.imageUrl ? (
                <AvatarImage
                  src={user.imageUrl}
                  alt={user.name ?? 'User avatar'}
                />
              ) : null}
              <AvatarFallback className="bg-surface-elevated text-xs font-semibold text-foreground">
                {(user.name ?? '?').charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {user.name ?? user.email}
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={onSignOut}
              className="h-auto gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              data-testid="app-sidebar-sign-out"
            >
              <LogOut aria-hidden />
              <span>Sign out</span>
            </Button>
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-foreground-subtle">
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
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  active: boolean;
  testId?: string;
  onNavigate: () => void;
}) {
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className={cn(
        'w-full justify-start gap-2.5 rounded-lg px-3',
        active
          ? 'bg-secondary text-foreground hover:bg-secondary hover:text-foreground'
          : 'text-muted-foreground hover:bg-card hover:text-foreground'
      )}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
    >
      <Link href={href} onClick={onNavigate}>
        <Icon className="shrink-0" aria-hidden />
        <span>{label}</span>
      </Link>
    </Button>
  );
}
