export default function DocumentsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading documents">
      <div className="h-6 w-24 animate-pulse rounded bg-surface-elevated" />
      <div className="flex gap-2">
        <div className="h-10 flex-1 animate-pulse rounded-xl bg-surface-elevated" />
        <div className="h-10 w-24 animate-pulse rounded-xl bg-surface-elevated" />
        <div className="h-10 w-24 animate-pulse rounded-xl bg-surface-elevated" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="h-10 animate-pulse bg-surface-elevated" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse border-t border-border-subtle bg-background"
          />
        ))}
      </div>
    </section>
  );
}
