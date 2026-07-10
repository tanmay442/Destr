import '@testing-library/jest-dom/vitest';
import { loadEnv } from 'vite';

// Load .env.test without overriding already-set vars (CI values win)
const env = loadEnv('test', process.cwd(), '');
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
