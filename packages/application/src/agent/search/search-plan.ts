import { z } from 'zod';

export const searchPlanIntentSchema = z.enum([
  'documentation',
  'out_of_scope',
  'clarification_needed',
]);

export type SearchPlanIntent = z.infer<typeof searchPlanIntentSchema>;

export const searchQueryStrategySchema = z.enum([
  'original',
  'exact_terms',
  'semantic',
  'title_section',
]);

export type SearchQueryStrategy = z.infer<typeof searchQueryStrategySchema>;

export const searchRationaleCodeSchema = z.enum([
  'normalized',
  'preserve_error_code',
  'expand_acronym',
  'remove_chatter',
  'alternate_product_term',
  'coverage_gap',
]);

export type SearchRationaleCode = z.infer<typeof searchRationaleCodeSchema>;

export const searchPlanQuerySchema = z.object({
  queryId: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(500),
  strategy: searchQueryStrategySchema,
  rationaleCode: searchRationaleCodeSchema,
});

export type SearchPlanQuery = z.infer<typeof searchPlanQuerySchema>;

export const searchPlanSubquestionSchema = z.object({
  subquestionId: z.string().trim().min(1).max(100),
  question: z.string().trim().min(1).max(500),
  queries: z.array(searchPlanQuerySchema).min(1).max(3),
});

export type SearchPlanSubquestion = z.infer<typeof searchPlanSubquestionSchema>;

export const searchPlanSchema = z.object({
  intent: searchPlanIntentSchema,
  subquestions: z.array(searchPlanSubquestionSchema).min(1).max(4),
});

export type SearchPlan = z.infer<typeof searchPlanSchema>;

export const SEARCH_PLAN_MAX_SUBQUESTIONS = 4;
export const SEARCH_PLAN_MAX_QUERIES_PER_SUBQUESTION = 3;
export const SEARCH_PLAN_MAX_QUERY_CHARS = 500;
export const SEARCH_PLAN_MAX_QUESTION_CHARS = 500;

export function normalizeQueryText(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, SEARCH_PLAN_MAX_QUERY_CHARS);
}

export function normalizeQueryForDedup(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

const ERROR_CODE_PATTERN =
  /\b(?:ERR|E|0x)[-_]?[0-9A-Z]+\b|\b[A-Z]{2,}[-_]\d+\b|\bv?\d+\.\d+(?:\.\d+)?\b/i;

const COMMON_CAPITALIZED_WORDS = new Set([
  'how', 'what', 'when', 'where', 'why', 'which', 'with', 'from', 'please', 'thanks', 'thank',
  'use', 'using', 'configure', 'setup', 'guide', 'policy', 'account', 'password', 'refund',
  'school', 'cell', 'phone', 'the', 'and', 'for',
]);

export function extractPreservedTokens(query: string): readonly string[] {
  const tokens: string[] = [];
  const quoted = query.match(/"[^"]+"|'[^']+'/g);
  if (quoted) tokens.push(...quoted);
  const codes = query.match(
    /\b0x[0-9a-fA-F]+\b|\bERR[-_]?[0-9A-Z]+\b|\bE\d+\b|\b[A-Z]+[-_]\d+[A-Z0-9-]*\b|\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/g,
  );
  if (codes) tokens.push(...codes);
  const capitalized = query.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g);
  if (capitalized) {
    for (const word of capitalized) {
      if (!COMMON_CAPITALIZED_WORDS.has(word.toLowerCase())) tokens.push(word);
    }
  }
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))];
}

export function queryPreservesTokens(query: string, tokens: readonly string[]): boolean {
  const lowered = query.toLowerCase();
  return tokens.every((token) => lowered.includes(token.toLowerCase()));
}

export function hasErrorCodeLike(query: string): boolean {
  return ERROR_CODE_PATTERN.test(query);
}

export interface DedupedQuery {
  readonly query: SearchPlanQuery;
  readonly dedupKey: string;
  readonly aliasQueryIds: readonly string[];
}

export function dedupeQueriesWithinSubquestion(
  queries: readonly SearchPlanQuery[],
): readonly DedupedQuery[] {
  const byKey = new Map<string, { primary: SearchPlanQuery; aliases: string[] }>();
  for (const query of queries) {
    const key = normalizeQueryForDedup(query.text);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.aliases.includes(query.queryId) && existing.primary.queryId !== query.queryId) {
        existing.aliases.push(query.queryId);
      }
      continue;
    }
    byKey.set(key, { primary: query, aliases: [] });
  }
  return [...byKey.values()].map((entry) => ({
    query: entry.primary,
    dedupKey: normalizeQueryForDedup(entry.primary.text),
    aliasQueryIds: [entry.primary.queryId, ...entry.aliases],
  }));
}

export function planPreservesTokens(plan: SearchPlan): boolean {
  for (const sub of plan.subquestions) {
    const preserved = extractPreservedTokens(sub.question);
    if (preserved.length === 0) continue;
    for (const query of sub.queries) {
      if (!queryPreservesTokens(query.text, preserved)) return false;
    }
  }
  return true;
}

export function validateSearchPlan(raw: unknown): { ok: true; plan: SearchPlan } | { ok: false; issues: string } {
  const parsed = searchPlanSchema.safeParse(raw);
  if (parsed.success) {
    const subIds = parsed.data.subquestions.map((sub) => sub.subquestionId.trim());
    if (new Set(subIds).size !== subIds.length) {
      return { ok: false, issues: 'subquestion IDs must be unique within a plan' };
    }
    for (const sub of parsed.data.subquestions) {
      const queryIds = sub.queries.map((query) => query.queryId.trim());
      if (new Set(queryIds).size !== queryIds.length) {
        return { ok: false, issues: `query IDs must be unique within subquestion ${sub.subquestionId}` };
      }
    }
    return { ok: true, plan: parsed.data };
  }
  const first = parsed.error.issues[0];
  return {
    ok: false,
    issues: first ? `${first.path.join('.') || 'plan'}: ${first.message}` : 'Invalid search plan.',
  };
}

export function createFallbackPlan(originalQuery: string): SearchPlan {
  const normalized = normalizeQueryText(originalQuery);
  const safeText = normalized.length > 0 ? normalized : originalQuery.trim().slice(0, 100) || 'documentation';
  return searchPlanSchema.parse({
    intent: 'documentation',
    subquestions: [
      {
        subquestionId: 'sq-1',
        question: safeText.slice(0, SEARCH_PLAN_MAX_QUESTION_CHARS),
        queries: [
          {
            queryId: 'q-1',
            text: safeText,
            strategy: 'original',
            rationaleCode: 'normalized',
          },
        ],
      },
    ],
  });
}
