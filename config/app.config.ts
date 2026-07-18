import type { AppConfig } from '@app/domain/app-config';
import {
  PARENT_CHUNK_SIZE,
  CHILD_CHUNK_SIZE,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
} from '@app/domain';

// Runtime configuration for this deployment of the RAG Support Agent.
//
// Edit any field, or run `pnpm configure` to be walked through the values
// interactively. The schema at `@app/domain` validates
// this object on load; required fields have defaults so an empty
// file is valid.
//
// Required externally: nothing. This file is the source of truth for
// org name, agent persona, admin bootstrap emails, and the seed-PDFs
// directory. The setup CLI also writes `ADMIN_EMAILS` to .env.local
// so the Clerk-based admin bootstrap code path keeps working.

const config: AppConfig = {
  // The full name of the org the agent represents. Used in the
  // system prompt and the landing page hero.
  orgName: 'Your Company',

  // Short brand shown in the top nav and mobile sheet.
  orgShortName: 'RAG Support',

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
  // The defaults cover the categories of request a customer-support
  // agent for a BI/dashboard SaaS cannot safely handle. Each rule
  // tells the bot to decline AND open a support ticket rather than
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
  // The setup CLI also writes this list to ADMIN_EMAILS in
  // .env.local so the existing bootstrap code path keeps working.
  adminEmails: [],

  // Browser tab title + meta description.
  branding: {
    title: 'RAG Support',
    description: 'AI customer support agent, with grounded citations.',
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

  // Chunking strategy at ingest (Session 4). Override with the
  // CHUNKING_STRATEGY env var. Default `document-aware` yields
  // per-section `sectionTitle` provenance for richer citations.
  // `parent-child` (Session 5) emits small children + large parent blocks.
  chunkingStrategy: (process.env.CHUNKING_STRATEGY ?? 'document-aware') as AppConfig['chunkingStrategy'],

  // Parent-child indexing (Session 5). Only used when
  // `chunkingStrategy === 'parent-child'`. Sizes are in characters.
  parentChunkSize: PARENT_CHUNK_SIZE,
  childChunkSize: CHILD_CHUNK_SIZE,
  // How `searchChunks` resolves a child hit to context: `parent` returns the
  // parent block; `window` pads the hit with its ±N neighbours.
  parentChildMode: PARENT_CHILD_MODE,
  parentChildWindow: PARENT_CHILD_WINDOW,
};

export default config;
