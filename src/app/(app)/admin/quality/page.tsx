import { getComposition } from '@/composition';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ShieldQuestion } from 'lucide-react';
import type { ChatEvent } from '@app/domain';
import { ReviewButtons } from './review-buttons';

export const dynamic = 'force-dynamic';

const SAMPLE_LIMIT = 20;

function readString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readNumbers(meta: Record<string, unknown>, key: string): number[] {
  const v = meta[key];
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
}

function readJudgeScores(meta: Record<string, unknown>): { faithfulness: number; retrievalRelevance: number } | null {
  const v = meta.judgeScores;
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec.faithfulness !== 'number' || typeof rec.retrievalRelevance !== 'number') return null;
  return { faithfulness: rec.faithfulness, retrievalRelevance: rec.retrievalRelevance };
}

/** Short display id — the full uuid stays in the title attribute for copy/paste. */
function shortTurnId(turnId: string | null): string {
  return turnId ? `${turnId.slice(0, 8)}…` : '—';
}

function SampleTable({ events, testId }: { events: ChatEvent[]; testId: string }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sampled turns yet. Rows appear once blocked traffic accumulates.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Turn</TableHead>
          <TableHead>Query</TableHead>
          <TableHead>Citations / signals</TableHead>
          <TableHead>Answer</TableHead>
          <TableHead className="text-right">Review</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const judges = readJudgeScores(e.meta);
          return (
            <TableRow key={e.id} data-testid={`${testId}-${e.id}`}>
              <TableCell className="font-mono text-xs text-muted-foreground" title={e.turnId ?? ''}>
                {shortTurnId(e.turnId)}
              </TableCell>
              <TableCell className="max-w-64 truncate text-sm" title={e.query ?? undefined}>
                {e.query ?? <span className="text-muted-foreground italic">(not captured)</span>}
              </TableCell>
              <TableCell>
                <div className="flex max-w-72 flex-wrap items-center gap-1">
                  {readNumbers(e.meta, 'documentIds').map((id) => (
                    <Badge key={id} variant="outline" className="font-mono text-[10px]">
                      doc #{id}
                    </Badge>
                  ))}
                  {judges ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      faith {judges.faithfulness.toFixed(2)} · rel {judges.retrievalRelevance.toFixed(2)}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="max-w-72">
                <p className="truncate text-xs text-muted-foreground" title={readString(e.meta, 'generationSnippet') ?? undefined}>
                  {readString(e.meta, 'generationSnippet') ?? '—'}
                </p>
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  {e.turnId ? (
                    <ReviewButtons turnId={e.turnId} />
                  ) : (
                    <span className="text-xs text-muted-foreground">no turn id</span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default async function QualityPage() {
  const comp = getComposition();
  const blocked = await comp.chatEventBatcher.getQualitySamples(SAMPLE_LIMIT, { blocked: true });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Quality review</h2>
        <p className="text-sm text-muted-foreground">
          Spot-check sampled turns. &quot;Bad&quot; means the bot failed; &quot;Docs Missing&quot; means coverage is
          lacking. Verdicts feed the document improvement loop.
        </p>
      </div>

      <Card className="gap-0" data-testid="quality-blocked-sample">
        <CardHeader className="gap-1 pb-4">
          <CardTitle className="flex items-center gap-2">
            <ShieldQuestion className="size-4 text-destructive" />
            Blocked answers
          </CardTitle>
          <CardDescription>Turns where the hallucination check refused to show the answer.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <SampleTable events={blocked} testId="quality-blocked-row" />
        </CardContent>
      </Card>
    </section>
  );
}
