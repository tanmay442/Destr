import { getComposition, unwrap } from '@/composition';
import { StatCard } from '@/components/admin/StatCard';
import { AuditEventList } from '@/components/admin/AuditEventList';

// Relies on AdminLayout's requireAdmin() guard; add an explicit guard if decoupled.

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const comp = getComposition();
  const summary = unwrap(await comp.getAnalyticsSummary());
  const audit = unwrap(await comp.listAudit({ limit: 10 }));
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-medium">Overview</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          href="/admin/documents"
          label="Documents"
          value={summary.documentCount}
          testId="admin-card-documents"
        />
        <StatCard
          href="/admin/documents"
          label="Chunks"
          value={summary.chunkCount}
          testId="admin-card-chunks"
        />
        <StatCard
          href="/admin/tickets"
          label="Tickets"
          value={summary.ticketCount}
          testId="admin-card-tickets"
        />
        <StatCard
          href="/admin/tickets"
          label="Open tickets"
          value={summary.openTicketCount}
          testId="admin-card-open-tickets"
        />
        <StatCard
          href="/admin/users"
          label="Users"
          value={summary.usersCount}
          testId="admin-card-users"
        />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Latest audit events</h3>
        <AuditEventList events={audit.events} testId="admin-latest-audit" />
      </div>
    </section>
  );
}

