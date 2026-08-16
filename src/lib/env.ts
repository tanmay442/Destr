interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  condition?: () => boolean;
}

interface EnvVarValueSpec {
  name: string;
  description: string;
  allowed: string[];
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  EMBEDDING_PROVIDER: 'google',
  CHAT_PROVIDER: 'openai',
};

const ENV_VAR_VALUES: EnvVarValueSpec[] = [
  {
    name: 'EMBEDDING_PROVIDER',
    description: 'One of: google, openai, ollama',
    allowed: ['google', 'openai', 'ollama'],
  },
  {
    name: 'CHAT_PROVIDER',
    description: 'One of: openai, google, ollama',
    allowed: ['openai', 'google', 'ollama'],
  },
  {
    name: 'BLOB_STORAGE_PROVIDER',
    description: 'One of: filesystem, r2, s3',
    allowed: ['filesystem', 'r2', 's3'],
  },
];

function providerIs(provider: string, envVar: string): boolean {
  const raw = process.env[envVar]?.trim();
  if (raw) return raw === provider;
  return provider === (PROVIDER_DEFAULTS[envVar] ?? '');
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
    condition: () =>
      providerIs('google', 'EMBEDDING_PROVIDER') ||
      providerIs('google', 'CHAT_PROVIDER'),
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
    name: 'LLM_MODEL',
    required: true,
    description: 'Chat model id for the OpenAI-compatible chat provider',
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
    name: 'UPSTASH_REDIS_REST_TOKEN',
    required: true,
    description: 'Upstash Redis REST token',
    condition: () => Boolean(process.env.UPSTASH_REDIS_REST_URL),
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
  {
    name: 'CLERK_PROXY_URL',
    required: false,
    description: 'Clerk custom-domain proxy origin; drives the CSP allowlist in next.config.ts (docs/REFERENCE.md §8). Unset = default Clerk frontend API domain',
  },
  {
    name: 'NEXT_PUBLIC_CLERK_PROXY_URL',
    required: false,
    description: 'Client-side variant of CLERK_PROXY_URL; also read by next.config.ts for the CSP',
  },
  {
    name: 'NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION',
    required: false,
    description: 'Google Search Console token; renders the google-site-verification meta tag when set (omitted otherwise)',
  },
];

export interface ValidationResult {
  ok: boolean;
  missing: Array<{ name: string; description: string }>;
  invalid: Array<{ name: string; value: string; description: string }>;
  message: string;
}

export function validateEnv(): ValidationResult {
  const missing: Array<{ name: string; description: string }> = [];
  const invalid: Array<{ name: string; value: string; description: string }> = [];

  for (const spec of ENV_VARS) {
    if (!spec.required) continue;
    if (spec.condition && !spec.condition()) continue;
    const value = process.env[spec.name];
    if (!value || value.trim() === '') {
      missing.push({ name: spec.name, description: spec.description });
    }
  }

  for (const spec of ENV_VAR_VALUES) {
    const value = process.env[spec.name]?.trim();
    if (!value) continue;
    if (!spec.allowed.includes(value)) {
      invalid.push({ name: spec.name, value, description: spec.description });
    }
  }

  if (missing.length === 0 && invalid.length === 0) {
    return { ok: true, missing: [], invalid: [], message: '' };
  }

  const sections: string[] = [];
  if (missing.length > 0) {
    const lines = missing.map(
      (m) => `  - ${m.name.padEnd(35)} ${m.description}`,
    );
    sections.push(
      [
        'Missing required environment variables for the selected providers:',
        ...lines,
        '',
        'Copy these into .env.local or your Vercel project settings.',
        'To skip a provider, change the corresponding *_PROVIDER env var.',
      ].join('\n'),
    );
  }
  if (invalid.length > 0) {
    const lines = invalid.map(
      (v) => `  - ${v.name.padEnd(35)} ${v.description} (got "${v.value}")`,
    );
    sections.push(
      [
        'Invalid environment variable values:',
        ...lines,
        '',
        'Fix the *_PROVIDER env vars to one of the supported values.',
      ].join('\n'),
    );
  }

  return { ok: false, missing, invalid, message: sections.join('\n\n') };
}
