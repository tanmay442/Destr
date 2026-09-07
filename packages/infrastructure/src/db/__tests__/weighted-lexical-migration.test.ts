import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('weighted lexical search migration', () => {
  it('adds a stored weighted vector and its GIN index without replacing the rollback vector', () => {
    const migration = readFileSync(
      join(process.cwd(), 'drizzle/0032_curious_odin.sql'),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS');
    expect(migration).toContain("setweight(to_tsvector('english', coalesce(title, '')), 'A')");
    expect(migration).toContain("setweight(to_tsvector('english', coalesce(section_title, '')), 'B')");
    expect(migration).toContain("setweight(to_tsvector('english', content), 'D')");
    expect(migration).toContain('CREATE INDEX "chunks_search_tsv_idx"');
    expect(migration).not.toMatch(/DROP (COLUMN|INDEX)/);
  });
});
