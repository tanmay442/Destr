const CLOSED_THINK_RE = /<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi;
const UNCLOSED_THINK_RE = /<(think|thought|reasoning)>[\s\S]*/gi;
const THINK_PREFIX_RE = /(?:Summary:\s*)?Here's a thinking process:[\s\S]*?(?=\{|$)/gi;

export function stripThinkTraces(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(CLOSED_THINK_RE, '')
    .replace(UNCLOSED_THINK_RE, '')
    .replace(THINK_PREFIX_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


