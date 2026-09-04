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
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { BarList } from '@/components/admin/Charts';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { MetricCard, SectionHeading, num, pct } from './shared';
import type { DocumentAnalytics } from '@app/application';

export function FeedbackSection({
  feedback,
  feedbackRate,
  documents,
}: {
  feedback: DocumentAnalytics['feedback'] | null;
  feedbackRate: number;
  documents: DocumentAnalytics | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Feedback" description="What users think" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label="Helpful" icon={<ThumbsUp className="size-3.5" />} value={feedback ? num(feedback.summary.up) : '0'} tone="success" />
        <MetricCard label="Unhelpful" icon={<ThumbsDown className="size-3.5" />} value={feedback ? num(feedback.summary.down) : '0'} tone="destructive" />
        <MetricCard label="Feedback rate" value={pct(feedbackRate)} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="gap-0" data-testid="analytics-document-sentiment">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Document sentiment</CardTitle>
            <CardDescription>Votes on answers that cited each document.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {feedback && feedback.documentSentiment.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead className="w-16 text-right">
                      <ThumbsUp aria-label="Helpful" />
                    </TableHead>
                    <TableHead className="w-16 text-right">
                      <ThumbsDown aria-label="Unhelpful" />
                    </TableHead>
                    <TableHead className="w-20 text-right">Positive</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedback.documentSentiment.map((d) => (
                    <TableRow key={d.documentId}>
                      <TableCell className="font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(d.up)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(d.down)}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={cn(
                            d.up + d.down > 0 && d.up / (d.up + d.down) >= 0.7
                              ? 'border-success/40 text-success'
                              : d.up + d.down > 0 && d.up / (d.up + d.down) < 0.4
                                ? 'border-destructive/40 text-destructive'
                                : 'text-muted-foreground',
                          )}
                        >
                          {d.up + d.down > 0 ? pct(d.up / (d.up + d.down)) : '—'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="px-6 text-sm text-muted-foreground">No feedback yet. Votes appear as users rate answers.</p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0" data-testid="analytics-thumbs-down-docs">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Thumbs-down hot docs</CardTitle>
            <CardDescription>Cited most often in negative feedback — review for accuracy.</CardDescription>
          </CardHeader>
          <CardContent>
            {feedback && feedback.thumbsDownDocs.length > 0 ? (
              <BarList
                ariaLabel="Documents with negative feedback"
                items={feedback.thumbsDownDocs.map((d) => ({
                  label: d.fileName ?? `Document #${d.documentId}`,
                  value: d.down,
                  barClassName: 'bg-destructive/70',
                }))}
              />
            ) : (
              <Empty className="py-4">
                <EmptyDescription>No thumbs-down votes recorded.</EmptyDescription>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator className="my-2" />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="gap-0" data-testid="analytics-document-utility">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Document utility</CardTitle>
            <CardDescription>Retrieval volume, match quality, and ticket conversion per document.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {documents && documents.utility.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead className="text-right">Retrievals</TableHead>
                    <TableHead className="text-right">p95 similarity</TableHead>
                    <TableHead className="text-right">Ticket conv.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.utility.map((d) => (
                    <TableRow key={d.documentId}>
                      <TableCell className="font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(d.retrievalCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.p95Similarity.toFixed(3)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(d.ticketConversionRate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="px-6 text-sm text-muted-foreground">No document references yet. Populates as new chats reference documents.</p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0" data-testid="analytics-zero-hit-documents">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Zero-hit documents</CardTitle>
            <CardDescription>Never referenced in any chat — dead-weight candidates.</CardDescription>
          </CardHeader>
          <CardContent>
            {documents && documents.zeroHit.length > 0 ? (
              <ul className="flex flex-col gap-2.5">
                {documents.zeroHit.map((d) => (
                  <li key={d.documentId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-destructive/70" aria-hidden />
                      <span className="truncate font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(d.createdAt).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">All documents have been retrieved.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
