interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  condition?: () => boolean;
}

function providerIs(provider: string, envVar: string): boolean {
  return process.env[envVar] === provider;
}

const ENV_VARS: EnvVarSpec[] = [
  {
    name: 'DATABASE_URL',
    required: true,
    description: 'Neon Serverless Postgres connection string',
  },
  {
    name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    required: true,
    description: 'Clerk publishable key',
  },
  {
    name: 'CLERK_SECRET_KEY',
    required: true,
    description: 'Clerk secret key',
  },
  {
    name: 'AI_STUDIO_KEY',
    required: true,
    description: 'Google AI Studio API key',
    condition: () => providerIs('google', 'EMBEDDING_PROVIDER'),
  },
  {
    name: 'OPENAI_EMBEDDING_API_KEY',
    required: true,
    description: 'OpenAI-compatible embedding API key',
    condition: () => providerIs('openai', 'EMBEDDING_PROVIDER'),
  },
  {
    name: 'OPENAI_EMBEDDING_BASE_URL',
    required: true,
    description: 'OpenAI-compatible embedding base URL',
    condition: () => providerIs('openai', 'EMBEDDING_PROVIDER'),
  },
  {
    name: 'OLLAMA_BASE_URL',
    required: true,
    description: 'Ollama server URL',
    condition: () =>
      providerIs('ollama', 'EMBEDDING_PROVIDER') ||
      providerIs('ollama', 'CHAT_PROVIDER'),
  },
  {
    name: 'CUSTOM_LLM_API_KEY',
    required: true,
    description: 'OpenAI-compatible chat API key',
    condition: () => providerIs('openai', 'CHAT_PROVIDER'),
  },
  {
    name: 'CUSTOM_LLM_BASE_URL',
    required: true,
    description: 'OpenAI-compatible chat base URL',
    condition: () => providerIs('openai', 'CHAT_PROVIDER'),
  },
  {
    name: 'R2_ACCOUNT_ID',
    required: true,
    description: 'Cloudflare R2 account ID',
    condition: () => providerIs('r2', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'R2_ACCESS_KEY_ID',
    required: true,
    description: 'R2 access key',
    condition: () => providerIs('r2', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'R2_SECRET_ACCESS_KEY',
    required: true,
    description: 'R2 secret key',
    condition: () => providerIs('r2', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'R2_BUCKET',
    required: true,
    description: 'R2 bucket name',
    condition: () => providerIs('r2', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'S3_REGION',
    required: true,
    description: 'AWS S3 region',
    condition: () => providerIs('s3', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'S3_ACCESS_KEY_ID',
    required: true,
    description: 'S3 access key',
    condition: () => providerIs('s3', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'S3_SECRET_ACCESS_KEY',
    required: true,
    description: 'S3 secret key',
    condition: () => providerIs('s3', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'S3_BUCKET',
    required: true,
    description: 'S3 bucket name',
    condition: () => providerIs('s3', 'BLOB_STORAGE_PROVIDER'),
  },
  {
    name: 'QSTASH_CURRENT_SIGNING_KEY',
    required: true,
    description: 'QStash current signing key',
    condition: () => !!process.env.QSTASH_TOKEN,
  },
  {
    name: 'QSTASH_NEXT_SIGNING_KEY',
    required: true,
    description: 'QStash next signing key',
    condition: () => !!process.env.QSTASH_TOKEN,
  },
  {
    name: 'QSTASH_INGEST_WORKER_URL',
    required: false,
    description: 'Public URL for ingest worker (auto-derived from NEXT_PUBLIC_APP_URL / VERCEL_URL when unset)',
    condition: () => !!process.env.QSTASH_TOKEN,
  },
];

export interface ValidationResult {
  ok: boolean;
  missing: Array<{ name: string; description: string }>;
  message: string;
}

export function validateEnv(): ValidationResult {
  const missing: Array<{ name: string; description: string }> = [];

  for (const spec of ENV_VARS) {
    if (!spec.required) continue;
    if (spec.condition && !spec.condition()) continue;
    const value = process.env[spec.name];
    if (!value || value.trim() === '') {
      missing.push({ name: spec.name, description: spec.description });
    }
  }

  if (missing.length === 0) {
    return { ok: true, missing: [], message: '' };
  }

  const lines = missing.map(
    (m) => `  - ${m.name.padEnd(35)} ${m.description}`,
  );
  const message = [
    'Missing required environment variables for the selected providers:',
    ...lines,
    '',
    'Copy these into .env.local or your Vercel project settings.',
    'To skip a provider, change the corresponding *_PROVIDER env var.',
  ].join('\n');

  return { ok: false, missing, message };
}
