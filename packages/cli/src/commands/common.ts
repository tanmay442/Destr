import { existsSync } from 'node:fs';
import type { AppConfig } from '@app/domain';
import { appConfigSchema } from '@app/domain';
import { isMainModule } from '../is-main-module';

export const banner = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
export const ok = (s: string) => console.log(`\x1b[32m  ✓\x1b[0m ${s}`);
export const warn = (s: string) => console.log(`\x1b[33m  ⚠\x1b[0m ${s}`);
export const fail = (s: string) => console.log(`\x1b[31m  ✗\x1b[0m ${s}`);

export async function loadCurrentDefaults(
  repoRoot: string,
  configPath: string,
): Promise<AppConfig> {
  if (existsSync(configPath)) {
    try {
      const { default: existing } = (await import(
        configPath as unknown as string
      )) as { default: AppConfig };
      return appConfigSchema.parse(existing);
    } catch {
    }
  }
  void repoRoot;
  return appConfigSchema.parse({});
}

export type CliMain = () => Promise<unknown> | unknown;

export function cliMain(fn: CliMain): void {
  if (isMainModule()) {
    Promise.resolve(fn()).catch((err: unknown) => {
      console.error('CLI command failed:', err);
      process.exit(1);
    });
  }
}
