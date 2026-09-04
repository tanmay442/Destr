import { CHILD_TOKEN_CAP, estimateTokens, percentile } from '../../packages/infrastructure/src/chunking/shared';

export interface MetricChunk {
  content: string;
  sectionTitle?: string | null | undefined;
  kind?: string | undefined;
}

export interface ChunkMetrics {
  count: number;
  meanChars: number;
  p95Chars: number;
  maxChars: number;
  meanTokens: number;
  p95Tokens: number;
  overCapShare: number;
  emptyShare: number;
  duplicateShare: number;
  sectionCoverage: number;
}

export interface ChunkMetricsOptions {
  modelId?: string | undefined;
  tokenCap?: number | undefined;
}

function normalize(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeChunkMetrics(
  chunks: MetricChunk[],
  opts: ChunkMetricsOptions = {},
): ChunkMetrics {
  const modelId = opts.modelId ?? 'text-embedding-3-small';
  const tokenCap = opts.tokenCap ?? CHILD_TOKEN_CAP;
  const count = chunks.length;
  if (count === 0) {
    return {
      count: 0,
      meanChars: 0,
      p95Chars: 0,
      maxChars: 0,
      meanTokens: 0,
      p95Tokens: 0,
      overCapShare: 0,
      emptyShare: 0,
      duplicateShare: 0,
      sectionCoverage: 0,
    };
  }
  const charLens = chunks.map((c) => Array.from(c.content).length);
  const tokenLens = chunks.map((c) => estimateTokens(c.content, modelId));
  const empty = chunks.filter((c) => c.content.trim().length === 0).length;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of chunks) {
    const key = normalize(c.content);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  const withSection = chunks.filter((c) => (c.sectionTitle ?? '').trim().length > 0).length;
  return {
    count,
    meanChars: round2(mean(charLens)),
    p95Chars: round2(percentile(charLens, 95)),
    maxChars: Math.max(...charLens),
    meanTokens: round2(mean(tokenLens)),
    p95Tokens: round2(percentile(tokenLens, 95)),
    overCapShare: round2(tokenLens.filter((t) => t > tokenCap).length / count),
    emptyShare: round2(empty / count),
    duplicateShare: round2(duplicates / count),
    sectionCoverage: round2(withSection / count),
  };
}

export function formatMetricsRow(name: string, m: ChunkMetrics): string {
  const cells = [
    name.padEnd(18),
    String(m.count).padStart(6),
    String(m.meanChars).padStart(9),
    String(m.p95Chars).padStart(8),
    String(m.meanTokens).padStart(10),
    String(m.overCapShare).padStart(8),
    String(m.emptyShare).padStart(7),
    String(m.duplicateShare).padStart(9),
    String(m.sectionCoverage).padStart(8),
  ];
  return cells.join(' ');
}

export function metricsTableHeader(): string {
  return [
    'strategy'.padEnd(18),
    'count'.padStart(6),
    'meanChars'.padStart(9),
    'p95Chars'.padStart(8),
    'meanTokens'.padStart(10),
    'overCap'.padStart(8),
    'empty'.padStart(7),
    'duplicates'.padStart(9),
    'section'.padStart(8),
  ].join(' ');
}
