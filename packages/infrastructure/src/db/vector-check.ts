import { sql } from 'drizzle-orm';
import { db } from './client';
import { VECTOR_DIM } from './schema-vector';

export async function validateVectorDimension(): Promise<void> {
  const result = (await db.execute(sql`
    SELECT format_type(a.atttypid, a.atttypmod) AS typ
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'chunks' AND a.attname = 'embedding'
  `)) as unknown as { rows?: Array<{ typ: string }> };
  const typ = result.rows?.[0]?.typ;
  if (!typ) return;
  const match = /vector\((\d+)\)/.exec(typ);
  if (!match) return;
  const dbDim = Number(match[1]);
  if (dbDim !== VECTOR_DIM) {
    throw new Error(
      `Embedding dimension mismatch: schema expects ${VECTOR_DIM} (EMBEDDING_DIMENSION) ` +
        `but the live "chunks.embedding" column is vector(${dbDim}). ` +
        `Update EMBEDDING_DIMENSION or run a migration to ALTER COLUMN embedding TYPE vector(${VECTOR_DIM}).`,
    );
  }
}
