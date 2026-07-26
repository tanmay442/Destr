import { describe, it, expect } from 'vitest';
import { getTopicCoverage } from '../topics';
import { unwrap, ForbiddenError } from '@app/domain';
import type { UserRepository, ChatEventsRepo, QueryOutcome } from '@app/domain';

const adminUsers = {
  findByClerkId: async (id: string) => (id === 'admin' ? { role: 'admin' } : { role: 'user' }),
} as unknown as UserRepository;

const config = {
  analyticsTopics: {
    'password reset': ['password', 'forgot password'],
    billing: ['invoice', 'refund'],
    api: ['api', 'rate limit'],
  },
};

function repoWith(outcomes: QueryOutcome[]): ChatEventsRepo {
  return { getQueryOutcomes: async () => outcomes } as unknown as ChatEventsRepo;
}

describe('getTopicCoverage', () => {
  it('rejects a non-admin actor', async () => {
    const res = await getTopicCoverage({ actorId: 'user' }, { users: adminUsers, chatEvents: repoWith([]), config });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('classifies queries deterministically by first matching topic (case-insensitive)', async () => {
    const outcomes: QueryOutcome[] = [
      { query: 'I FORGOT my PASSWORD', outOfDomain: false, ticketCreated: false },
      { query: 'need an invoice copy', outOfDomain: false, ticketCreated: false },
      { query: 'how do I bake bread', outOfDomain: true, ticketCreated: false },
    ];
    const first = unwrap(await getTopicCoverage({ actorId: 'admin' }, { users: adminUsers, chatEvents: repoWith(outcomes), config }));
    const second = unwrap(await getTopicCoverage({ actorId: 'admin' }, { users: adminUsers, chatEvents: repoWith(outcomes), config }));
    expect(first).toEqual(second);
    expect(first.unmatched).toBe(1);
    const pw = first.topics.find((t) => t.topic === 'password reset')!;
    expect(pw.queries).toBe(1);
  });

  it('matches keywords on word boundaries, not raw substrings', async () => {
    const outcomes: QueryOutcome[] = [
      { query: 'rapid onboarding question', outOfDomain: false, ticketCreated: false },
      { query: 'how do I call the API?', outOfDomain: false, ticketCreated: false },
      { query: 'hitting the rate limit on requests', outOfDomain: false, ticketCreated: false },
    ];
    const res = unwrap(await getTopicCoverage({ actorId: 'admin' }, { users: adminUsers, chatEvents: repoWith(outcomes), config }));
    const api = res.topics.find((t) => t.topic === 'api')!;
    expect(api.queries).toBe(2);
    expect(res.unmatched).toBe(1);
  });

  it('flags frustrated topics when ood > 0.5 and ticket > 0.3', async () => {
    const outcomes: QueryOutcome[] = [
      { query: 'password help', outOfDomain: true, ticketCreated: true },
      { query: 'reset my password', outOfDomain: true, ticketCreated: true },
      { query: 'password thing', outOfDomain: false, ticketCreated: false },
    ];
    const res = unwrap(await getTopicCoverage({ actorId: 'admin' }, { users: adminUsers, chatEvents: repoWith(outcomes), config }));
    const pw = res.topics.find((t) => t.topic === 'password reset')!;
    expect(pw.queries).toBe(3);
    expect(pw.oodRate).toBeCloseTo(2 / 3, 5);
    expect(pw.ticketRate).toBeCloseTo(2 / 3, 5);
    expect(pw.frustrated).toBe(true);
    const billing = res.topics.find((t) => t.topic === 'billing')!;
    expect(billing.queries).toBe(0);
    expect(billing.frustrated).toBe(false);
  });
});
