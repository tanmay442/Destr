import { z } from 'zod';
import { V4_UUID_REGEX } from '@/chat/turn-id';

const MAX_TEXT_LENGTH = 50_000;
const MAX_PARTS = 100;
const MAX_TOTAL_TEXT_CHARS = 200_000;

const ALLOWED_PART_TYPE =
  /^(text|reasoning|file|step-start|dynamic-tool|source-url|source-document|tool-[a-zA-Z0-9_-]+|data-[a-zA-Z0-9_-]+)$/;

const MessagePartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT_LENGTH) }),
  z.object({ type: z.literal('reasoning'), text: z.string().max(MAX_TEXT_LENGTH).optional() }),
  z.object({
    type: z.literal('file'),
    url: z.string().max(2000),
    filename: z.string().max(255).optional(),
    mediaType: z.string().max(255).optional(),
  }),
  z.object({ type: z.string().regex(ALLOWED_PART_TYPE, 'Unsupported message part type') }).passthrough(),
]);

const MessageSchema = z
  .object({
    id: z.string().optional(),
    // Client may only send user/assistant; system prompts stay server-side to block prompt injection.
    role: z.enum(['user', 'assistant']),
    parts: z.array(MessagePartSchema).max(MAX_PARTS),
  })
  .strip();

export const ChatRequestSchema = z.object({
  turnId: z.string().regex(V4_UUID_REGEX, 'turnId must be a v4 UUID').optional(),
  messages: z
    .array(MessageSchema)
    .min(1)
    .max(100)
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