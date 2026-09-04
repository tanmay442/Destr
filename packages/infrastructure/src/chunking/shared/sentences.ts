import { estimateTokens, tokensPerChar } from './tokens';

const ABBREVIATIONS = /\b(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|etc|inc|ltd|co|e\.g|i\.e)\.?$/i;

function hardSplitSpan(
  span: { text: string; start: number },
  maxLen: number,
): Array<{ text: string; start: number }> {
  const boundedMaxLen = Math.max(1, Math.floor(maxLen));
  if (Array.from(span.text).length <= boundedMaxLen) return [span];
  const parts: Array<{ text: string; start: number }> = [];
  const wordRe = /\S+\s*/gu;
  let current = '';
  let currentStart = span.start;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(span.text)) !== null) {
    const token = match[0];
    const tokenLength = Array.from(token).length;
    if (tokenLength > boundedMaxLen) {
      if (current.trim().length > 0) parts.push({ text: current.trim(), start: currentStart });
      current = '';
      const tokenStart = span.start + match.index;
      const tokenCodePoints = Array.from(token);
      let tokenOffset = 0;
      for (let i = 0; i < tokenCodePoints.length; i += boundedMaxLen) {
        const part = tokenCodePoints.slice(i, i + boundedMaxLen).join('');
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          parts.push({ text: trimmed, start: tokenStart + tokenOffset });
        }
        tokenOffset += part.length;
      }
      currentStart = tokenStart + token.length;
      continue;
    }
    if (Array.from(current).length + tokenLength > boundedMaxLen && current.trim().length > 0) {
      parts.push({ text: current.trim(), start: currentStart });
      current = token;
      currentStart = span.start + match.index;
    } else {
      current += token;
    }
  }
  if (current.trim().length > 0) parts.push({ text: current.trim(), start: currentStart });
  return parts;
}

/** Split into sentences at ASCII/CJK terminators (.!?。！？), guarding
 *  abbreviation endings and hard-splitting overlong runs at word boundaries. */
