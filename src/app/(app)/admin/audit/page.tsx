import { getComposition, getAppSession, unwrap, parsePageParam } from '@/composition';
import type { AuditKind } from '@app/domain';
import { Pagination } from '@/components/admin/Pagination';
import { Badge } from '@/components/ui/badge';
import { auditTargetLabel } from '@/components/admin/AuditEventList';
import {
  Card,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { AuditFilterForm } from './audit-filter-form';
import { SettingsRevertButton, type SettingsChange } from './settings-revert-button';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const KINDS: readonly AuditKind[] = ['document', 'ticket', 'user', 'settings'];

function parseKind(raw: string | undefined): AuditKind | undefined {
  return (KINDS as readonly string[]).includes(raw ?? '') ? (raw as AuditKind) : undefined;
}

function parseDate(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
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
  kind: AuditKind;
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

function kindBadgeClass(kind: AuditKind): string {
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

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    documentId?: string;
    ticketId?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const documentIdRaw = params.documentId ? Number(params.documentId) : undefined;
  const documentId = Number.isInteger(documentIdRaw) ? documentIdRaw : undefined;
  const kind = parseKind(params.kind);
  const action = params.action || undefined;
  const actor = params.actor || undefined;
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const result = unwrap(await getComposition().listAudit({
    kind,
    action,
    actor,
    from: parseDate(params.from),
    to: parseDate(params.to, true),
    documentId,
    ticketId: params.ticketId,
    limit: PAGE_SIZE,
    offset,
    actorId,
  }));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Audit log</h2>
        <p className="text-sm text-muted-foreground">
          Recent admin and system actions. Filter by kind, actor, or date.
        </p>
      </div>
      <AuditFilterForm
        kind={kind}
        action={action}
        actor={actor}
        from={params.from}
        to={params.to}
      />
      {result.events.length === 0 ? (
        <Card className="border-dashed p-8 shadow-none">
          <div className="flex flex-col items-center gap-1 text-center">
            <CardTitle className="text-base">No audit events</CardTitle>
            <CardDescription>
              Try widening the filters or pick a wider date range.
            </CardDescription>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-strong bg-card/50">
          <Table data-testid="audit-table" aria-label="Audit events">
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
              {result.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
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
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/audit"
        query={{
          kind,
          action,
          actor,
          from: params.from,
          to: params.to,
          documentId,
          ticketId: params.ticketId,
        }}
      />
    </section>
  );
}
