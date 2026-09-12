import { citationStableKey, evidenceStableKey, groundingCitationSchema } from './grounding-decision';
import type {
  GroundingCitation,
  RejectedReason,
  StructuredEvidenceItem,
} from './grounding-decision';

export type CitationValidationOutcome =
  | { kind: 'valid'; validCitations: GroundingCitation[] }
  | {
      kind: 'invalid';
      reason: RejectedReason;
      invalidIds: readonly number[];
      detail: string;
    };

const MAX_SNIPPET_CHARS = 2000;
const ELLIPSIS = '\u2026';

function extractRawId(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  if (!('id' in raw)) return null;
  const id: unknown = raw.id;
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

function normalizeSnippet(snippet: string): string {
  const collapsed = snippet.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (collapsed.endsWith(ELLIPSIS)) return collapsed.slice(0, -1).trimEnd();
  return collapsed;
}

function normalizeContent(content: string): string {
  return content.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function sortedIds(ids: readonly number[]): number[] {
  return [...ids].sort((a, b) => a - b);
}

function invalid(
  reason: RejectedReason,
  invalidIds: readonly number[],
  detail: string,
): CitationValidationOutcome {
  return { kind: 'invalid', reason, invalidIds: sortedIds(invalidIds), detail };
}

export function validateCitations(input: {
  readonly citations: readonly unknown[];
  readonly evidence: readonly StructuredEvidenceItem[];
  readonly documentationRequired: boolean;
}): CitationValidationOutcome {
  if (input.citations.length === 0) {
    if (input.documentationRequired) {
      return invalid('missing_citation', [], 'missing_citation:required');
    }
    return { kind: 'valid', validCitations: [] };
  }

  const rawCitations: readonly unknown[] = input.citations;
  const parsed: GroundingCitation[] = [];
  const malformedTokens: string[] = [];
  const malformedIds: number[] = [];
  rawCitations.forEach((raw, index) => {
    const result = groundingCitationSchema.safeParse(raw);
    if (!result.success) {
      const rawId = extractRawId(raw);
      if (rawId === null) {
        malformedTokens.push(`index_${index}`);
      } else {
        malformedTokens.push(String(rawId));
        malformedIds.push(rawId);
      }
      return;
    }
    parsed.push(result.data);
  });
  if (malformedTokens.length > 0) {
    return invalid('missing_citation', malformedIds, `malformed_citation:${malformedTokens.join(',')}`);
  }

  const contentByKey = new Map<string, string>();
  for (const item of input.evidence) {
    const key = evidenceStableKey(item);
    if (!contentByKey.has(key)) contentByKey.set(key, normalizeContent(item.content));
  }

  const unknownIds: number[] = [];
  for (const citation of parsed) {
    if (!contentByKey.has(citationStableKey(citation))) unknownIds.push(citation.id);
  }
  if (unknownIds.length > 0) {
    return invalid('missing_citation', unknownIds, `unknown_citation:${sortedIds(unknownIds).join(',')}`);
  }

  const keyCounts = new Map<string, number>();
  for (const citation of parsed) {
    const key = citationStableKey(citation);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const duplicateIds = parsed
    .filter((citation) => (keyCounts.get(citationStableKey(citation)) ?? 0) > 1)
    .map((citation) => citation.id);
  if (duplicateIds.length > 0) {
    return invalid('missing_citation', duplicateIds, `duplicate_citation:${sortedIds(duplicateIds).join(',')}`);
  }

  const tooLong: number[] = [];
  const empty: number[] = [];
  const unsupported: number[] = [];
  for (const citation of parsed) {
    const snippet = normalizeSnippet(citation.snippet);
    if (snippet.length > MAX_SNIPPET_CHARS) {
      tooLong.push(citation.id);
      continue;
    }
    if (snippet.length === 0) {
      empty.push(citation.id);
      continue;
    }
    const content = contentByKey.get(citationStableKey(citation));
    if (content === undefined || !content.includes(snippet)) unsupported.push(citation.id);
  }
  if (tooLong.length > 0) {
    return invalid('unsupported_claim', tooLong, `snippet_too_long:${sortedIds(tooLong).join(',')}`);
  }
  if (empty.length > 0) {
    return invalid('unsupported_claim', empty, `empty_snippet:${sortedIds(empty).join(',')}`);
  }
  if (unsupported.length > 0) {
    return invalid('unsupported_claim', unsupported, `unsupported_snippet:${sortedIds(unsupported).join(',')}`);
  }

  return { kind: 'valid', validCitations: parsed };
}
