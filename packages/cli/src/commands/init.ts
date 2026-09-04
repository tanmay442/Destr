import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

export { copyPdfsFromDir, upsertAdminEmails } from './init/files';
export type { PdfCopyOutcome } from './init/files';
export { runConfigPrompts } from './init/prompts';
export { validateConfig } from './init/config-file';
export { writeOutputs, runInit } from './init/outputs';
export type { InitOptions, InitResult } from './init/outputs';

import { cliMain } from './common';
import { getRepoRoot } from './common';
import { runInit } from './init/outputs';

cliMain(() => {
  return runInit({ repoRoot: getRepoRoot() });
});
