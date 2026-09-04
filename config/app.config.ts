import type { AppConfig } from '@app/domain/app-config';
import { SIMILARITY_THRESHOLD, JUDGE_SAMPLE_RATE } from '@app/domain';
import {
  PARENT_CHUNK_SIZE,
  CHILD_CHUNK_SIZE,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  RSE_PENALTY,
  RSE_MAX_SEGMENT_CHUNKS,
  RSE_OVERALL_MAX_CHUNKS,
  RSE_MIN_SEGMENT_VALUE,
  AGENT_STEP_BUDGET,
  AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES,
  HYBRID_ENABLED,
  RERANKER_PROVIDER,
  AUX_MODEL,
  ANSWER_CACHE_ENABLED,
  ANSWER_CACHE_TTL_SEC,
  AGENTIC_ENABLED,
  CHUNKING_STRATEGY,
} from '@app/infrastructure/config';

const config: AppConfig = {
  orgName: 'Your Company',
  audience: 'your customers',
  agentPersona: {
    name: 'Destr',
    tone: 'friendly',
  },
  customInstructions: undefined,
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
  adminEmails: [],
  branding: {
    title: 'Destr',
    description: 'RAG knowledge agent with grounded citations.',
  },
  seedDocsDir: './documents',
  prefetchFirstTurn: false,
  chunkingStrategy: CHUNKING_STRATEGY as AppConfig['chunkingStrategy'],
  parentChunkSize: PARENT_CHUNK_SIZE,
  childChunkSize: CHILD_CHUNK_SIZE,
  parentChildMode: PARENT_CHILD_MODE,
  parentChildWindow: PARENT_CHILD_WINDOW,
  rsePenalty: RSE_PENALTY,
  rseMaxSegmentChunks: RSE_MAX_SEGMENT_CHUNKS,
  rseOverallMaxChunks: RSE_OVERALL_MAX_CHUNKS,
  rseMinSegmentValue: RSE_MIN_SEGMENT_VALUE,
  retrievalMode: AGENTIC_ENABLED ? 'agentic' : 'normal',
  agentStepBudget: AGENT_STEP_BUDGET,
  agenticRetrieveLimit: AGENTIC_RETRIEVE_LIMIT,
  agenticMaxRetries: AGENTIC_MAX_RETRIES,
  similarityThreshold: SIMILARITY_THRESHOLD,
  hybridEnabled: HYBRID_ENABLED,
  agenticQueryRewriteEnabled: true,
  hallucinationCheckEnabled: true,
  judgeSampleRate: JUDGE_SAMPLE_RATE,
  rerankerProvider: RERANKER_PROVIDER,
  auxModel: AUX_MODEL || undefined,
  answerCacheEnabled: ANSWER_CACHE_ENABLED,
  answerCacheTtlSec: ANSWER_CACHE_TTL_SEC,
  captureQueryText: true,
  chatHistoryRetentionDays: 120,
  retrievalModeRolloutPercent: 100,
};

export default config;
