// Shown while the root layout resolves auth/data; route groups supply their own skeletons.
export default function RootLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      role="status"
      aria-label="Loading"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span className="text-sm text-foreground-muted">Loading…</span>
      </div>
    </div>
  );
}
