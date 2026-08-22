import { redirect } from 'next/navigation';
import { getAppSession } from '@/composition';
import { AppShellClient } from '@/components/app/AppShellClient';
import type { AppRole } from '@/components/app/AppSidebar';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAppSession();
  if (!session) {
    redirect('/sign-in');
  }
  const role: AppRole = (session.user.role as AppRole | undefined) ?? 'user';

  return (
    <AppShellClient
      user={{
        name: session.user.name,
        imageUrl: session.user.imageUrl,
        email: session.user.email,
      }}
      role={role}
    >
      {children}
    </AppShellClient>
  );
}
