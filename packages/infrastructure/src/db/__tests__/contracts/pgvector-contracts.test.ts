import { describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../client';
import { createVectorSearch } from '../../vector-search';
import { createLexicalSearch } from '../../lexical-search';
import { createChunkStore } from '../../chunk-store';
import { createChunkRepositoryCompat } from '../../repositories';
import { runChunkContractTests } from './chunk-contracts';

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

const connected = await dbReachable();
const suite = connected ? describe : describe.skip;

suite('chunk contracts (pgvector)', () => {
  runChunkContractTests({
    makeVector: createVectorSearch,
    makeLexical: createLexicalSearch,
    makeStore: createChunkStore,
    makeComposite: (client) =>
      createChunkRepositoryCompat(
        createChunkStore(client),
        createVectorSearch(client),
        createLexicalSearch(client),
      ),
  });
});
