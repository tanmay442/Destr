import { validateChatFile } from '@app/application/chat';
import type { MyUIMessage } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface StoredContent {
  id?: unknown;
  role?: unknown;
  parts?: unknown;
  metadata?: unknown;
}

export type ResolvedStoredContent = StoredContent;

export function extractContentParts(content: StoredContent): MyUIMessage['parts'] {
  const rawParts = Array.isArray(content.parts) ? content.parts : [];
  const parts: MyUIMessage['parts'] = [];

  for (const part of rawParts) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (type === 'reasoning') {
      const reasoning: { type: 'reasoning'; text?: string } = { type: 'reasoning' };
      if (typeof part.text === 'string') reasoning.text = part.text;
      parts.push(reasoning as unknown as MyUIMessage['parts'][number]);
    } else if (type === 'file' && typeof part.url === 'string') {
      const file = validateChatFile({
        url: part.url,
        ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
        ...(typeof part.mediaType === 'string' ? { mediaType: part.mediaType } : {}),
      });
      if (file.kind === 'valid') {
        parts.push(file.file as unknown as MyUIMessage['parts'][number]);
      }
    }
  }

  return parts;
}
