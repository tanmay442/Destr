import { z } from 'zod';

const toneSchema = z.enum(['friendly', 'formal', 'casual', 'concise']);

const outOfScopeTopicSchema = z.object({
  topic: z.string().min(1),
  handling: z.string().min(1),
});

const agentPersonaSchema = z.object({
  name: z.string().min(1).optional(),
  tone: toneSchema.default('friendly'),
});

const brandingSchema = z.object({
  title: z.string().min(1).default('Destr'),
  description: z
    .string()
    .min(1)
    .default('Grounded AI assistant with tool-use capabilities.'),
});

export const appConfigSchema = z.object({
  orgName: z.string().min(1).default('Your Company'),
  audience: z
    .string()
    .min(1)
    .default('your users'),
  agentPersona: agentPersonaSchema.default({ name: 'Destr', tone: 'friendly' }),
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
  branding: brandingSchema.default({
    title: 'Destr',
    description: 'Grounded AI assistant with tool-use capabilities.',
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
  retrievalMode: z.enum(['agentic', 'normal']).default('agentic'),
  agentStepBudget: z.coerce.number().int().positive().default(8),
  agenticRetrieveLimit: z.coerce.number().int().positive().default(10),
  agenticMaxRetries: z.coerce.number().int().nonnegative().default(1),
  similarityThreshold: z.coerce.number().min(0).max(1).default(0.5),
  hybridEnabled: z.boolean().default(true),
  agenticQueryRewriteEnabled: z.boolean().default(true),
  hallucinationCheckEnabled: z.boolean().default(true),
  judgeSampleRate: z.coerce.number().min(0).max(1).default(0.02),
  rerankerProvider: z.enum(['cosine', 'local', 'cohere']).default('cosine'),
  auxModel: z.string().optional(),
  answerCacheEnabled: z.boolean().default(true),
  answerCacheTtlSec: z.coerce.number().int().positive().default(3600),
  captureQueryText: z.boolean().default(true),
  chatHistoryRetentionDays: z
    .union([z.literal(0), z.literal(30), z.literal(120), z.literal(365)])
    .default(120),
  retrievalModeRolloutPercent: z.coerce.number().min(0).max(100).default(100),
}).strip();

export type AppConfig = z.infer<typeof appConfigSchema>;

type DeepPartial<T> = T extends readonly (infer Element)[]
  ? Array<DeepPartial<Element>>
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> | undefined }
    : T;

const appConfigShape = appConfigSchema.shape;

const partialAgentPersonaSchema = z.object({
  name: agentPersonaSchema.shape.name,
  tone: agentPersonaSchema.shape.tone.removeDefault().optional(),
}).strict();

const partialOutOfScopeTopicSchema = z.object({
  topic: outOfScopeTopicSchema.shape.topic.optional(),
  handling: outOfScopeTopicSchema.shape.handling.optional(),
}).strict();

const partialBrandingSchema = z.object({
  title: brandingSchema.shape.title.removeDefault().optional(),
  description: brandingSchema.shape.description.removeDefault().optional(),
}).strict();

export const partialAppConfigSchema = z.object({
  orgName: appConfigShape.orgName.removeDefault().optional(),
  audience: appConfigShape.audience.removeDefault().optional(),
  agentPersona: partialAgentPersonaSchema.optional(),
  customInstructions: appConfigShape.customInstructions,
  outOfScopeTopics: z.array(partialOutOfScopeTopicSchema).optional(),
  adminEmails: appConfigShape.adminEmails.removeDefault().optional(),
  branding: partialBrandingSchema.optional(),
  seedDocsDir: appConfigShape.seedDocsDir.removeDefault().optional(),
  prefetchFirstTurn: appConfigShape.prefetchFirstTurn.removeDefault().optional(),
  chunkingStrategy: appConfigShape.chunkingStrategy.removeDefault().optional(),
  parentChunkSize: appConfigShape.parentChunkSize.removeDefault().optional(),
  childChunkSize: appConfigShape.childChunkSize.removeDefault().optional(),
  parentChildMode: appConfigShape.parentChildMode.removeDefault().optional(),
  parentChildWindow: appConfigShape.parentChildWindow.removeDefault().optional(),
  retrievalMode: appConfigShape.retrievalMode.removeDefault().optional(),
  agentStepBudget: appConfigShape.agentStepBudget.removeDefault().optional(),
  agenticRetrieveLimit: appConfigShape.agenticRetrieveLimit.removeDefault().optional(),
  agenticMaxRetries: appConfigShape.agenticMaxRetries.removeDefault().optional(),
  similarityThreshold: appConfigShape.similarityThreshold.removeDefault().optional(),
  hybridEnabled: appConfigShape.hybridEnabled.removeDefault().optional(),
  agenticQueryRewriteEnabled: appConfigShape.agenticQueryRewriteEnabled.removeDefault().optional(),
  hallucinationCheckEnabled: appConfigShape.hallucinationCheckEnabled.removeDefault().optional(),
  judgeSampleRate: appConfigShape.judgeSampleRate.removeDefault().optional(),
  rerankerProvider: appConfigShape.rerankerProvider.removeDefault().optional(),
  auxModel: appConfigShape.auxModel,
  answerCacheEnabled: appConfigShape.answerCacheEnabled.removeDefault().optional(),
  answerCacheTtlSec: appConfigShape.answerCacheTtlSec.removeDefault().optional(),
  captureQueryText: appConfigShape.captureQueryText.removeDefault().optional(),
  chatHistoryRetentionDays: appConfigShape.chatHistoryRetentionDays.removeDefault().optional(),
  retrievalModeRolloutPercent: appConfigShape.retrievalModeRolloutPercent.removeDefault().optional(),
}).strict() satisfies z.ZodType<DeepPartial<AppConfig>>;
