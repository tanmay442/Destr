import {
  createFallbackPlan,
  extractPreservedTokens,
  normalizeQueryText,
  planPreservesTokens,
  queryPreservesTokens,
  searchPlanSchema,
  validateSearchPlan,
  type SearchPlan,
  type SearchPlanQuery,
  type SearchPlanSubquestion,
  type SearchQueryStrategy,
  type SearchRationaleCode,
} from './search-plan';
import type { PriorAttemptFeedback } from './search-quality';

export interface PlannerInput {
  readonly originalQuery: string;
  readonly conversationSummary?: string | undefined;
  readonly priorAttempts?: readonly PriorAttemptFeedback[] | undefined;
  readonly remainingPlans: number;
  readonly remainingMs: number | null;
  readonly signal?: AbortSignal | undefined;
}

export interface PlannerOutcome {
  readonly plan: SearchPlan;
  readonly isFallback: boolean;
  readonly fallbackReason: string | null;
  readonly rawValid: boolean;
}

export type PlannerFn = (input: PlannerInput) => Promise<unknown> | unknown;

export interface PlannerTraceSink {
  write(event: { toolName: string; callId: string; phase: string; durationMs: number | null }): void;
}

function splitSubquestions(question: string): string[] {
  const trimmed = question.trim();
  if (trimmed.length === 0) return [trimmed];
  const byQuestion = trimmed
    .split('?')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (byQuestion.length >= 2 && byQuestion.length <= 4) {
    return byQuestion.slice(0, 4).map((part) => `${part}?`.slice(0, 500));
  }
  const byAnd = trimmed.split(/\s+and\s+/i);
  if (byAnd.length >= 2 && byAnd.length <= 4 && trimmed.length > 40) {
    const allSubstantive = byAnd.every((part) => part.trim().split(/\s+/).length >= 3);
    if (allSubstantive) return byAnd.map((part) => part.trim().slice(0, 500));
  }
  const bySemicolon = trimmed.split(/[;|]/).map((part) => part.trim()).filter((part) => part.length > 0);
  if (bySemicolon.length >= 2 && bySemicolon.length <= 4) {
    return bySemicolon.slice(0, 4);
  }
  return [trimmed.slice(0, 500)];
}

const OUT_OF_SCOPE_PATTERNS: readonly RegExp[] = [
  /\bmedical\b/i,
  /\bdiagnos(is|e|is)\b/i,
  /\bdoctor\b/i,
  /\bprescription\b/i,
  /\blegal\b/i,
  /\blawyer\b/i,
  /\blawsuit\b/i,
  /\bweather\b/i,
  /\bforecast\b/i,
  /\bcooking\b/i,
  /\brecipe\b/i,
  /\binvestment\b/i,
  /\bstock\b.*\b(pick|advice|buy)\b/i,
  /\bnonsense\b.*\bphysics\b/i,
  /\bperpetual motion\b/i,
];

const CLARIFICATION_PATTERNS: readonly RegExp[] = [
  /^(help|what\??|tell me more|explain|huh\??)$/i,
  /\b(that|it|the previous one|this one)\b/i,
];

const CHATTER_PATTERN = /\b(please|can you|could you|would you|kindly|thanks|thank you|hey|hi|hello)\b/gi;
const ACRONYM_EXPANSIONS: Readonly<Record<string, string>> = {
  sso: 'single sign-on',
  mfa: 'multi-factor authentication',
  vpn: 'virtual private network',
  api: 'application programming interface',
};

