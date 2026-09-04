import {
  LayoutDashboard,
  FileText,
  Inbox,
  Users,
  BarChart3,
  ScrollText,
  Settings,
} from 'lucide-react';

export const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/documents', label: 'Documents', icon: FileText },
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
] as const;

export type AppRole = 'admin' | 'user';

export interface AppSidebarUser {
  name: string;
  imageUrl: string | null;
  email?: string;
}

export interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
}

export type SidebarSection = 'chat' | 'admin';
