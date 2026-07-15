import { z } from 'zod';

const toneSchema = z.enum(['friendly', 'formal', 'casual', 'concise']);

const outOfScopeTopicSchema = z.object({
  topic: z.string().min(1),
  handling: z.string().min(1),
});

export const appConfigSchema = z.object({
  orgName: z.string().min(1).default('Your Company'),
  orgShortName: z.string().min(1).default('RAG Support'),
  audience: z
    .string()
    .min(1)
    .default('your customers'),
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
          'Decline to troubleshoot. Tell the user you are opening a `security-incident` ticket so a security engineer can contact them within 1 business hour. Do not ask for credentials, account details, or any sensitive information in the chat.',
      },
      {
        topic: 'account-takeover claims',
        handling:
          'Decline to investigate. Open a `security-incident` ticket immediately. Do not discuss account state, last-login times, or any account data in the chat.',
      },
      {
        topic: 'refund or chargeback negotiation',
        handling:
          'Decline to negotiate. Open a `billing-dispute` ticket so a billing specialist can review the account. The bot must not promise credits, refunds, or waivers of any kind.',
      },
      {
        topic: 'custom contract terms / DPAs / legal review',
        handling:
          'Decline to draft, interpret, or commit to any custom contractual language. Open a `legal-request` ticket and tell the user a contracts specialist will respond within 2 business days.',
      },
      {
        topic: 'medical',
        handling:
          'Decline politely and suggest they contact a qualified medical professional directly.',
      },
      {
        topic: 'legal',
        handling:
          'Decline politely and suggest they consult a qualified lawyer directly.',
      },
      {
        topic: 'personal advice',
        handling:
          'Decline politely. This assistant is for this product only.',
      },
    ]),
  adminEmails: z.array(z.email()).default([]),
  branding: z
    .object({
      title: z.string().min(1).default('RAG Support'),
      description: z
        .string()
        .min(1)
        .default(
          'AI customer support agent, with grounded citations.',
        ),
    })
    .default({
      title: 'RAG Support',
      description:
        'AI customer support agent, with grounded citations.',
    }),
  seedDocsDir: z.string().min(1).default('./documents'),
  prefetchFirstTurn: z.boolean().default(false),
  /** Chunking strategy used at ingest (Session 4). `document-aware` is the
   *  default and produces `sectionTitle` provenance; override via the
   *  `CHUNKING_STRATEGY` env var. `pre-chunked` is handled by the dedicated
   *  pre-chunked ingest path and is intentionally not selectable here. */
  chunkingStrategy: z
    .enum(['document-aware', 'recursive-adaptive', 'semantic'])
    .default('document-aware'),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
