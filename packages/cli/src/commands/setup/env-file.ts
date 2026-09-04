import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { config as loadEnv } from 'dotenv';
import {
  warn,
} from '../common';

export function readEnvFile(envPath: string): { vars: Record<string, string>; lines: string[] } {
  const lines = existsSync(envPath)
    ? readFileSync(envPath, 'utf8').split(/\r?\n/)
    : [];
  const vars: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^\s*([^=\s][^=]*?)\s*=\s*(.*)$/);
    if (m) vars[m[1]!] = m[2]!;
  }
  return { vars, lines };
}

export function writeEnvFile(
  envPath: string,
  vars: Record<string, string>,
  existingLines: string[],
): void {
  const updated = new Set<string>();
  const out: string[] = [];
  for (const line of existingLines) {
    const m = line.match(/^\s*([^=\s][^=]*?)\s*=/);
    const key = m?.[1];
    if (key && Object.prototype.hasOwnProperty.call(vars, key)) {
      const val = vars[key];
      if (val !== undefined && val !== '') {
        out.push(`${key}=${val}`);
      }
      updated.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === '' || v === undefined || updated.has(k)) continue;
    out.push(`${k}=${v}`);
  }
  const existed = existsSync(envPath);
  writeFileSync(envPath, out.join('\n') + (out.length ? '\n' : ''), { mode: 0o600 });
  if (existed) warn(`Updated existing ${envPath} (unrecognized lines preserved).`);
}

export function applyToProcess(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== '') {
      process.env[k] = v;
    } else {
      delete process.env[k];
    }
  }
}

export function refreshEnvSnapshot(envPath: string): void {
  loadEnv({ path: envPath, override: true });
}
