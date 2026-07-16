import { z } from 'zod';

const MAX_TEXT_LENGTH = 50_000;

// Allowlist of UI message part `type` values the AI SDK v3 `useChat` client
// may round-trip back to us. The agentic loop emits `step-start`, tool
// invocations emit `tool-*` (incl. dynamic tools and approval/input/output
// phases), and grounded answers may include `source-url`/`source-document`.
// `data-*` covers our custom citation/guardrail control parts.
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

export const ChatRequestSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string().optional(),
      // Client may only send user/assistant; system prompts stay server-side to block prompt injection.
      role: z.enum(['user', 'assistant']),
      parts: z.array(MessagePartSchema),
    }).strip(),
  ).max(100),
});
