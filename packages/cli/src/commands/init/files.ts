import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

export interface PdfCopyOutcome {
  copied: string[];
  skipped: Array<{ file: string; reason: string }>;
}

export function copyPdfsFromDir(sourceDir: string, destDir: string): PdfCopyOutcome {
  const outcome: PdfCopyOutcome = { copied: [], skipped: [] };
  if (!existsSync(sourceDir)) {
    outcome.skipped.push({ file: sourceDir, reason: 'folder does not exist' });
    return outcome;
  }
  const stat = statSync(sourceDir);
  if (!stat.isDirectory()) {
    outcome.skipped.push({ file: sourceDir, reason: 'not a directory' });
    return outcome;
  }
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(sourceDir);
  for (const name of entries) {
    const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
    if (ext !== '.pdf') {
      outcome.skipped.push({
        file: name,
        reason: 'only .pdf is accepted — non-PDFs are ignored by the RAG pipeline',
      });
      continue;
    }
    const src = join(sourceDir, name);
    if (!statSync(src).isFile()) {
      outcome.skipped.push({ file: name, reason: 'not a regular file' });
      continue;
    }
    copyFileSync(src, join(destDir, name));
    outcome.copied.push(name);
  }
  return outcome;
}

export function upsertAdminEmails(envPath: string, emails: string[]): void {
  if (emails.length === 0) return;
  const csv = emails.join(',');
  let body = '';
  if (existsSync(envPath)) {
    body = readFileSync(envPath, 'utf8');
  }
  const lines = body.split(/\r?\n/);
  let found = false;
  const next: string[] = [];
  for (const line of lines) {
    if (/^ADMIN_EMAILS\s*=/.test(line)) {
      next.push(`ADMIN_EMAILS=${csv}`);
      found = true;
    } else {
      next.push(line);
    }
  }
  if (!found) {
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push(`ADMIN_EMAILS=${csv}`);
  }
  writeFileSync(envPath, next.join('\n'), { mode: 0o600 });
}
