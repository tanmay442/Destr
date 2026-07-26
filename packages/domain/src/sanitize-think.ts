const THINK_PATTERNS = [
  /<\s*think\s*>[\s\S]*?<\/\s*think\s*>/gi,
  /<\s*thought\s*>[\s\S]*?<\/\s*thought\s*>/gi,
  /<antThinking>[\s\S]*?<\/antThinking>/gi,
  /<\s*reasoning\s*>[\s\S]*?<\/\s*reasoning\s*>/gi,
  /<\s*scratchpad\s*>[\s\S]*?<\/\s*scratchpad\s*>/gi,
  /\[\s*thinking\s*\][\s\S]*?\[\s*\/\s*thinking\s*\]/gi,
];

export function stripThinkTraces(input: string): string {
  let result = input;
  for (const re of THINK_PATTERNS) {
    result = result.replace(re, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
