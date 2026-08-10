import type { AuditEventRecord } from '@app/domain';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  SettingsRevertButton,
  type SettingsChange,
} from '@/components/admin/settings-revert-button';
import { TableShell, TableEmptyRow } from '@/components/admin/TableShell';

export function auditTargetLabel(
  e: Pick<AuditEventRecord, 'kind' | 'targetId'>,
): string {
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

function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function settingsChanges(details: Record<string, unknown>): SettingsChange[] {
  const changes = details.changes;
  return Array.isArray(changes) ? (changes as SettingsChange[]) : [];
}

function EventDetails({
  kind,
  details,
}: {
  kind: AuditEventRecord['kind'];
  details: Record<string, unknown>;
}) {
  if (kind === 'user') {
    return (
      <span className="flex items-center gap-1.5">
        <Badge variant="outline" className="font-normal">
          {formatValue(details.fromRole)}
        </Badge>
        <span aria-hidden className="text-foreground-faint">→</span>
        <Badge variant="outline" className="font-normal">
          {formatValue(details.toRole)}
        </Badge>
      </span>
    );
  }
  if (kind === 'settings') {
    const changes = settingsChanges(details);
    return (
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {changes.map((c) => (
            <li key={c.key} className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-medium text-foreground">{c.key}</span>
              <span className="font-mono text-xs text-muted-foreground">
                <span className="line-through opacity-70">{formatValue(c.old)}</span>
                <span className="mx-1 text-foreground-faint" aria-hidden>→</span>
                <span className="text-foreground">{formatValue(c.new)}</span>
              </span>
            </li>
          ))}
        </ul>
        <div>
          <SettingsRevertButton changes={changes} />
        </div>
      </div>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function kindBadgeClass(kind: AuditEventRecord['kind']): string {
  switch (kind) {
    case 'document':
      return 'border-primary/40 text-primary';
    case 'ticket':
      return 'border-warning/40 text-warning';
    case 'user':
      return 'border-accent-info/40 text-accent-info';
    case 'settings':
      return 'border-border text-muted-foreground';
  }
}

export function AuditLogTable({
  events,
  testId,
}: {
  events: AuditEventRecord[];
  testId?: string;
}) {
  return (
    <TableShell>
      <Table data-testid={testId} aria-label="Audit events">
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">When</TableHead>
            <TableHead className="w-24">Kind</TableHead>
            <TableHead className="w-40">Action</TableHead>
            <TableHead className="w-40">Target</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length === 0 ? (
            <TableEmptyRow colSpan={6}>No audit events.</TableEmptyRow>
          ) : (
            events.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  <time dateTime={e.at.toISOString()} title={e.at.toISOString()}>
                    {e.at.toISOString().slice(0, 16).replace('T', ' ')}
                  </time>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={`font-normal ${kindBadgeClass(e.kind)}`}>
                    {e.kind}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm font-medium text-foreground">
                  {e.action}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {auditTargetLabel(e)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {e.actorName ?? e.actorId}
                </TableCell>
                <TableCell className="text-sm">
                  <EventDetails kind={e.kind} details={e.details} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableShell>
  );
}
