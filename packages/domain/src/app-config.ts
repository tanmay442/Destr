import { z } from 'zod';

const toneSchema = z.enum(['friendly', 'formal', 'casual', 'concise']);

const outOfScopeTopicSchema = z.object({
  topic: z.string().min(1),
  handling: z.string().min(1),
});

export const appConfigSchema = z.object({
  orgName: z.string().min(1).default('Your Company'),
  audience: z
    .string()
    .min(1)
    .default('your users'),
  agentPersona: z
    .object({
      name: z.string().min(1).optional(),
      tone: toneSchema.default('friendly'),
    })
    .default({ name: 'Destr', tone: 'friendly' }),
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
      title: z.string().min(1).default('Destr'),
      description: z
        .string()
        .min(1)
        .default(
          'Grounded AI assistant with tool-use capabilities.',
        ),
    })
    .default({
      title: 'Destr',
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
  retrievalMode: z.enum(['agentic', 'normal']).default('agentic'),
  agentStepBudget: z.coerce.number().int().positive().default(8),
  agenticRetrieveLimit: z.coerce.number().int().positive().default(10),
  agenticMaxRetries: z.coerce.number().int().nonnegative().default(1),
  similarityThreshold: z.coerce.number().min(0).max(1).default(0.5),
  hybridEnabled: z.boolean().default(true),
  // §B1 per-step agentic pipeline toggles (all default ON, strict booleans).
  agenticQueryRewriteEnabled: z.boolean().default(true),
  agenticChunkGradingEnabled: z.boolean().default(true),
  hallucinationCheckEnabled: z.boolean().default(true),
  rerankerProvider: z.enum(['cosine', 'local', 'cohere']).default('cosine'),
  gradeModel: z.string().optional(),
  answerCacheEnabled: z.boolean().default(true),
  answerCacheTtlSec: z.coerce.number().int().positive().default(3600),
  captureQueryText: z.boolean().default(true),
  // Auto-delete window for saved chats. 0 = Off (never auto-delete).
  chatHistoryRetentionDays: z
    .union([z.literal(0), z.literal(30), z.literal(120), z.literal(365)])
    .default(120),
  retrievalModeRolloutPercent: z.coerce.number().min(0).max(100).default(100),
}).strip();

export type AppConfig = z.infer<typeof appConfigSchema>;

type SchemaDef = {
  type?: string;
  shape?: Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
};

function deepPartial(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def: SchemaDef | undefined = (schema as { _def?: SchemaDef })._def;
  switch (def?.type) {
    case 'object': {
      const shape = def.shape ?? {};
      const out: Record<string, z.ZodTypeAny> = {};
      for (const key of Object.keys(shape)) {
        const field = shape[key];
        if (field) out[key] = deepPartial(field);
      }
      return z.object(out);
    }
    case 'default':
    case 'optional': {
      const inner = def.innerType;
      return (inner ? deepPartial(inner) : schema).optional();
    }
    case 'array': {
      const el = def.element;
      return (el ? deepPartial(el) : z.unknown()).array().optional();
    }
    case 'nullable': {
      const inner = def.innerType;
      return (inner ? deepPartial(inner) : z.unknown()).nullable().optional();
    }
    default:
      return schema.optional();
  }
}

export const partialAppConfigSchema = deepPartial(appConfigSchema) as unknown as z.ZodType<Partial<AppConfig>>;
