interface AuditEvent {
  kind: string;
  id: number;
  at: Date;
  action: string;
  documentId: number | null;
  ticketId: string | null;
  actorName: string | null;
  actorId: string;
}

interface AuditEventListProps {
  events: AuditEvent[];
  testId: string;
}

export function AuditEventList({ events, testId }: AuditEventListProps) {
  if (events.length === 0) {
    return <p className="text-sm text-foreground-muted">No audit events yet.</p>;
  }
  return (
    <ul
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-3 text-sm"
      data-testid={testId}
    >
      {events.map((e) => (
        <li
          key={`${e.kind}-${e.id}`}
          className="flex flex-wrap gap-2"
        >
          <span className="text-xs text-foreground-muted">
            {e.at.toISOString()}
          </span>
          <span className="font-medium">{e.action}</span>
          <span className="text-foreground-muted">
            {e.kind === 'document'
              ? `document #${e.documentId}`
              : `ticket ${e.ticketId}`}
          </span>
          <span className="text-foreground-muted">
            by {e.actorName ?? e.actorId}
          </span>
        </li>
      ))}
    </ul>
  );
}
