import { sql } from 'drizzle-orm';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { db } from './client';
import { resolveVectorDim } from './schema-vector';

export async function validateVectorDimension(
  env: EnvSource = defaultProcessEnv,
  probe?: () => Promise<number[]>,
): Promise<void> {
  const result = (await db.execute(sql`
    SELECT format_type(a.atttypid, a.atttypmod) AS typ
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'chunks' AND a.attname = 'embedding'
  `)) as unknown as { rows?: Array<{ typ: string }> };
  const typ = result.rows?.[0]?.typ;
  if (typ) {
    const match = /vector\((\d+)\)/.exec(typ);
    if (match) {
      const dbDim = Number(match[1]);
      const expectedDimension = resolveVectorDim(env);
      if (dbDim !== expectedDimension) {
        throw new Error(
          `Embedding dimension mismatch: schema expects ${expectedDimension} (EMBEDDING_DIMENSION) ` +
            `but the live "chunks.embedding" column is vector(${dbDim}). ` +
            `Update EMBEDDING_DIMENSION or run a migration to ALTER COLUMN embedding TYPE vector(${expectedDimension}).`,
        );
      }
    }
  }
  if (probe) {
    const expectedDimension = resolveVectorDim(env);
    const vector = await probe();
    if (vector.length !== expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch: provider emitted ${vector.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${expectedDimension} (vector column width). Set EMBEDDING_DIMENSION=${vector.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}
