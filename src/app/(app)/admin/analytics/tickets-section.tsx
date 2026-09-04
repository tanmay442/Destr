import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { BarList, LineChart } from '@/components/admin/Charts';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { Ticket } from 'lucide-react';
import { SectionHeading, num, type WeeklyPoint } from './shared';
import { formatDuration } from '@/lib/format-duration';
import type { TicketIntelligence } from '@app/application';

export function TicketsSection({
  ticketIntel,
  hasTrends,
  series,
}: {
  ticketIntel: TicketIntelligence | null;
  hasTrends: boolean;
  series: (pick: (w: WeeklyPoint) => number) => { label: string; value: number }[];
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="analytics-ticket-intelligence">
      <SectionHeading title="Ticket intelligence" description="Volume, response times" icon={<Ticket className="size-4" />} />
      {ticketIntel ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="gap-0" data-testid="analytics-ticket-volume">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Ticket volume</CardTitle>
              <CardDescription>Tickets created per week across the trend window.</CardDescription>
            </CardHeader>
            <CardContent>
              {hasTrends ? <LineChart data={series((w) => w.ticketsCreated)} /> : <p className="text-sm text-muted-foreground">No trend data yet.</p>}
            </CardContent>
          </Card>

          <Card className="gap-0" data-testid="analytics-turns-to-ticket">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Turns before a ticket</CardTitle>
              <CardDescription>Session turns up to the first ticket created.</CardDescription>
            </CardHeader>
            <CardContent>
              {ticketIntel.turnsToTicket.ticketSessions > 0 ? (
                <div className="flex flex-col gap-3">
                  <BarList
                    ariaLabel="Turns to ticket by bucket"
                    items={ticketIntel.turnsToTicket.buckets.map((b) => ({
                      label: b.label,
                      value: b.count,
                    }))}
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Avg {ticketIntel.turnsToTicket.avgTurns} turns · {num(ticketIntel.turnsToTicket.ticketSessions)} ticket sessions
                  </p>
                </div>
              ) : (
                <Empty className="py-4">
                  <EmptyDescription>No ticket-creating sessions yet.</EmptyDescription>
                </Empty>
              )}
            </CardContent>
          </Card>

          <div className="contents" data-testid="analytics-ticket-response-times">
            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>First response</CardTitle>
                <CardDescription>Median time to first status change.</CardDescription>
              </CardHeader>
              <CardContent>
                {ticketIntel.responseTimes.respondedCount > 0 ? (
                  <span className="text-2xl font-semibold text-foreground tabular-nums">
                    {formatDuration(ticketIntel.responseTimes.medianFirstResponseMs)}
                  </span>
                ) : (
                  <p className="text-sm text-muted-foreground">No audit history of status changes yet.</p>
                )}
              </CardContent>
            </Card>
            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Resolution</CardTitle>
                <CardDescription>Median time to a closed status.</CardDescription>
              </CardHeader>
              <CardContent>
                {ticketIntel.responseTimes.resolvedCount > 0 ? (
                  <span className="text-2xl font-semibold text-foreground tabular-nums">
                    {formatDuration(ticketIntel.responseTimes.medianResolutionMs)}
                  </span>
                ) : (
                  <p className="text-sm text-muted-foreground">No resolved tickets yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Empty>
          <EmptyDescription>Ticket intelligence unavailable.</EmptyDescription>
        </Empty>
      )}
    </div>
  );
}
