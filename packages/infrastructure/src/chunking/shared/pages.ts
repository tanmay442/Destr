export interface PageSpan {
  text: string;
  start: number;
  page: number;
}

/** Record per-page text spans and their offsets within a merged string. */
export function buildPageSpans(pages: Array<{ page: number; text: string }>): PageSpan[] {
  const spans: PageSpan[] = [];
  let offset = 0;
  for (const p of pages) {
    spans.push({ text: p.text, start: offset, page: p.page });
    offset += p.text.length + 2;
  }
  return spans;
}

export function pageForOffset(spans: PageSpan[], offset: number): number {
  if (spans.length === 0) return 1;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (offset >= s.start && offset < s.start + s.text.length) return s.page;
    if (offset >= s.start + s.text.length && offset < s.start + s.text.length + 2) {
      return spans[i + 1]?.page ?? s.page;
    }
  }
  return spans[spans.length - 1]!.page;
}
