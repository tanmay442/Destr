import { evidenceStableKey } from './grounding-decision';
import type { StructuredEvidenceItem } from './grounding-decision';

export interface GroundingInputResult {
  readonly documentsText: string;
  readonly includedKeys: readonly string[];
  readonly totalUniqueChunks: number;
  readonly totalTokens: number;
  readonly truncatedBy: readonly ('turn_chunk_limit' | 'turn_token_limit')[];
  readonly omittedSubquestions: readonly string[];
  readonly coversAllAnswered: boolean;
}

function defaultEstimateTokens(serialized: string): number {
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function assembleGroundingInput(input: {
  readonly evidence: readonly StructuredEvidenceItem[];
  readonly answeredSubquestionIds: readonly string[];
  readonly maxUniqueChunks: number;
  readonly maxEvidenceTokens: number;
  readonly serializeChunk: (item: StructuredEvidenceItem) => string;
  readonly estimateTokens?: (serialized: string) => number;
}): GroundingInputResult {
  const estimateTokens = input.estimateTokens ?? defaultEstimateTokens;
  const maxUniqueChunks = Math.max(0, Math.floor(input.maxUniqueChunks));
  const maxEvidenceTokens = Math.max(0, Math.floor(input.maxEvidenceTokens));

  const itemByKey = new Map<string, StructuredEvidenceItem>();
  for (const item of input.evidence) {
    const key = evidenceStableKey(item);
    if (!itemByKey.has(key)) itemByKey.set(key, item);
  }
  const sortedKeys = [...itemByKey.keys()].sort();

  const serializedByKey = new Map<string, string>();
  const tokensByKey = new Map<string, number>();
  for (const key of sortedKeys) {
    const item = itemByKey.get(key);
    if (item === undefined) continue;
    const serialized = input.serializeChunk(item);
    serializedByKey.set(key, serialized);
    tokensByKey.set(key, estimateTokens(serialized));
  }

  const answered = [...new Set(input.answeredSubquestionIds)].sort();

  const candidatesBySubquestion = new Map<string, readonly string[]>();
  for (const subquestionId of answered) {
    candidatesBySubquestion.set(
      subquestionId,
      sortedKeys.filter((key) => itemByKey.get(key)?.subquestionIds.includes(subquestionId) === true),
    );
  }

  const included = new Set<string>();
  let usedTokens = 0;
  let hitChunkLimit = false;
  let hitTokenLimit = false;

  const tryInclude = (key: string): boolean => {
    if (included.has(key)) return true;
    const cost = tokensByKey.get(key) ?? 0;
    const chunkBlocked = included.size + 1 > maxUniqueChunks;
    const tokenBlocked = usedTokens + cost > maxEvidenceTokens;
    if (chunkBlocked) hitChunkLimit = true;
    if (tokenBlocked) hitTokenLimit = true;
    if (chunkBlocked || tokenBlocked) return false;
    included.add(key);
    usedTokens += cost;
    return true;
  };

  for (const subquestionId of answered) {
    const candidates = candidatesBySubquestion.get(subquestionId) ?? [];
    for (const key of candidates) {
      if (tryInclude(key)) break;
    }
  }

  for (const key of sortedKeys) {
    if (!included.has(key)) tryInclude(key);
  }

  const includedKeys = sortedKeys.filter((key) => included.has(key));
  const parts: string[] = [];
  for (const key of includedKeys) {
    const text = serializedByKey.get(key);
    if (text !== undefined) parts.push(text);
  }
  const omittedSubquestions = answered.filter((subquestionId) => {
    const candidates = candidatesBySubquestion.get(subquestionId) ?? [];
    return !candidates.some((key) => included.has(key));
  });

  const truncatedBy: Array<'turn_chunk_limit' | 'turn_token_limit'> = [];
  if (hitChunkLimit) truncatedBy.push('turn_chunk_limit');
  if (hitTokenLimit) truncatedBy.push('turn_token_limit');

  return {
    documentsText: parts.join('\n\n'),
    includedKeys,
    totalUniqueChunks: included.size,
    totalTokens: usedTokens,
    truncatedBy,
    omittedSubquestions,
    coversAllAnswered: omittedSubquestions.length === 0,
  };
}
