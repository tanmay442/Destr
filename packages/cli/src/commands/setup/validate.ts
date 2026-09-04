import pg from 'pg';
const { Pool } = pg;
import * as Llm from '@app/infrastructure/llm';

function dbSslOptions(url: string): { rejectUnauthorized: boolean } {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { rejectUnauthorized: true };
  }
  const isLocal =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return isLocal ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
}

export async function validateDbUrl(url: string): Promise<string | null> {
  if (!url) return 'DATABASE_URL is required';
  const pool = new Pool({
    connectionString: url,
    ssl: dbSslOptions(url),
  });
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await pool.end();
  }
}

export async function testEmbedding(): Promise<string | null> {
  if (!process.env.AI_STUDIO_KEY) return 'AI_STUDIO_KEY is not set in environment';
  try {
    const result = await Llm.getEmbeddingService().embed('validation-test-vector');
    if (!result || result.length === 0) return 'Embedding returned empty vector';
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function validateChatVars(): string | null {
  if (!process.env.CUSTOM_LLM_API_KEY) return 'CUSTOM_LLM_API_KEY is not set';
  if (!process.env.CUSTOM_LLM_BASE_URL) return 'CUSTOM_LLM_BASE_URL is not set';
  if (!process.env.LLM_MODEL) return 'LLM_MODEL is not set';
  return null;
}

export function validateClerkVars(): string | null {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set';
  }
  if (!process.env.CLERK_SECRET_KEY) return 'CLERK_SECRET_KEY is not set';
  return null;
}

export { dbSslOptions };
