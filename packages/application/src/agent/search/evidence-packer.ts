import { stableChunkIdentities, stableChunkIdentity } from '../../rag/search/stable-chunk-identity';
import { serializeUntrustedChunk } from '../prompt/serialize-untrusted-result';
import type { RetrievedChunk } from '../../rag/search/search-types';
import type { SearchPartialReason } from './search-budget';

export interface RankedSubquestionSet {
  readonly subquestionId: string;
  readonly rankedResults: readonly RetrievedChunk[];
  readonly requestedCount: number;
}

export interface PackEvidenceInput {
  readonly subquestionSets: readonly RankedSubquestionSet[];
  readonly maxUniqueChunks: number;
  readonly maxEvidenceTokens: number;
  readonly minQuotaPerSubquestion: number;
  readonly maxResultsPerSubquestion: number;
  readonly maxResultsPerSearchCall: number;
}

export interface PackedSubquestion {
  readonly subquestionId: string;
  readonly results: readonly RetrievedChunk[];
  readonly requestedCount: number;
  readonly returnedCount: number;
  readonly coverage: 'sufficient' | 'partial';
  readonly partialReason: SearchPartialReason | null;
}

export interface PackEvidenceOutput {
  readonly packedSets: readonly PackedSubquestion[];
  readonly chunkProvenance: ReadonlyMap<string, { subquestionIds: readonly string[] }>;
  readonly totalUniqueChunks: number;
  readonly totalTokens: number;
  readonly truncatedBy: ReadonlyArray<
    'call_result_limit' | 'subquestion_result_limit' | 'turn_chunk_limit' | 'turn_token_limit'
  >;
  readonly coverage: 'sufficient' | 'partial';
}

export function estimateChunkTokens(chunk: Pick<RetrievedChunk, 'content' | 'source'>): number {
  return Math.max(1, Math.ceil(serializeUntrustedChunk({ content: chunk.content, source: chunk.source }).length / 4));
}

function stableKey(chunk: RetrievedChunk): string {
  return stableChunkIdentity(chunk);
}

