import { z } from 'zod';

const toneSchema = z.enum(['friendly', 'formal', 'casual', 'concise']);

const outOfScopeTopicSchema = z.object({
  topic: z.string().min(1),
  handling: z.string().min(1),
});

export const appConfigSchema = z.object({
  orgName: z.string().min(1).default('Your Company'),
  orgShortName: z.string().min(1).default('RAG Agent'),
  audience: z
    .string()
    .min(1)
    .default('your users'),
  agentPersona: z
    .object({
      name: z.string().min(1).optional(),
      tone: toneSchema.default('friendly'),
    })
    .default({ name: 'Astra', tone: 'friendly' }),
  customInstructions: z.string().optional(),
  outOfScopeTopics: z
    .array(outOfScopeTopicSchema)
    .default([
      {
        topic: 'security-incident reporting',
        handling:
          'Decline to troubleshoot. Explain that you are opening a `security-incident` ticket to escalate the issue immediately. Do not ask for or collect credentials, tokens, or sensitive personal data.',
      },
      {
        topic: 'account-takeover claims',
        handling:
          'Decline to investigate. Open a `security-incident` ticket immediately. Do not discuss account status or sensitive logs in the chat.',
      },
      {
        topic: 'refund or chargeback negotiation',
        handling:
          'Decline to negotiate. Open a standard support or billing ticket for review. Avoid making promises regarding credits, refunds, or policy waivers.',
      },
      {
        topic: 'custom contract terms / DPAs / legal review',
        handling:
          'Decline to interpret, draft, or agree to custom legal language. Open a ticket for team review.',
      },
      {
        topic: 'medical',
        handling:
          'Decline politely and advise the user to contact a qualified medical professional.',
      },
      {
        topic: 'legal',
        handling:
          'Decline politely and advise the user to consult a qualified legal professional.',
      },
      {
        topic: 'personal advice',
        handling:
          'Decline politely and steer the conversation back to the assistant\'s primary topic.',
      },
    ]),
  adminEmails: z.array(z.email()).default([]),
  branding: z
    .object({
      title: z.string().min(1).default('RAG Assistant'),
      description: z
        .string()
        .min(1)
        .default(
          'Grounded AI assistant with tool-use capabilities.',
        ),
    })
    .default({
      title: 'RAG Assistant',
      description:
        'Grounded AI assistant with tool-use capabilities.',
    }),
  seedDocsDir: z.string().min(1).default('./documents'),
  prefetchFirstTurn: z.boolean().default(false),
  chunkingStrategy: z
    .enum(['document-aware', 'recursive-adaptive', 'semantic', 'parent-child'])
    .default('document-aware'),
  parentChunkSize: z.coerce.number().int().positive().default(1800),
  childChunkSize: z.coerce.number().int().positive().default(400),
  parentChildMode: z.enum(['parent', 'window']).default('parent'),
  parentChildWindow: z.coerce.number().int().nonnegative().default(2),
});

export type AppConfig = z.infer<typeof appConfigSchema>;