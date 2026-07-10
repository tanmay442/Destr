export default function TicketsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading tickets">
      <div className="h-6 w-20 animate-pulse rounded bg-surface-elevated" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-surface-elevated" />
        ))}
      </div>
      <div className="overflow-hidden rounded border border-border-subtle">
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