export function packEvidence(input: PackEvidenceInput): PackEvidenceOutput {
  const truncated = new Set<
    'call_result_limit' | 'subquestion_result_limit' | 'turn_chunk_limit' | 'turn_token_limit'
  >();
  const provenance = new Map<string, Set<string>>();
  const perSubquestionCapped = new Map<string, readonly RetrievedChunk[]>();

  for (const set of input.subquestionSets) {
    const capped = set.rankedResults.slice(0, Math.max(0, input.maxResultsPerSubquestion));
    if (set.rankedResults.length > capped.length) truncated.add('subquestion_result_limit');
    perSubquestionCapped.set(set.subquestionId, capped);
    for (const chunk of set.rankedResults) {
      const key = stableKey(chunk);
      let entry = provenance.get(key);
      if (!entry) {
        entry = new Set<string>();
        provenance.set(key, entry);
      }
      entry.add(set.subquestionId);
    }
  }

  const answered = input.subquestionSets.filter(
    (set) => (perSubquestionCapped.get(set.subquestionId) ?? []).length > 0,
  );
  const minQuota = Math.max(0, Math.min(input.minQuotaPerSubquestion, input.maxResultsPerSubquestion));

  const packedBySub = new Map<string, RetrievedChunk[]>();
  const packedKeys = new Set<string>();
  const packedIdentities = new Set<string>();
  const identityToEntry = new Map<string, string>();
  let totalTokens = 0;

  const overlapsPacked = (chunk: RetrievedChunk): string | null => {
    for (const identity of stableChunkIdentities(chunk)) {
      const mapped = identityToEntry.get(identity);
      if (mapped !== undefined) return mapped;
    }
    return null;
  };

  const tryAdd = (
    subquestionId: string,
    chunk: RetrievedChunk,
  ): boolean => {
    const key = stableKey(chunk);
    if (packedKeys.has(key) || overlapsPacked(chunk) !== null) return false;
    if (packedKeys.size >= input.maxResultsPerSearchCall) {
      truncated.add('call_result_limit');
      return false;
    }
    if (packedKeys.size + 1 > input.maxUniqueChunks) {
      truncated.add('turn_chunk_limit');
      return false;
    }
    const tokens = estimateChunkTokens(chunk);
    if (totalTokens + tokens > input.maxEvidenceTokens) {
      truncated.add('turn_token_limit');
      return false;
    }
    let list = packedBySub.get(subquestionId);
    if (!list) {
      list = [];
      packedBySub.set(subquestionId, list);
    }
    list.push(chunk);
    packedKeys.add(key);
    for (const identity of stableChunkIdentities(chunk)) {
      packedIdentities.add(identity);
      identityToEntry.set(identity, key);
    }
    totalTokens += tokens;
    return true;
  };

  let requestedReserved = 0;
  for (const set of answered) {
    const capped = perSubquestionCapped.get(set.subquestionId) ?? [];
    const quota = Math.min(minQuota, capped.length, set.requestedCount);
    requestedReserved += quota;
    for (let index = 0; index < quota; index += 1) {
      const chunk = capped[index];
      if (!chunk) continue;
      if (packedKeys.has(stableKey(chunk)) || overlapsPacked(chunk) !== null) continue;
      const added = tryAdd(set.subquestionId, chunk);
      if (!added) break;
    }
  }

  const uniqueReserved = packedKeys.size;
  let savedSlots = Math.max(0, requestedReserved - uniqueReserved);

  const weakestSubquestion = (): string | null => {
    let weakest: string | null = null;
    let weakestCount = Number.POSITIVE_INFINITY;
    for (const set of answered) {
      const count = packedBySub.get(set.subquestionId)?.length ?? 0;
      if (count < weakestCount || (count === weakestCount && (weakest === null || set.subquestionId < weakest))) {
        weakestCount = count;
        weakest = set.subquestionId;
      }
    }
    return weakest;
  };

  while (savedSlots > 0) {
    const weakest = weakestSubquestion();
    if (!weakest) break;
    const capped = perSubquestionCapped.get(weakest) ?? [];
    const packed = packedBySub.get(weakest) ?? [];
    const next = capped.find((chunk) => !packedKeys.has(stableKey(chunk)) && overlapsPacked(chunk) === null);
    if (!next) break;
    const before = packed.length;
    const added = tryAdd(weakest, next);
    savedSlots -= 1;
    if (!added) break;
    if ((packedBySub.get(weakest)?.length ?? 0) === before) break;
  }

  type Candidate = { chunk: RetrievedChunk; subquestionId: string; rankIndex: number };
  const candidates: Candidate[] = [];
  for (const set of input.subquestionSets) {
    const capped = perSubquestionCapped.get(set.subquestionId) ?? [];
    for (const [rankIndex, chunk] of capped.entries()) {
      if (packedKeys.has(stableKey(chunk)) || overlapsPacked(chunk) !== null) continue;
      candidates.push({ chunk, subquestionId: set.subquestionId, rankIndex });
    }
  }
  candidates.sort((a, b) => {
    if (a.rankIndex !== b.rankIndex) return a.rankIndex - b.rankIndex;
    if (a.subquestionId !== b.subquestionId) return a.subquestionId < b.subquestionId ? -1 : 1;
    const aKey = stableKey(a.chunk);
    const bKey = stableKey(b.chunk);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  let totalPacked = packedKeys.size;
  for (const candidate of candidates) {
    if (totalPacked >= input.maxResultsPerSearchCall) {
      truncated.add('call_result_limit');
      break;
    }
    if (packedKeys.has(stableKey(candidate.chunk)) || overlapsPacked(candidate.chunk) !== null) continue;
    const added = tryAdd(candidate.subquestionId, candidate.chunk);
    if (!added) {
      if (truncated.has('turn_chunk_limit') || truncated.has('turn_token_limit')) break;
      continue;
    }
    totalPacked = packedKeys.size;
  }

  if (totalPacked >= input.maxResultsPerSearchCall && candidates.length > 0) {
    const remainingUnseen = candidates.some((candidate) => !packedKeys.has(stableKey(candidate.chunk)) && overlapsPacked(candidate.chunk) === null);
    if (remainingUnseen) truncated.add('call_result_limit');
  }

  let output = buildPackedSets(input, packedBySub, truncated);
  if (truncated.has('turn_token_limit')) {
    const allQuotasImpossible = answered.length > 0 &&
      answered.every((set) => (packedBySub.get(set.subquestionId)?.length ?? 0) < Math.min(1, set.requestedCount));
    if (allQuotasImpossible) {
      const fallbackPacked = new Map<string, RetrievedChunk[]>();
      const fallbackKeys = new Set<string>();
      let fallbackTokens = 0;
      const fallbackTruncated = new Set(truncated);
      fallbackTruncated.add('turn_token_limit');
      for (const set of answered) {
        const capped = perSubquestionCapped.get(set.subquestionId) ?? [];
        const first = capped.find((chunk) => !fallbackKeys.has(stableKey(chunk)));
        if (!first) continue;
        if (fallbackKeys.size + 1 > input.maxUniqueChunks) {
          fallbackTruncated.add('turn_chunk_limit');
          continue;
        }
        const tokens = estimateChunkTokens(first);
        if (fallbackTokens + tokens > input.maxEvidenceTokens) continue;
        fallbackPacked.set(set.subquestionId, [first]);
        fallbackKeys.add(stableKey(first));
        fallbackTokens += tokens;
      }
      if (fallbackKeys.size > 0) {
        packedKeys.clear();
        for (const key of fallbackKeys) packedKeys.add(key);
        totalTokens = fallbackTokens;
        output = buildPackedSets(input, fallbackPacked, fallbackTruncated);
        return {
          ...output,
          chunkProvenance: toProvenanceMap(provenance),
          totalUniqueChunks: fallbackKeys.size,
          totalTokens: fallbackTokens,
          truncatedBy: [...fallbackTruncated].sort(),
        };
      }
    }
  }

  return {
    ...output,
    chunkProvenance: toProvenanceMap(provenance),
    totalUniqueChunks: packedKeys.size,
    totalTokens,
    truncatedBy: [...truncated].sort(),
  };
}

function toProvenanceMap(
  provenance: ReadonlyMap<string, Set<string>>,
): ReadonlyMap<string, { subquestionIds: readonly string[] }> {
  const mapped = new Map<string, { subquestionIds: readonly string[] }>();
  for (const [key, subs] of provenance) {
    mapped.set(key, { subquestionIds: [...subs].sort() });
  }
  return mapped;
}

function buildPackedSets(
  input: PackEvidenceInput,
  packedBySub: ReadonlyMap<string, readonly RetrievedChunk[]>,
  truncated: ReadonlySet<string>,
): Omit<PackEvidenceOutput, 'chunkProvenance' | 'totalUniqueChunks' | 'totalTokens' | 'truncatedBy'> & {
  truncatedBy: ReadonlyArray<
    'call_result_limit' | 'subquestion_result_limit' | 'turn_chunk_limit' | 'turn_token_limit'
  >;
} {
  const packedSets: PackedSubquestion[] = input.subquestionSets.map((set) => {
    const results = packedBySub.get(set.subquestionId) ?? [];
    const sufficient = results.length >= Math.min(set.requestedCount, input.maxResultsPerSubquestion) &&
      results.length > 0;
    let partialReason: SearchPartialReason | null = null;
    if (!sufficient) {
      if (truncated.has('turn_token_limit')) partialReason = 'turn_token_limit';
      else if (truncated.has('turn_chunk_limit')) partialReason = 'turn_chunk_limit';
      else if (truncated.has('call_result_limit')) partialReason = 'call_result_limit';
      else if (truncated.has('subquestion_result_limit')) partialReason = 'subquestion_result_limit';
      else if (results.length === 0) partialReason = 'candidate_exhausted';
      else partialReason = 'coverage_gap';
    }
    return {
      subquestionId: set.subquestionId,
      results,
      requestedCount: set.requestedCount,
      returnedCount: results.length,
      coverage: sufficient ? ('sufficient' as const) : ('partial' as const),
      partialReason,
    };
  });
  const coverage = packedSets.every((set) => set.coverage === 'sufficient')
    ? ('sufficient' as const)
    : ('partial' as const);
  return {
    packedSets,
    coverage,
    truncatedBy: [...truncated].sort() as ReadonlyArray<
      'call_result_limit' | 'subquestion_result_limit' | 'turn_chunk_limit' | 'turn_token_limit'
    >,
  };
}
