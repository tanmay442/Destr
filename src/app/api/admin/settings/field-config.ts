export interface FieldMeta {
  group: string;
  label: string;
  inputType: 'text' | 'textarea' | 'select' | 'slider' | 'toggle' | 'number';
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  readOnlyReason?: string;
  helpText?: string;
}

export const fieldConfig: Record<string, FieldMeta> = {
  'orgName':              { group: 'Persona & Prompt', label: 'Organization Name', inputType: 'text' },
  'audience':             { group: 'Persona & Prompt', label: 'Audience', inputType: 'text' },
  'agentPersona.name':    { group: 'Persona & Prompt', label: 'Agent Name', inputType: 'text' },
  'agentPersona.tone':    { group: 'Persona & Prompt', label: 'Response Tone', inputType: 'select' },
  'customInstructions':   { group: 'Persona & Prompt', label: 'Custom Instructions', inputType: 'textarea', rows: 6,
                            helpText: 'Appended after safety rules — cannot override guardrails.' },
  'outOfScopeTopics':     { group: 'Persona & Prompt', label: 'Out-of-Scope Topics', inputType: 'textarea', rows: 6 },
  'branding.title':       { group: 'Persona & Prompt', label: 'Browser Title', inputType: 'text' },
  'branding.description': { group: 'Persona & Prompt', label: 'Meta Description', inputType: 'text' },
  'retrievalMode':        { group: 'Retrieval', label: 'Retrieval Mode', inputType: 'select' },
  'retrievalModeRolloutPercent': { group: 'Retrieval', label: 'Rollout %', inputType: 'slider', min: 0, max: 100, step: 5,
                            helpText: '% of requests using the configured mode; remainder uses the opposite.' },
  'agentStepBudget':      { group: 'Retrieval', label: 'Agentic Step Budget', inputType: 'slider', min: 1, max: 20, step: 1,
                            helpText: 'Caps retry passes and LLM steps; grading capped at 10.' },
  'agenticRetrieveLimit': { group: 'Retrieval', label: 'Retrieve Limit (agentic)', inputType: 'slider', min: 1, max: 30, step: 1 },
  'agenticMaxRetries':    { group: 'Retrieval', label: 'Max Retries (agentic)', inputType: 'slider', min: 0, max: 5, step: 1 },
  'similarityThreshold':  { group: 'Retrieval', label: 'Similarity Threshold', inputType: 'slider', min: 0, max: 1, step: 0.05,
                            helpText: "Controls retrieval filtering (how picky). The 'out of domain' wall is separate — it only shows when search found 0 rows (isEmpty)." },
  'agenticQueryRewriteEnabled': { group: 'Retrieval', label: 'Query Rewrite (agentic)', inputType: 'toggle',
                            helpText: 'When off, the raw user query is used for retrieval (no LLM rewrite).' },
  'agenticChunkGradingEnabled': { group: 'Retrieval', label: 'Chunk Grading (agentic)', inputType: 'toggle',
                            helpText: 'When off, top 4 retrieved chunks are sent without grading and shown with a warning. Not cached.' },
  'hallucinationCheckEnabled': { group: 'Retrieval', label: 'Hallucination Check', inputType: 'toggle',
                            helpText: 'Warning: disabling lets unverified answers be shown and they won\u2019t be cached. Also disables out-of-domain wall + ticket offer for empty results. Only disable for debugging.' },
  'hybridEnabled':        { group: 'Retrieval', label: 'Hybrid Search', inputType: 'toggle' },
  'rerankerProvider':     { group: 'Retrieval', label: 'Reranker Provider', inputType: 'select' },
  'gradeModel':           { group: 'Retrieval', label: 'Grade Model Override', inputType: 'text' },
  'answerCacheEnabled':   { group: 'Retrieval', label: 'Answer Cache', inputType: 'toggle' },
  'answerCacheTtlSec':    { group: 'Retrieval', label: 'Answer Cache TTL (s)', inputType: 'number', min: 60, max: 86400 },
  'captureQueryText':     { group: 'Retrieval', label: 'Capture Query Text', inputType: 'toggle',
                            helpText: 'Disabling stops storing query text in chat_events (PII).' },
  'chunkingStrategy':     { group: 'Chunking', label: 'Chunking Strategy', inputType: 'select',
                            helpText: 'Applies to new uploads only.' },
  'parentChunkSize':      { group: 'Chunking', label: 'Parent Chunk Size', inputType: 'number', min: 200, max: 10000 },
  'childChunkSize':       { group: 'Chunking', label: 'Child Chunk Size', inputType: 'number', min: 100, max: 5000 },
  'parentChildMode':      { group: 'Chunking', label: 'Parent/Child Resolve', inputType: 'select' },
  'parentChildWindow':    { group: 'Chunking', label: 'Parent/Child Window', inputType: 'number', min: 0, max: 10 },
  'chatHistoryRetentionDays': { group: 'Chat History', label: 'Auto-Delete Window', inputType: 'select',
                            helpText: 'Saved chats auto-delete this many days after their last activity; Off disables purging. Turning off Capture Query Text also stops chat history — history never stores more than analytics does.' },
};
