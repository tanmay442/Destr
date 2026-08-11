import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../env';

function setValidBaseEnv() {
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@host/db?sslmode=require');
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_clerk');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_clerk');
  vi.stubEnv('EMBEDDING_PROVIDER', 'google');
  vi.stubEnv('AI_STUDIO_KEY', 'test-ai-studio-key');
  vi.stubEnv('CHAT_PROVIDER', 'openai');
  vi.stubEnv('CUSTOM_LLM_API_KEY', 'test-chat-key');
  vi.stubEnv('CUSTOM_LLM_BASE_URL', 'http://localhost:3000/v1');
  vi.stubEnv('LLM_MODEL', 'gpt-4o-mini');
  vi.stubEnv('BLOB_STORAGE_PROVIDER', 'filesystem');
}

describe('validateEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    setValidBaseEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns ok when all required vars for default providers are set', () => {
    const result = validateEnv();
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.invalid).toHaveLength(0);
    expect(result.message).toBe('');
  });

  it('lists all missing vars in one call', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('AI_STUDIO_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(3);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('DATABASE_URL');
    expect(names).toContain('AI_STUDIO_KEY');
    expect(names).toContain('CLERK_SECRET_KEY');
    expect(result.message).toContain('DATABASE_URL');
    expect(result.message).toContain('AI_STUDIO_KEY');
    expect(result.message).toContain('CLERK_SECRET_KEY');
  });

  it('does not require AI_STUDIO_KEY when EMBEDDING_PROVIDER=ollama', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('AI_STUDIO_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    expect(result.missing.map((m) => m.name)).not.toContain('AI_STUDIO_KEY');
  });

  it('requires OLLAMA_BASE_URL when CHAT_PROVIDER=ollama', () => {
    vi.stubEnv('CHAT_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_BASE_URL', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.name)).toContain('OLLAMA_BASE_URL');
  });

  it('does not require R2 vars when BLOB_STORAGE_PROVIDER=filesystem', () => {
    vi.stubEnv('BLOB_STORAGE_PROVIDER', 'filesystem');
    vi.stubEnv('R2_ACCOUNT_ID', '');
    vi.stubEnv('R2_ACCESS_KEY_ID', '');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', '');
    vi.stubEnv('R2_BUCKET', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    const names = result.missing.map((m) => m.name);
    expect(names).not.toContain('R2_ACCOUNT_ID');
    expect(names).not.toContain('R2_ACCESS_KEY_ID');
    expect(names).not.toContain('R2_SECRET_ACCESS_KEY');
    expect(names).not.toContain('R2_BUCKET');
  });

  it('requires all R2 vars when BLOB_STORAGE_PROVIDER=r2', () => {
    vi.stubEnv('BLOB_STORAGE_PROVIDER', 'r2');
    vi.stubEnv('R2_ACCOUNT_ID', '');
    vi.stubEnv('R2_ACCESS_KEY_ID', '');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', '');
    vi.stubEnv('R2_BUCKET', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('R2_ACCOUNT_ID');
    expect(names).toContain('R2_ACCESS_KEY_ID');
    expect(names).toContain('R2_SECRET_ACCESS_KEY');
    expect(names).toContain('R2_BUCKET');
  });

  it('requires S3 vars when BLOB_STORAGE_PROVIDER=s3', () => {
    vi.stubEnv('BLOB_STORAGE_PROVIDER', 's3');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('S3_REGION');
    expect(names).toContain('S3_ACCESS_KEY_ID');
    expect(names).toContain('S3_SECRET_ACCESS_KEY');
    expect(names).toContain('S3_BUCKET');
  });

  it('requires QStash signing keys when QSTASH_TOKEN is set', () => {
    vi.stubEnv('QSTASH_TOKEN', 'test-token');
    vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', '');
    vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('QSTASH_CURRENT_SIGNING_KEY');
    expect(names).toContain('QSTASH_NEXT_SIGNING_KEY');
  });

  it('does not require QStash signing keys when QSTASH_TOKEN is unset', () => {
    vi.stubEnv('QSTASH_TOKEN', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    const names = result.missing.map((m) => m.name);
    expect(names).not.toContain('QSTASH_CURRENT_SIGNING_KEY');
    expect(names).not.toContain('QSTASH_NEXT_SIGNING_KEY');
    expect(names).not.toContain('QSTASH_INGEST_WORKER_URL');
  });

  it('treats unset EMBEDDING_PROVIDER as google (runtime default)', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', '');
    vi.stubEnv('AI_STUDIO_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.name)).toContain('AI_STUDIO_KEY');
  });

  it('treats unset CHAT_PROVIDER as openai (runtime default)', () => {
    vi.stubEnv('CHAT_PROVIDER', '');
    vi.stubEnv('CUSTOM_LLM_API_KEY', '');
    vi.stubEnv('CUSTOM_LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('CUSTOM_LLM_API_KEY');
    expect(names).toContain('CUSTOM_LLM_BASE_URL');
    expect(names).toContain('LLM_MODEL');
  });

  it('requires LLM_MODEL when CHAT_PROVIDER=openai', () => {
    vi.stubEnv('CHAT_PROVIDER', 'openai');
    vi.stubEnv('LLM_MODEL', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.name)).toContain('LLM_MODEL');
  });

  it('does not require LLM_MODEL when CHAT_PROVIDER=ollama', () => {
    vi.stubEnv('CHAT_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('LLM_MODEL', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    expect(result.missing.map((m) => m.name)).not.toContain('LLM_MODEL');
  });

  it('requires AI_STUDIO_KEY when CHAT_PROVIDER=google even with OpenAI embeddings', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_EMBEDDING_API_KEY', 'test-embed-key');
    vi.stubEnv('OPENAI_EMBEDDING_BASE_URL', 'http://localhost:4000/v1');
    vi.stubEnv('CHAT_PROVIDER', 'google');
    vi.stubEnv('AI_STUDIO_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.name)).toContain('AI_STUDIO_KEY');
  });

  it('does not require AI_STUDIO_KEY when CHAT_PROVIDER=ollama with OpenAI embeddings', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_EMBEDDING_API_KEY', 'test-embed-key');
    vi.stubEnv('OPENAI_EMBEDDING_BASE_URL', 'http://localhost:4000/v1');
    vi.stubEnv('CHAT_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('AI_STUDIO_KEY', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    expect(result.missing.map((m) => m.name)).not.toContain('AI_STUDIO_KEY');
  });

  it('reports invalid EMBEDDING_PROVIDER values', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'bogus');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.invalid).toContainEqual({
      name: 'EMBEDDING_PROVIDER',
      value: 'bogus',
      description: 'One of: google, openai, ollama',
    });
    expect(result.message).toContain('EMBEDDING_PROVIDER');
  });

  it('reports invalid CHAT_PROVIDER values', () => {
    vi.stubEnv('CHAT_PROVIDER', 'bogus');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.invalid).toContainEqual({
      name: 'CHAT_PROVIDER',
      value: 'bogus',
      description: 'One of: openai, google, ollama',
    });
  });

  it('reports invalid BLOB_STORAGE_PROVIDER values', () => {
    vi.stubEnv('BLOB_STORAGE_PROVIDER', 'bogus');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.invalid).toContainEqual({
      name: 'BLOB_STORAGE_PROVIDER',
      value: 'bogus',
      description: 'One of: filesystem, r2, s3',
    });
  });

  it('does not report unset providers as invalid (runtime defaults apply)', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', '');
    vi.stubEnv('CHAT_PROVIDER', '');
    vi.stubEnv('BLOB_STORAGE_PROVIDER', '');

    const result = validateEnv();
    expect(result.invalid).toHaveLength(0);
  });

  it('requires UPSTASH_REDIS_REST_TOKEN when UPSTASH_REDIS_REST_URL is set', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.name)).toContain('UPSTASH_REDIS_REST_TOKEN');
  });

  it('does not require UPSTASH_REDIS_REST_TOKEN when UPSTASH_REDIS_REST_URL is unset', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');

    const result = validateEnv();
    expect(result.ok).toBe(true);
    expect(result.missing.map((m) => m.name)).not.toContain('UPSTASH_REDIS_REST_TOKEN');
  });
});