function removeChatter(question: string): string {
  return question.replace(CHATTER_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

function expandAcronyms(question: string): string {
  let result = question;
  for (const [short, long] of Object.entries(ACRONYM_EXPANSIONS)) {
    const pattern = new RegExp(`\\b${short}\\b`, 'gi');
    if (pattern.test(result) && !result.toLowerCase().includes(long.toLowerCase())) {
      result = `${result} ${long}`;
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

function titleSectionVariant(question: string, preserved: readonly string[]): string {
  const cleaned = removeChatter(question)
    .replace(/[?"'.!,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((word) => word.length > 2);
  const keywords = words.slice(0, 8).join(' ');
  const base = keywords.length > 0 ? keywords : cleaned;
  const missing = preserved.filter((token) => !base.toLowerCase().includes(token.toLowerCase()));
  const withPreserved = missing.length > 0 ? `${base} ${missing.join(' ')}` : base;
  return normalizeQueryText(withPreserved);
}

function semanticVariant(question: string, summary: string | undefined, preserved: readonly string[]): string {
  let base = removeChatter(question);
  base = expandAcronyms(base);
  if (summary && /\b(that|it|this|previous)\b/i.test(question)) {
    const summaryTerms = summary.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (summaryTerms.length > 0) base = `${base} ${summaryTerms}`;
  }
  base = base.replace(/\s+/g, ' ').trim();
  const missing = preserved.filter((token) => !base.toLowerCase().includes(token.toLowerCase()));
  const withPreserved = missing.length > 0 ? `${base} ${missing.join(' ')}` : base;
  return normalizeQueryText(withPreserved);
}

function exactTermsVariant(question: string, preserved: readonly string[]): string {
  const cleaned = question.replace(/\s+/g, ' ').trim();
  const missing = preserved.filter((token) => !cleaned.toLowerCase().includes(token.toLowerCase()));
  const withPreserved = missing.length > 0 ? `${cleaned} ${missing.join(' ')}` : cleaned;
  return normalizeQueryText(withPreserved);
}

function isAlreadyGood(question: string): boolean {
  const trimmed = question.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 3 || words.length > 12) return false;
  if (CHATTER_PATTERN.test(trimmed)) return false;
  if (CLARIFICATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  if (/\b(thing|stuff|something|anything|help me|what about)\b/i.test(trimmed)) return false;
  return true;
}

function classifyIntent(question: string): SearchPlan['intent'] {
  const trimmed = question.trim();
  if (trimmed.length === 0) return 'clarification_needed';
  if (OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'out_of_scope';
  if (CLARIFICATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'clarification_needed';
  const preserved = extractPreservedTokens(trimmed);
  if (preserved.length > 0) return 'documentation';
  if (/\b(vpn|sso|mfa|api)\b/i.test(trimmed) && trimmed.split(/\s+/).length <= 3) return 'documentation';
  const words = trimmed.split(/\s+/);
  if (trimmed.length < 10 || (words.length <= 2 && !/"[^"]+"|'[^']+'/.test(trimmed))) {
    return 'clarification_needed';
  }
  return 'documentation';
}

function buildQueriesForSubquestion(input: {
  subquestion: string;
  index: number;
  summary: string | undefined;
  priorAttempts: readonly PriorAttemptFeedback[];
}): SearchPlanQuery[] {
  const { subquestion, index, summary, priorAttempts } = input;
  const normalized = normalizeQueryText(subquestion);
  const preserved = extractPreservedTokens(normalized);
  const queries: SearchPlanQuery[] = [
    {
      queryId: `q-${index + 1}-1`,
      text: normalized,
      strategy: 'original',
      rationaleCode: 'normalized',
    },
  ];
  const pushDistinct = (candidate: string, strategy: SearchQueryStrategy, rationaleCode: SearchRationaleCode): void => {
    const text = normalizeQueryText(candidate);
    if (text.length === 0) return;
    const lowered = text.toLowerCase();
    if (queries.some((existing) => existing.text.toLowerCase() === lowered)) return;
    if (!queryPreservesTokens(text, preserved)) return;
    if (queries.length >= 3) return;
    queries.push({
      queryId: `q-${index + 1}-${queries.length + 1}`,
      text,
      strategy,
      rationaleCode,
    });
  };

  if (isAlreadyGood(normalized) && priorAttempts.length === 0) return queries;

  const exact = exactTermsVariant(normalized, preserved);
  if (exact.toLowerCase() !== normalized.toLowerCase()) {
    pushDistinct(exact, 'exact_terms', preserved.length > 0 ? 'preserve_error_code' : 'alternate_product_term');
  } else if (preserved.length > 0 && queries.length < 3) {
    pushDistinct(`${normalized} documentation`, 'exact_terms', 'preserve_error_code');
  }

  const semantic = semanticVariant(normalized, summary, preserved);
  if (semantic.toLowerCase() !== normalized.toLowerCase() && semantic.toLowerCase() !== exact.toLowerCase()) {
    const usesExpansion = expandAcronyms(normalized).toLowerCase() !== normalized.toLowerCase();
    const usesChatterRemoval = removeChatter(normalized).toLowerCase() !== normalized.toLowerCase();
    pushDistinct(
      semantic,
      'semantic',
      usesExpansion ? 'expand_acronym' : usesChatterRemoval ? 'remove_chatter' : 'alternate_product_term',
    );
  }

  if (queries.length < 2) {
    const titled = titleSectionVariant(normalized, preserved);
    if (titled.toLowerCase() !== normalized.toLowerCase()) {
      pushDistinct(titled, 'title_section', 'alternate_product_term');
    }
  }

  if (priorAttempts.length > 0 && queries.length < 3) {
    const priorQueries = new Set(
      priorAttempts.flatMap((attempt) => attempt.normalizedQueries.map((query) => query.toLowerCase())),
    );
    const coverageCandidate = normalizeQueryText(`${normalized} steps procedure`);
    if (!priorQueries.has(coverageCandidate.toLowerCase())) {
      pushDistinct(coverageCandidate, 'semantic', 'coverage_gap');
    } else {
      const alternate = normalizeQueryText(`${normalized} guide`);
      if (!priorQueries.has(alternate.toLowerCase())) {
        pushDistinct(alternate, 'title_section', 'coverage_gap');
      }
    }
  }

  return queries.slice(0, 3);
}

export function createDeterministicPlan(input: PlannerInput): SearchPlan {
  const original = input.originalQuery.trim().slice(0, 2000);
  const intent = classifyIntent(original);
  if (intent !== 'documentation') {
    const safeQuestion = normalizeQueryText(original).slice(0, 500) || original.slice(0, 100);
    return searchPlanSchema.parse({
      intent,
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: safeQuestion,
          queries: [
            {
              queryId: 'q-1-1',
              text: normalizeQueryText(original) || safeQuestion,
              strategy: 'original',
              rationaleCode: 'normalized',
            },
          ],
        },
      ],
    });
  }
  const parts = splitSubquestions(original).slice(0, 4);
  const subquestions: SearchPlanSubquestion[] = parts.map((part, index) => ({
    subquestionId: `sq-${index + 1}`,
    question: normalizeQueryText(part).slice(0, 500),
    queries: buildQueriesForSubquestion({
      subquestion: part,
      index,
      summary: input.conversationSummary,
      priorAttempts: [...(input.priorAttempts ?? [])],
    }),
  }));
  return searchPlanSchema.parse({ intent, subquestions });
}

export async function resolvePlan(input: {
  planner: PlannerFn;
  request: PlannerInput;
  originalQuery: string;
  trace?: PlannerTraceSink | undefined;
  callId?: string | undefined;
}): Promise<PlannerOutcome> {
  let raw: unknown;
  try {
    raw = await input.planner(input.request);
  } catch {
    const plan = createFallbackPlan(input.originalQuery);
    input.trace?.write({
      toolName: 'searchPlanner',
      callId: input.callId ?? 'planner',
      phase: 'error',
      durationMs: 0,
    });
    return { plan, isFallback: true, fallbackReason: 'planner_error', rawValid: false };
  }
  const validated = validateSearchPlan(raw);
  if (validated.ok && planPreservesTokens(validated.plan)) {
    return { plan: validated.plan, isFallback: false, fallbackReason: null, rawValid: true };
  }
  const plan = createFallbackPlan(input.originalQuery);
  void createDeterministicPlan;
  input.trace?.write({
    toolName: 'searchPlanner',
    callId: input.callId ?? 'planner',
    phase: 'error',
    durationMs: 0,
  });
  return {
    plan,
    isFallback: true,
    fallbackReason: validated.ok ? 'planner_preservation' : 'planner_malformed',
    rawValid: false,
  };
}

export function createDeterministicPlanner(): PlannerFn {
  return async (input: PlannerInput): Promise<SearchPlan> => createDeterministicPlan(input);
}
