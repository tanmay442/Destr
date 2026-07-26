import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { UserRepository, ChatEventsRepo, ChatEventRange, QueryOutcome } from '@app/domain';
import { requireAdminActor } from './authz';

export interface TopicCoverageRow {
  topic: string;
  queries: number;
  oodRate: number;
  ticketRate: number;
  frustrated: boolean;
}

export interface TopicCoverage {
  topics: TopicCoverageRow[];
  unmatched: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toMatcher(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
}

function classify(query: string, topics: Array<[string, RegExp[]]>): string | null {
  for (const [topic, matchers] of topics) {
    for (const matcher of matchers) {
      if (matcher.test(query)) return topic;
    }
  }
  return null;
}

export async function getTopicCoverage(
  input: { actorId: string; range?: ChatEventRange },
  deps: {
    users: UserRepository;
    chatEvents: ChatEventsRepo;
    config: { analyticsTopics: Record<string, string[]> };
  },
): Promise<Result<TopicCoverage>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const outcomes = await deps.chatEvents.getQueryOutcomes(input.range);
    const topicEntries = Object.entries(deps.config.analyticsTopics ?? {});
    const topicMatchers: Array<[string, RegExp[]]> = topicEntries.map(([topic, keywords]) => [
      topic,
      keywords.filter(Boolean).map(toMatcher),
    ]);
    const buckets = new Map<string, { queries: number; ood: number; tickets: number }>();
    for (const [topic] of topicEntries) buckets.set(topic, { queries: 0, ood: 0, tickets: 0 });
    let unmatched = 0;

    for (const o of outcomes as QueryOutcome[]) {
      if (!o.query) {
        unmatched++;
        continue;
      }
      const topic = classify(o.query, topicMatchers);
      if (!topic) {
        unmatched++;
        continue;
      }
      const bucket = buckets.get(topic)!;
      bucket.queries++;
      if (o.outOfDomain) bucket.ood++;
      if (o.ticketCreated) bucket.tickets++;
    }

    const rate = (n: number, d: number) => (d > 0 ? n / d : 0);
    const topics: TopicCoverageRow[] = topicEntries.map(([topic]) => {
      const bucket = buckets.get(topic)!;
      const oodRate = rate(bucket.ood, bucket.queries);
      const ticketRate = rate(bucket.tickets, bucket.queries);
      return {
        topic,
        queries: bucket.queries,
        oodRate,
        ticketRate,
        frustrated: oodRate > 0.5 && ticketRate > 0.3,
      };
    });

    return ok({ topics, unmatched });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load topic coverage', e));
  }
}
