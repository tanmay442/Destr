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
  retrievalMode: z.enum(['agentic', 'normal']).default('agentic'),
  agentStepBudget: z.coerce.number().int().positive().default(8),
  agenticRetrieveLimit: z.coerce.number().int().positive().default(10),
  agenticMaxRetries: z.coerce.number().int().nonnegative().default(1),
  similarityThreshold: z.coerce.number().min(0).max(1).default(0.5),
  hybridEnabled: z.boolean().default(true),
  rerankerProvider: z.enum(['cosine', 'local', 'cohere']).default('cosine'),
  gradeModel: z.string().optional(),
  answerCacheEnabled: z.boolean().default(true),
  answerCacheTtlSec: z.coerce.number().int().positive().default(3600),
  captureQueryText: z.boolean().default(true),
  retrievalModeRolloutPercent: z.coerce.number().min(0).max(100).default(100),
}).strip();

export type AppConfig = z.infer<typeof appConfigSchema>;

/** Recursively convert a Zod schema into its deep-partial form so a settings
 *  write can validate a partial patch without stripping unspecified fields. */
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