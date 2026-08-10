import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/admin/TableShell";

export default function DocumentsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading documents">
      <Skeleton className="h-6 w-24" />
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-xl" />
      </div>
      <TableSkeleton rows={8} />
    </section>
  );
}
