// Verifies drizzle/meta/_journal.json consistency: every entry maps to a
// SQL file + snapshot, the snapshot chain is contiguous, and no leftover files
// exist. Exits nonzero on any drift.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DRIZZLE = join(ROOT, 'drizzle');
const META = join(DRIZZLE, 'meta');
const ZERO = '00000000-0000-0000-0000-000000000000';

function fail(msg) {
  console.error(`drizzle journal check: ${msg}`);
  process.exit(1);
}

const journalPath = join(META, '_journal.json');
if (!existsSync(journalPath)) fail(`missing ${journalPath}`);
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const entries = journal.entries ?? [];

for (let i = 0; i < entries.length; i++) {
  if (entries[i].idx !== i) {
    fail(`journal indices must be contiguous 0..${entries.length - 1}, got ${entries[i].idx} at pos ${i}`);
  }
}

const snapFiles = readdirSync(META).filter((f) => /_snapshot\.json$/.test(f));
const known = new Set(
  entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`),
);

let prevId = ZERO;
const parentOf = {};
for (const entry of entries) {
  const idx = String(entry.idx).padStart(4, '0');
  const sql = join(DRIZZLE, `${entry.tag}.sql`);
  const snap = join(META, `${idx}_snapshot.json`);
  if (!existsSync(sql)) fail(`journal ${entry.tag}: missing SQL file ${sql}`);
  if (!existsSync(snap)) fail(`journal idx ${entry.idx} (${entry.tag}): missing ${snap}`);

  const body = JSON.parse(readFileSync(snap, 'utf8'));
  if (entry.idx !== 0 && body.prevId !== prevId) {
    fail(
      `snapshot ${idx} prevId ${body.prevId} != prior snapshot id ${prevId} (chain must be contiguous)`,
    );
  }
  prevId = body.id;
}

for (const f of snapFiles) {
  if (!known.has(f)) fail(`orphan snapshot file not journaled: ${f}`);
  const body = JSON.parse(readFileSync(join(META, f), 'utf8'));
  if (parentOf[body.prevId] !== undefined) {
    fail(`two snapshots claim the same parent ${body.prevId}: ${parentOf[body.prevId]} and ${f}`);
  }
  parentOf[body.prevId] = f;
}

if (entries.length > 0 && snapFiles.length !== entries.length) {
  fail(
    `snapshot count ${snapFiles.length} != journal entries ${entries.length}`,
  );
}

console.log(
  `drizzle journal OK: ${entries.length} migrations, ${snapFiles.length} snapshots`,
);