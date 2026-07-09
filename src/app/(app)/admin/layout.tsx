import { requireAdmin } from '@/composition';

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
