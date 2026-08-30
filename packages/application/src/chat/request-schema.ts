import { z } from 'zod';
import { V4_UUID_REGEX } from './turn-id';
import type { ChatInputMessage, ChatInputPart } from './message-types';

const MAX_TEXT_LENGTH = 50_000;
const MAX_PARTS = 100;
const MAX_TOTAL_TEXT_CHARS = 200_000;

const ALLOWED_PART_TYPE = /^(text|reasoning|file)$/;

const MessagePartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT_LENGTH) }),
  z.object({ type: z.literal('reasoning'), text: z.string().max(MAX_TEXT_LENGTH).optional() }),
  z.object({
    type: z.literal('file'),
    url: z.string().max(2000),
    filename: z.string().max(255).optional(),
    mediaType: z.string().max(255).optional(),
  }),
  z.object({
    type: z.string().refine((type) => !ALLOWED_PART_TYPE.test(type)),
  }),
]);

const MessageSchema = z
  .object({
    id: z.string().optional(),
    // Client may only send user/assistant; system prompts stay server-side to block prompt injection.
    role: z.enum(['user', 'assistant']),
    parts: z.array(MessagePartSchema).max(MAX_PARTS),
  })
  .strip()
  .transform((message): ChatInputMessage => {
    const parts: ChatInputPart[] = [];
    for (const part of message.parts) {
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning') {
        const text = 'text' in part && typeof part.text === 'string' ? part.text : undefined;
        parts.push({
          type: 'reasoning',
          ...(text !== undefined ? { text } : {}),
        });
      } else if (part.type === 'file' && 'url' in part && typeof part.url === 'string') {
        const filename = 'filename' in part && typeof part.filename === 'string' ? part.filename : undefined;
        const mediaType = 'mediaType' in part && typeof part.mediaType === 'string' ? part.mediaType : undefined;
        parts.push({
          type: 'file',
          url: part.url,
          ...(filename !== undefined ? { filename } : {}),
          ...(mediaType !== undefined ? { mediaType } : {}),
        });
      }
    }
    return {
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      parts,
    };
  });

export const ChatRequestSchema = z.object({
  turnId: z.string().regex(V4_UUID_REGEX, 'turnId must be a v4 UUID').optional(),
  conversationId: z.string().regex(V4_UUID_REGEX, 'conversationId must be a v4 UUID').optional(),
  retry: z.boolean().optional(),
  messages: z
    .array(MessageSchema)
    .min(1)
    .max(1000)
    .refine((messages) => {
      let total = 0;
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type === 'text' && typeof part.text === 'string') total += part.text.length;
        }
      }
      return total <= MAX_TOTAL_TEXT_CHARS;
    }, 'Total text length exceeds the per-request budget'),
});
