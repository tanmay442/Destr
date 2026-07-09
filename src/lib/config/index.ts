import 'server-only';
import rawConfig from '../../../config/app.config';
import { appConfigSchema, type AppConfig } from '@app/domain/app-config';

// Validate config at module load so the server never boots with broken
// prompts/admin bootstrap; schema .default() fills in unset fields.
const parsed = appConfigSchema.safeParse(rawConfig);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(
    `Invalid config/app.config.ts. Fix the following and re-run:\n${issues}`,
  );
}

export const appConfig: AppConfig = parsed.data;
export type { AppConfig };
