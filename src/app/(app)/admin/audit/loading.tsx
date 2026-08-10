import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/admin/TableShell";

export default function AuditLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading audit log">
      <Skeleton className="h-6 w-24" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-xl" />
        ))}
      </div>
      <TableSkeleton rows={10} rowClassName="h-12" />
    </section>
  );
}
