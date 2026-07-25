import { getComposition, getAppSession, unwrap, parsePageParam } from '@/composition';
import type { AuditKind } from '@app/domain';
import { Pagination } from '@/components/admin/Pagination';
import { Badge } from '@/components/ui/badge';
import { auditTargetLabel } from '@/components/admin/AuditEventList';
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
      <span className="flex items-center gap-1">
        <Badge variant="outline">{formatValue(details.fromRole)}</Badge>
        <span aria-hidden>→</span>
        <Badge variant="outline">{formatValue(details.toRole)}</Badge>
      </span>
    );
  }
  if (kind === 'settings') {
    const changes = settingsChanges(details);
    return (
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-0.5">
          {changes.map((c) => (
            <li key={c.key} className="flex flex-wrap items-baseline gap-1">
              <span className="font-medium text-foreground">{c.key}</span>
              <span className="text-muted-foreground">
                {formatValue(c.old)} → {formatValue(c.new)}
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
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">Audit log</h2>
      <AuditFilterForm
        kind={kind}
        action={action}
        actor={actor}
        from={params.from}
        to={params.to}
      />
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <Table data-testid="audit-table" aria-label="Audit events">
          <TableHeader className="bg-secondary text-muted-foreground">
            <TableRow>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                When
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Kind
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Action
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Target
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Actor
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Details
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.events.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No audit events.
                </TableCell>
              </TableRow>
            ) : (
              result.events.map((e) => (
                <TableRow
                  key={e.id}
                  className="border-border-subtle hover:bg-secondary/40"
                >
                  <TableCell className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {e.at.toISOString()}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-foreground">
                    {e.kind}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs font-medium text-foreground">
                    {e.action}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {auditTargetLabel(e)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {e.actorName ?? e.actorId}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs">
                    <EventDetails kind={e.kind} details={e.details} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
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
