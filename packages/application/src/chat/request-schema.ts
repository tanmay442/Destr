import { z } from 'zod';
import {
  CHAT_FILE_MAX_FILENAME_LENGTH,
  CHAT_FILE_MAX_PER_MESSAGE,
  CHAT_FILE_MAX_PER_REQUEST,
  CHAT_FILE_MAX_URL_LENGTH,
  CHAT_FILE_METADATA_MAX_BYTES,
} from '@app/domain';
import { V4_UUID_REGEX } from './turn-id';
import type { ChatInputMessage, ChatInputPart } from './message-types';
import { validateChatFile } from './chat-file';

const MAX_TEXT_LENGTH = 50_000;
const MAX_PARTS = 100;
const MAX_TOTAL_TEXT_CHARS = 200_000;

const ALLOWED_PART_TYPE = /^(text|reasoning|file)$/;

function hasUsableLastUserContent(messages: ChatInputMessage[]): boolean {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage) return false;

  return lastUserMessage.parts.some((part) =>
    part.type === 'file' || (part.type === 'text' && part.text.trim() !== ''),
  );
}

function createMessageSchema(allowedFileOrigins?: ReadonlySet<string>) {
  const filePartSchema = z.object({
    type: z.literal('file'),
    url: z.string().max(CHAT_FILE_MAX_URL_LENGTH),
    filename: z.string().max(CHAT_FILE_MAX_FILENAME_LENGTH).optional(),
    mediaType: z.string().optional(),
  }).superRefine((part, ctx) => {
    const result = validateChatFile({ ...part, ...(allowedFileOrigins ? { allowedOrigins: allowedFileOrigins } : {}) });
    if (result.kind === 'invalid') ctx.addIssue({ code: 'custom', message: result.reason });
  });

  const messagePartSchema = z.union([
    z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT_LENGTH) }),
    z.object({ type: z.literal('reasoning'), text: z.string().max(MAX_TEXT_LENGTH).optional() }),
    filePartSchema,
    z.object({
      type: z.string().refine((type) => !ALLOWED_PART_TYPE.test(type)),
    }),
  ]);

  return z
  .object({
    id: z.string().optional(),
    // Client may only send user/assistant; system prompts stay server-side to block prompt injection.
    role: z.enum(['user', 'assistant']),
    parts: z.array(messagePartSchema).max(MAX_PARTS),
  })
  .strip()
  .refine(
    (message) => message.parts.filter((part) => part.type === 'file').length <= CHAT_FILE_MAX_PER_MESSAGE,
    `At most ${CHAT_FILE_MAX_PER_MESSAGE} files are allowed per message`,
  )
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
        const validated = validateChatFile({
          url: part.url,
          filename,
          mediaType,
          ...(allowedFileOrigins ? { allowedOrigins: allowedFileOrigins } : {}),
        });
        if (validated.kind === 'valid') parts.push(validated.file);
      }
    }
    return {
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      parts,
    };
  });
}

export function createChatRequestSchema(allowedFileOrigins?: ReadonlySet<string>) {
  const messageSchema = createMessageSchema(allowedFileOrigins);
  return z.object({
  turnId: z.string().regex(V4_UUID_REGEX, 'turnId must be a v4 UUID').optional(),
  conversationId: z.string().regex(V4_UUID_REGEX, 'conversationId must be a v4 UUID').optional(),
  retry: z.boolean().optional(),
  messages: z
    .array(messageSchema)
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
    }, 'Total text length exceeds the per-request budget')
    .refine(
      (messages) => messages.reduce(
        (total, message) => total + message.parts.filter((part) => part.type === 'file').length,
        0,
      ) <= CHAT_FILE_MAX_PER_REQUEST,
      `At most ${CHAT_FILE_MAX_PER_REQUEST} files are allowed per request`,
    )
    .refine((messages) => {
      const metadata = messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === 'file')
          .map((part) => JSON.stringify(part)),
      ).join('');
      return new TextEncoder().encode(metadata).byteLength <= CHAT_FILE_METADATA_MAX_BYTES;
    }, 'File metadata exceeds the per-request budget')
    .refine(
      hasUsableLastUserContent,
      'The last user message must contain text or a file',
    ),
  });
}

/** Permissive schema retained for trusted internal callers and unit tests. */
export const ChatRequestSchema = createChatRequestSchema();
