import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/admin/TableShell";

export default function UsersLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading users">
      <Skeleton className="h-6 w-20" />
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-xl" />
        <Skeleton className="h-10 w-20 rounded-xl" />
      </div>
      <TableSkeleton rows={10} />
    </section>
  );
}
