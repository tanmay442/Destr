import { describe, expect, it } from 'vitest';
import {
  createFallbackPlan,
  dedupeQueriesWithinSubquestion,
  extractPreservedTokens,
  normalizeQueryForDedup,
  normalizeQueryText,
  planPreservesTokens,
  queryPreservesTokens,
  searchPlanSchema,
  validateSearchPlan,
} from '../search-plan';
import { createDeterministicPlan, resolvePlan } from '../search-planner';

describe('SearchPlan contract (WP-4 Section 7.5)', () => {
  it('accepts the exact schema-derived contract with operational rationale codes only', () => {
    const plan = searchPlanSchema.parse({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'How do I reset my password?',
          queries: [
            { queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-2', text: 'password reset steps', strategy: 'semantic', rationaleCode: 'remove_chatter' },
          ],
        },
      ],
    });
    expect(plan.intent).toBe('documentation');
    expect(plan.subquestions).toHaveLength(1);
    expect(validateSearchPlan(plan).ok).toBe(true);
  });

  it('rejects free-form rationale and enforces schema limits', () => {
    expect(
      validateSearchPlan({
        intent: 'documentation',
        subquestions: [
          {
            subquestionId: 'sq-1',
            question: 'q',
            queries: [
              { queryId: 'q-1', text: 'a', strategy: 'original', rationaleCode: 'because it feels good' },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateSearchPlan({
        intent: 'documentation',
        subquestions: [],
      }).ok,
    ).toBe(false);
    const tooManySubs = Array.from({ length: 5 }, (_, index) => ({
      subquestionId: `sq-${index + 1}`,
      question: `question ${index + 1}`,
      queries: [{ queryId: 'q-1', text: 'a', strategy: 'original', rationaleCode: 'normalized' }],
    }));
    expect(validateSearchPlan({ intent: 'documentation', subquestions: tooManySubs }).ok).toBe(false);
    const tooManyQueries = {
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'q',
          queries: [1, 2, 3, 4].map((number) => ({
            queryId: `q-${number}`,
            text: `variant ${number}`,
            strategy: 'original',
            rationaleCode: 'normalized',
          })),
        },
      ],
    };
    expect(validateSearchPlan(tooManyQueries).ok).toBe(false);
  });

  it('already-good query remains stable with a single original variant', () => {
    const plan = createDeterministicPlan({
      originalQuery: 'school cell phone policy',
      remainingPlans: 2,
      remainingMs: 5000,
    });
    expect(plan.intent).toBe('documentation');
    expect(plan.subquestions).toHaveLength(1);
    expect(plan.subquestions[0]?.queries).toHaveLength(1);
    expect(plan.subquestions[0]?.queries[0]?.strategy).toBe('original');
    expect(plan.subquestions[0]?.queries[0]?.text).toBe('school cell phone policy');
  });

  it('preserves error codes, versions, product names, and quoted phrases', () => {
    const original = 'Acme VPN client ERR_CONNECTION_RESET v2.4.1 "split tunnel" fails to connect';
    const plan = createDeterministicPlan({ originalQuery: original, remainingPlans: 2, remainingMs: 5000 });
    const preserved = extractPreservedTokens(original);
    expect(preserved.length).toBeGreaterThan(0);
    for (const sub of plan.subquestions) {
      for (const query of sub.queries) {
        expect(queryPreservesTokens(query.text, preserved)).toBe(true);
      }
    }
  });

  it('uses token boundaries and rejects plans that drop original preserved terms', async () => {
    expect(queryPreservesTokens('capital expenditure policy', ['API'])).toBe(false);
    const dropped = {
      intent: 'documentation' as const,
      subquestions: [{
        subquestionId: 'sq-1',
        question: 'generic connection problem',
        queries: [{ queryId: 'q-1', text: 'connection troubleshooting', strategy: 'semantic' as const, rationaleCode: 'normalized' as const }],
      }],
    };
    expect(planPreservesTokens(dropped, 'Acme API ERR-4291 on v2.4.1')).toBe(false);
    const resolved = await resolvePlan({
      planner: async () => dropped,
      request: { originalQuery: 'Acme API ERR-4291 on v2.4.1', remainingPlans: 2, remainingMs: 5000 },
      originalQuery: 'Acme API ERR-4291 on v2.4.1',
    });
    expect(resolved.isFallback).toBe(true);
    expect(resolved.fallbackReason).toBe('planner_preservation');
    const fallbackText = resolved.plan.subquestions[0]?.queries[0]?.text ?? '';
    expect(queryPreservesTokens(fallbackText, extractPreservedTokens('Acme API ERR-4291 on v2.4.1'))).toBe(true);
  });

  it('retains preserved terms near the end of a long fallback query', () => {
    const original = `${'generic troubleshooting words '.repeat(30)}Acme API ERR-9876 v9.8.7`;
    const fallback = createFallbackPlan(original);
    const text = fallback.subquestions[0]?.queries[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(500);
    expect(queryPreservesTokens(text, extractPreservedTokens(original))).toBe(true);
  });

  it('vague input creates useful genuinely distinct variants', () => {
    const plan = createDeterministicPlan({
      originalQuery: 'please help me with my thing, can you tell me about phones and stuff?',
      remainingPlans: 2,
      remainingMs: 5000,
    });
    expect(plan.intent).toBe('documentation');
    const queries = plan.subquestions[0]?.queries ?? [];
    expect(queries.length).toBeGreaterThanOrEqual(2);
    const normalized = queries.map((query) => normalizeQueryForDedup(query.text));
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it('malformed planner output falls back deterministically to normalized original without out-of-scope reinterpretation', () => {
    const fallback = createFallbackPlan('  Hello   World  ');
    expect(fallback.intent).toBe('documentation');
    expect(fallback.subquestions).toHaveLength(1);
    expect(fallback.subquestions[0]?.queries[0]?.text).toBe('Hello World');
    expect(fallback.subquestions[0]?.queries[0]?.strategy).toBe('original');
    expect(fallback.subquestions[0]?.queries[0]?.rationaleCode).toBe('normalized');
    expect(validateSearchPlan(fallback).ok).toBe(true);
  });

  it('normalizes and deduplicates planner variants', () => {
    const deduped = dedupeQueriesWithinSubquestion([
      { queryId: 'q-1', text: 'Password Reset', strategy: 'original', rationaleCode: 'normalized' },
      { queryId: 'q-2', text: '  password   reset ', strategy: 'semantic', rationaleCode: 'remove_chatter' },
      { queryId: 'q-3', text: 'password reset steps', strategy: 'semantic', rationaleCode: 'coverage_gap' },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.aliasQueryIds).toEqual(expect.arrayContaining(['q-1', 'q-2']));
  });

  it('generated boundary cases for schema limits and normalization', () => {
    for (let length = 1; length <= 600; length += 97) {
      const text = 'a'.repeat(length);
      const normalized = normalizeQueryText(text);
      expect(normalized.length).toBeLessThanOrEqual(500);
      if (length >= 1 && length <= 500) expect(normalized).toBe(text);
    }
    for (const raw of ['  Hello   World  ', 'HELLO world', 'hello, world!', 'hello\t\nworld']) {
      expect(normalizeQueryForDedup(raw)).toBe(normalizeQueryForDedup(raw.toLowerCase()));
    }
    for (let count = 0; count <= 5; count += 1) {
      const queries = Array.from({ length: count }, (_, index) => ({
        queryId: `q-${index + 1}`,
        text: `variant ${index + 1}`,
        strategy: 'original' as const,
        rationaleCode: 'normalized' as const,
      }));
      const result = validateSearchPlan({
        intent: 'documentation',
        subquestions: count === 0 ? [] : [{ subquestionId: 'sq-1', question: 'q', queries }],
      });
      if (count === 0) expect(result.ok).toBe(false);
      if (count >= 1 && count <= 3) expect(result.ok).toBe(true);
      if (count >= 4) expect(result.ok).toBe(false);
    }
  });
});
