import type { AppConfig } from '@app/domain/app-config';
import {
  SIMILARITY_THRESHOLD,
  PARENT_CHUNK_SIZE,
  CHILD_CHUNK_SIZE,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  AGENT_STEP_BUDGET,
  AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES,
  HYBRID_ENABLED,
  RERANKER_PROVIDER,
  GRADE_MODEL,
  ANSWER_CACHE_ENABLED,
  ANSWER_CACHE_TTL_SEC,
  AGENTIC_ENABLED,
} from '@app/domain';

// Runtime configuration for this deployment. Edit any field here or run
// `pnpm configure`; the schema at `@app/domain` validates it on load.
const config: AppConfig = {
  // The full name of the org the agent represents. Used in the
  // system prompt and the landing page hero.
  orgName: 'Your Company',

  // Who the agent is talking to. Phrased as a noun phrase; the
  // system prompt builds "help <audience> find answers ...".
  audience: 'your customers',

  // Persona. `name` is optional; if set, the agent introduces itself
  // by name on the first reply. `tone` controls length and warmth.
  agentPersona: {
    name: 'Astra',
    tone: 'friendly',
  },

  // Free-form additions to the system prompt. Use this for org-
  // specific rules the persona / out-of-scope lists don't cover
  // (e.g. "Always sign off with '— The Front Office'").
  customInstructions: undefined,

  // Topics the agent should refuse to answer and how to redirect.
  // The defaults cover the categories of request a knowledge
  // agent for a BI/dashboard SaaS cannot safely handle. Each rule
  // tells the bot to decline AND open a knowledge ticket rather than
  // improvise.
  outOfScopeTopics: [
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
  ],

  // Bootstrap admin emails. The first time a user with one of these
  // emails signs in via Clerk, they are auto-promoted to `admin`.
  // After that, admins promote others from /admin/users.
  adminEmails: [],

  // Browser tab title + meta description.
  branding: {
    title: 'RAG Knowledge Agent',
    description: 'AI knowledge agent, with grounded citations.',
  },

  // Where the setup CLI drops seed PDFs and where `pnpm seed`
  // ingests from. Relative to the repo root.
  seedDocsDir: './documents',

  // When true, the chat route pre-embeds the user's first message
  // and injects top-K chunks into the system prompt, so the model
  // has grounded context even if it does not call the search tool
  // itself. Set false to disable the pre-fetch and rely on the
  // model to call the tool every turn.
  prefetchFirstTurn: false,

  // Chunking strategy at ingest. Override with the CHUNKING_STRATEGY env var.
  // Default `document-aware` yields per-section `sectionTitle` provenance.
  // `parent-child` emits small children + large parent blocks.
  chunkingStrategy: (process.env.CHUNKING_STRATEGY ?? 'document-aware') as AppConfig['chunkingStrategy'],

  // Parent-child indexing. Only used when `chunkingStrategy === 'parent-child'`.
  parentChunkSize: PARENT_CHUNK_SIZE,
  childChunkSize: CHILD_CHUNK_SIZE,
  // How `searchChunks` resolves a child hit to context: `parent` returns the
  // parent block; `window` pads the hit with its ±N neighbours.
  parentChildMode: PARENT_CHILD_MODE,
  parentChildWindow: PARENT_CHILD_WINDOW,

  retrievalMode: AGENTIC_ENABLED ? 'agentic' : 'normal',
  agentStepBudget: AGENT_STEP_BUDGET,
  agenticRetrieveLimit: AGENTIC_RETRIEVE_LIMIT,
  agenticMaxRetries: AGENTIC_MAX_RETRIES,
  similarityThreshold: SIMILARITY_THRESHOLD,
  hybridEnabled: HYBRID_ENABLED,
  rerankerProvider: RERANKER_PROVIDER,
  gradeModel: GRADE_MODEL || undefined,
  answerCacheEnabled: ANSWER_CACHE_ENABLED,
  answerCacheTtlSec: ANSWER_CACHE_TTL_SEC,
  captureQueryText: true,
  retrievalModeRolloutPercent: 100,
};

export default config;
