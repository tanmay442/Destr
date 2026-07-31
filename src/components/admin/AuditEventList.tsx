import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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

function formatRelative(at: Date): string {
  const now = Date.now();
  const diff = Math.max(0, now - at.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return at.toISOString().slice(0, 10);
}

interface AuditEventListProps {
  events: AuditEvent[];
  testId: string;
}

export function AuditEventList({ events, testId }: AuditEventListProps) {
  if (events.length === 0) {
    return (
      <Card className="border-dashed p-6 text-center text-sm text-muted-foreground shadow-none">
        No audit events yet.
      </Card>
    );
  }
  return (
    <Card className="gap-0 p-0 shadow-none" data-testid={testId}>
      <ul className="divide-y divide-border-subtle">
        {events.map((e) => (
          <li
            key={`${e.kind}-${e.id}`}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2"
          >
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              <Badge variant="outline" className="font-normal text-foreground-faint">
                {e.kind}
              </Badge>
              <time dateTime={e.at.toISOString()} title={e.at.toISOString()}>
                {formatRelative(e.at)}
              </time>
            </span>
            <span className="text-sm font-medium text-foreground">{e.action}</span>
            <span className="text-sm text-muted-foreground">{auditTargetLabel(e)}</span>
            <span className="text-xs text-muted-foreground">
              by <span className="text-foreground/80">{e.actorName ?? e.actorId}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
