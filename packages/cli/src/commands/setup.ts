import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { getRepoRoot } from './common';

loadEnv({ path: resolve(getRepoRoot(), '.env.local') });

export { readEnvFile, writeEnvFile, applyToProcess, refreshEnvSnapshot } from './setup/env-file';
export { runSetup } from './setup/run';

import { cliMain } from './common';
import { runSetup } from './setup/run';

cliMain(() => {
  return runSetup(getRepoRoot());
});
