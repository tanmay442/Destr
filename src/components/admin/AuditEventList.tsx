import { Card } from '@/components/ui/card';

interface AuditEvent {
  kind: string;
  id: number;
  at: Date;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorName: string | null;
  actorId: string;
}

export function auditTargetLabel(e: Pick<AuditEvent, 'kind' | 'targetId'>): string {
  switch (e.kind) {
    case 'document':
      return `document #${e.targetId ?? '?'}`;
    case 'ticket':
      return `ticket ${e.targetId ?? '?'}`;
    case 'user':
      return `user ${e.targetId ?? '?'}`;
    case 'settings':
      return 'settings';
    default:
      return e.targetId ?? '';
  }
}

interface AuditEventListProps {
  events: AuditEvent[];
  testId: string;
}

export function AuditEventList({ events, testId }: AuditEventListProps) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No audit events yet.</p>;
  }
  return (
    <Card className="gap-1 p-3 shadow-none" data-testid={testId}>
      <ul className="flex flex-col gap-1 text-sm">
        {events.map((e) => (
          <li key={`${e.kind}-${e.id}`} className="flex flex-wrap gap-2">
            <span className="text-xs text-muted-foreground">
              {e.at.toISOString()}
            </span>
            <span className="font-medium">{e.action}</span>
            <span className="text-muted-foreground">{auditTargetLabel(e)}</span>
            <span className="text-muted-foreground">
              by {e.actorName ?? e.actorId}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
