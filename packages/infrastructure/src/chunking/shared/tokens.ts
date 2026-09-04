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