export function splitSentences(
  text: string,
  maxLen = 600,
): Array<{ text: string; start: number }> {
  const maybeSegmenter = (): Array<{ text: string; start: number }> | null => {
    const Seg = (Intl as unknown as { Segmenter?: new (locale: string | undefined, opts: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
    if (!Seg) return null;
    try {
      const segmenter = new Seg(undefined, { granularity: 'sentence' });
      const raw = [...segmenter.segment(text)];
      const out: Array<{ text: string; start: number }> = raw
        .map((segment) => {
          const text = segment.segment.trim();
          return {
            text,
            start: segment.index + segment.segment.length - segment.segment.trimStart().length,
          };
        })
        .filter((segment) => segment.text.length > 0);
      if (out.length === 0) return null;
      const merged: Array<{ text: string; start: number }> = [];
      let buf = '';
      let bufStart = 0;
      const MAX_BUF = 10_000;
      for (const seg of out) {
        if (buf.length > 0 && buf.length + seg.text.length + 1 > MAX_BUF) {
          merged.push({ text: buf.trim(), start: bufStart });
          buf = '';
          bufStart = seg.start;
        }
        const start = buf.length === 0 ? seg.start : bufStart;
        buf = buf.length === 0 ? seg.text : `${buf} ${seg.text}`;
        if (!ABBREVIATIONS.test(buf.trim())) {
          merged.push({ text: buf.trim(), start });
          buf = '';
          bufStart = seg.start + seg.text.length;
        } else {
          if (buf.length === seg.text.length) bufStart = start;
        }
      }
      if (buf.trim().length > 0) merged.push({ text: buf.trim(), start: bufStart });
      const source = merged.length > 0 ? merged : out;
      return source.flatMap((span) => hardSplitSpan(span, maxLen));
    } catch {
      return null;
    }
  };
  const segResult = maybeSegmenter();
  if (segResult) return segResult;
  // Mask internal dots that are NOT sentence terminators (decimals, versions, URLs, filenames).
  const MASK = String.fromCharCode(1);
  const masked = text.replace(/\.(?=\S)/g, MASK);

  const out: Array<{ text: string; start: number }> = [];
  const re = /[^.!?。！？]+[.!?。！？]+/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let buf = '';
  let bufStart = 0;
  // Cap the abbreviation-accumulation buffer: text like "Dr. Dr. Dr. …" would
  // otherwise make every iteration re-trim a growing string (O(n²)). When the
  // cap is exceeded, emit what has accumulated plainly and keep abbreviation
  // detection on the remainder. hardSplit already bounds output at maxLen.
  const MAX_BUF = 10_000;
  while ((m = re.exec(masked)) !== null) {
    const piece = m[0].split(MASK).join(".");
    if (buf.length > 0 && buf.length + piece.length > MAX_BUF) {
      out.push({ text: buf.trim(), start: bufStart });
      buf = '';
      bufStart = m.index;
    }
    const pieceStart = m.index + piece.length - piece.trimStart().length;
    const start = buf.length === 0 ? pieceStart : bufStart;
    buf += piece;
    if (!ABBREVIATIONS.test(buf.trim())) {
      out.push({ text: buf.trim(), start });
      buf = '';
      bufStart = m.index + piece.length;
    }
    lastEnd = m.index + piece.length;
  }
  const tail = masked.slice(lastEnd);
  if (tail.trim().length > 0) {
    const tailText = tail.split(MASK).join(".");
    if (buf.length === 0) bufStart = lastEnd + tailText.length - tailText.trimStart().length;
    buf += tailText;
  }
  if (buf.trim().length > 0) out.push({ text: buf.trim(), start: bufStart });

  return out.flatMap((span) => hardSplitSpan(span, maxLen));
}

/** Group sentences into chunks no larger than `maxSize` chars (or `tokenCap`
 *  tokens when `modelId` is given), carrying an `overlap`-char suffix over. */
export function chunkBySentences(
  text: string,
  maxSize: number,
  overlap: number,
  modelId?: string,
  tokenCap?: number,
): string[] {
  const boundedMaxSize = Math.max(1, Math.floor(maxSize));
  const boundedOverlap = Math.max(0, Math.floor(overlap));
  const boundedTokenCap = tokenCap === undefined ? undefined : Math.max(1, Math.floor(tokenCap));
  const tokenMaxSize = modelId && boundedTokenCap !== undefined
    ? Math.floor(boundedTokenCap / tokensPerChar(modelId))
    : boundedMaxSize;
  const effectiveMaxSize = Math.max(1, Math.min(boundedMaxSize, tokenMaxSize));
  const fits = (value: string): boolean => {
    if (Array.from(value).length > effectiveMaxSize) return false;
    if (modelId && boundedTokenCap !== undefined && estimateTokens(value, modelId) > boundedTokenCap) return false;
    return true;
  };
  const sentences = splitSentences(text, effectiveMaxSize).map((sentence) => sentence.text);
  if (sentences.length <= 1) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    if (fits(trimmed)) return [trimmed];
    return hardSplitSpan({ text: trimmed, start: text.indexOf(trimmed) }, effectiveMaxSize).map((part) => part.text);
  }
  const chunks: string[] = [];
  let current = sentences[0]!;
  for (let i = 1; i < sentences.length; i++) {
    const next = sentences[i]!;
    if (fits(current + ' ' + next)) {
      current = current + ' ' + next;
    } else {
      chunks.push(current);
      const currentCodePoints = Array.from(current);
      const carryCodePointLength = Math.min(boundedOverlap, currentCodePoints.length);
      let carry = carryCodePointLength > 0
        ? currentCodePoints.slice(currentCodePoints.length - carryCodePointLength).join('')
        : '';
      const firstSpace = carry.indexOf(' ');
      if (firstSpace >= 0) carry = carry.slice(firstSpace + 1);
      const candidate = carry.trim() ? `${carry.trim()} ${next}` : next;
      current = carry.trim() && fits(candidate) ? candidate : next;
    }
  }
  chunks.push(current);
  return chunks;
}
