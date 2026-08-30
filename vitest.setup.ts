import '@testing-library/jest-dom/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

// The generated test env file is authoritative. This makes the database branch
// created by `test:ci` win over a DATABASE_URL inherited by the shell.
const testEnvPath = resolve(process.cwd(), '.env.test');
if (existsSync(testEnvPath)) {
  const env = parse(readFileSync(testEnvPath));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
