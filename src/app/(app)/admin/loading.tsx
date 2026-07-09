// Generic admin loading skeleton shown while the page fetches data.
export default function AdminLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading admin page">
      <div className="h-6 w-32 animate-pulse rounded bg-[var(--surface-elevated)]" />
      <div className="flex gap-2">
        <div className="h-10 flex-1 animate-pulse rounded-xl bg-[var(--surface-elevated)]" />
        <div className="h-10 w-24 animate-pulse rounded-xl bg-[var(--surface-elevated)]" />
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="h-10 animate-pulse bg-[var(--surface-elevated)]" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse border-t border-[var(--border-subtle)] bg-[var(--background)]"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </section>
  );
}
