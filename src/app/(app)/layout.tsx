import { redirect } from 'next/navigation';
import { getAppSession } from '@/composition';
import { AppSidebar, type AppRole } from '@/components/app/AppSidebar';

/**
 * Authenticated app shell: renders the responsive sidebar and reserves
 * `md:pl-64` for page content. Session resolves here; page guards still run per subtree.
 */
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
    <>
      <AppSidebar
        user={{
          name: session.user.name,
          imageUrl: session.user.imageUrl,
          email: session.user.email,
        }}
        role={role}
      />
      <main
        className="flex min-h-0 flex-1 flex-col md:pl-64"
        data-testid="app-main"
      >
        {children}
      </main>
    </>
  );
}
