export default function AuditLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading audit log">
      <div className="h-6 w-24 animate-pulse rounded bg-surface-elevated" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 w-32 animate-pulse rounded-xl bg-surface-elevated" />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="h-10 animate-pulse bg-surface-elevated" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse border-t border-border-subtle bg-background"
          />
        ))}
      </div>
    </section>
  );
}
