import { requireAdmin } from '@/composition';

/**
 * Admin subtree layout. Runs the role guard, then frames page content;
 * the sidebar/drawer comes from the parent (app) layout.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div
      className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 md:py-10"
      data-testid="admin-content"
    >
      {children}
    </div>
  );
}
