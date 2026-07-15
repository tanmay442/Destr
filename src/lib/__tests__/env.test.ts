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
    vi.stubEnv('QSTASH_INGEST_WORKER_URL', '');

    const result = validateEnv();
    expect(result.ok).toBe(false);
    const names = result.missing.map((m) => m.name);
    expect(names).toContain('QSTASH_CURRENT_SIGNING_KEY');
    expect(names).toContain('QSTASH_NEXT_SIGNING_KEY');
    expect(names).toContain('QSTASH_INGEST_WORKER_URL');
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
});
