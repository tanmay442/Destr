# Incident: Missing migration `0012_chunk_title` (chunks.title column)

- **Date:** 2026-07-27
- **Severity:** High (write path broken — bulk document ingestion failed)
- **Status:** Resolved (live DB fixed); runner hardened to prevent recurrence
- **Git tag:** `incident/0012-missing-chunk-title` (points at the hardening commit)

## Symptom

A bulk `INSERT` of 38 document chunks into the `chunks` table failed with:

```
column "title" of relation "chunks" does not exist
```

The Drizzle ORM schema includes `title`, so every
`INSERT INTO chunks (...) VALUES (...)` referenced it, and PostgreSQL
rejected the statement because the column did not exist on the live table.

## Root cause

Migration `drizzle/0012_chunk_title.sql` (`ALTER TABLE "chunks" ADD COLUMN "title" text;`)
existed in the repo and in the Drizzle journal, but it had **never been applied
to the live Neon database**. The application code (ORM schema) expected the
column, so the code and the database had drifted.

The most likely mechanism for the gap: the deploy-time migration step
(`tsx scripts/migrate.ts`, run via `build = "tsx scripts/migrate.ts && next build"`)
**silently skips** when `DATABASE_URL` is unset or `NEXT_SKIP_MIGRATIONS=1`
is set — it logs a warning and exits `0`, so the build still ships code against
a stale schema. The old migration runner also had **no tracking table**, so it
could not detect that a committed migration had never been applied.

## What was done to fix it (prior agent)

1. Applied the missing column directly to the live DB:
   ```sql
   ALTER TABLE chunks ADD COLUMN title text;
   ```
2. Re-ingested `01-onboarding-account-setup.pdf` — all 38 chunks inserted
   successfully with 768-dimension embeddings from `gemini-embedding-001`
   (document id 26, status `done`).
3. Hardened `scripts/apply-migration.mjs`:
   - Added a `public._migrations` tracking table that records each applied
     `.sql` file **plus a content hash**.
   - Re-runs now skip files whose hash is unchanged.
   - `recordApplied` uses `ON CONFLICT (file_name) DO UPDATE SET hash = EXCLUDED.hash`
     so a changed migration file is re-applied and re-recorded instead of
     looping against a stale hash.

## This commit

- `scripts/apply-migration.mjs` — tracking table + hash-skip logic, minimal comments.
- `scripts/apply-migration.test.ts` — updated to assert the new
  (extension → tracking table → load applied → statements → record) query order.
- `scripts/ingest-fix.mjs` — removed; it was an untracked one-off scratch script
  with hardcoded absolute paths and a real-credentials filename
  (`.env.realCredentials.local`). Not part of any deploy path.

## How migrations run on Vercel

The build script is `tsx scripts/migrate.ts && next build`. `migrate.ts` imports
`applyMigrations` from `apply-migration.mjs`, so the hardening is live on every
deploy. On the next deploy after this fix:

- The runner creates `_migrations` (if absent).
- It reads `0012_chunk_title.sql`, computes its hash, finds the column already
  exists on the live DB, hits benign code `42701` (duplicate column), skips the
  statement, and **records `0012` in `_migrations`**.
- Future deploys see `0012` as applied and skip it. Self-healing, no manual step.

## Residual risk (NOT yet addressed)

`scripts/migrate.ts` still exits `0` (success) when `DATABASE_URL` is missing or
`NEXT_SKIP_MIGRATIONS=1` is set. A misconfigured/DB-less production build can
therefore silently deploy code against a stale schema — the exact class of bug
that produced this incident. Recommended hardening (deferred): in a production
build, fail loudly when the migration step cannot reach the database.

## How to verify state

```sql
-- migrations the runner believes are applied
SELECT file_name, applied_at, hash FROM public._migrations ORDER BY id;

-- confirm the column actually exists on the live table
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'chunks' AND column_name = 'title';
```

## Prevention checklist for future schema changes

1. Change the Drizzle schema **and** generate the migration file
   (`pnpm db:generate`) in the same commit.
2. Commit the migration file. Deploying runs it automatically via the build step.
3. Never rely on a manual `ALTER` in production — the runner handles it.
4. If a production build logs `DATABASE_URL is not set. Skipping migrations.`,
   treat it as a deploy blocker, not a warning.
