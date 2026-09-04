import {
  logger,
  MAX_STORED_MESSAGE_BYTES,
} from '@app/domain';
import { capCodePoints } from '../../text';
import type { StoredMessage } from './stored-message';

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

function findLastTextIndex(parts: Array<Record<string, unknown>>): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]?.type === 'text') return i;
  }
  return -1;
}

const STORED_BYTES_TARGET = MAX_STORED_MESSAGE_BYTES - 1_024;

/** Truncate the last text part until the snapshot fits the storage byte cap. */
export function enforceStoredBytes(message: StoredMessage): StoredMessage {
  if (jsonBytes(message) <= STORED_BYTES_TARGET) return message;
  const clone: StoredMessage = {
    ...message,
    parts: message.parts.map((p) => ({ ...p })),
    metadata: {
      ...message.metadata,
      ...(message.metadata.citations ? { citations: [...message.metadata.citations] } : {}),
    },
  };
  const citations = clone.metadata.citations;
  if (citations) {
    while (jsonBytes(clone) > STORED_BYTES_TARGET && citations.length > 0) citations.pop();
    if (citations.length === 0) delete clone.metadata.citations;
  }
  for (;;) {
    const idx = findLastTextIndex(clone.parts);
    if (idx === -1) break;
    const part = clone.parts[idx];
    if (!part) break;
    const text = typeof part.text === 'string' ? part.text : '';
    const chars = [...text];
    if (chars.length === 0) {
      clone.parts.splice(idx, 1);
      continue;
    }
    const bytesWithoutText = jsonBytes(clone) - Buffer.byteLength(text);
    const budget = STORED_BYTES_TARGET - bytesWithoutText - 16;
    if (budget <= 0) {
      clone.parts.splice(idx, 1);
      continue;
    }
    const bytesPerChar = Math.max(1, Math.ceil(Buffer.byteLength(text) / chars.length));
    part.text = capCodePoints(text, Math.floor(budget / bytesPerChar));
    if (jsonBytes(clone) <= STORED_BYTES_TARGET) break;
  }
  while (jsonBytes(clone) > STORED_BYTES_TARGET) {
    const optionalPart = clone.parts.findLastIndex((part) => part.type !== 'text');
    if (optionalPart < 0) break;
    clone.parts.splice(optionalPart, 1);
  }
  if (jsonBytes(clone) > STORED_BYTES_TARGET) {
    return {
      id: capCodePoints(clone.id, 256),
      role: clone.role,
      parts: [],
      metadata: {},
    };
  }
  logger.warn('chat.history.stored_bytes_truncated', {
    bytes: jsonBytes(clone),
  });
  return clone;
}
