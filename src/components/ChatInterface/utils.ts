import type { MyUIMessage } from '@/composition';

export type FeedbackVote = 1 | -1;

export const FEEDBACK_RETRY_DELAY_MS = 1500;

export function uuidv4(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function errorDigest(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return undefined;
  let hash = 2166136261;
  for (let i = 0; i < message.length; i += 1) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ref-${(hash >>> 0).toString(36)}`;
}

export function uniqueIds(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === 'number'))];
}

export function postFeedback(payload: {
  turnId: string;
  feedback: FeedbackVote;
  documentIds?: number[];
  chunkIds?: number[];
}): Promise<Response> {
  return fetch('/api/chat/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export const QUICK_PROMPTS: Array<{ label: string; text: string }> = [
  { label: 'Reset password', text: 'How do I change my password?' },
  { label: 'Invite teammate', text: 'How do I invite a teammate?' },
  { label: 'API rate limit', text: "What's the API rate limit on the Team plan?" },
  { label: 'Open a ticket', text: "I'd like to open a knowledge ticket." },
];

export function precedingUserMessageId(
  messages: MyUIMessage[],
  assistant: MyUIMessage,
): string | undefined {
  const index = messages.findIndex((m) => m.id === assistant.id);
  for (let i = index >= 0 ? index - 1 : messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') return m.id;
  }
  return undefined;
}
