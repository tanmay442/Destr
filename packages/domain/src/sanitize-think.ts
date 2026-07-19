const THINK_RE = /<think>[\s\S]*?<\/think>/gi;

export function stripThinkTraces(input: string): string {
  return input.replace(THINK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
