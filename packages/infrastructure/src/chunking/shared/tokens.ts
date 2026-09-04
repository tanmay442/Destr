/** Tokens per char per embedding model; defaults to 1 (CJK ≈ 1 token/char),
 *  ~0.25 for English-heavy models. Gates child size on tokens. */
const TOKENS_PER_CHAR: Record<string, number> = {
  'text-embedding-3-small': 0.25,
  'text-embedding-3-large': 0.25,
  'text-embedding-ada-002': 0.25,
  'gemini-embedding-001': 0.25,
  'gemini-embedding-002': 0.25,
};

export function tokensPerChar(modelId: string): number {
  const exact = TOKENS_PER_CHAR[modelId];
  if (exact !== undefined) return exact;
  if (modelId.startsWith('gemini-embedding') || modelId.startsWith('embeddinggemma')) return 0.25;
  return 1;
}

export function estimateTokens(text: string, modelId: string): number {
  return Math.ceil(text.length * tokensPerChar(modelId));
}

/** Default hard token cap applied to child chunks (keeps well under typical
 *  512/768-token embedding limits once overlap and metadata are added). */
export const CHILD_TOKEN_CAP = 400;

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const rank = Math.min(100, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (rank / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function semanticSplitCutoff(
  distances: number[],
  percentileRank = 90,
  absoluteFloor = 0.1,
): number {
  if (distances.length === 0) return Number.POSITIVE_INFINITY;
  return Math.max(percentile(distances, percentileRank), absoluteFloor);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
