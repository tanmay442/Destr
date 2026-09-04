import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { type Interface } from 'node:readline';
import { appConfigSchema, type AppConfig } from '@app/domain';

export function validateConfig(
  rl: Interface,
  config: AppConfig,
): AppConfig {
  const validated = appConfigSchema.safeParse(config);
  if (!validated.success) {
    console.error('\nInvalid configuration:');
    for (const i of validated.error.issues) {
      console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    }
    rl.close();
    throw new Error('Invalid configuration');
  }
  return validated.data;
}

function writeConfigFile(configPath: string, config: AppConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderConfigFile(config));
}

function jsonToTs(obj: unknown, indent = 2): string {
  const recurse = (val: unknown, depth: number): string => {
    const pad = ' '.repeat(indent * depth);
    const padInner = ' '.repeat(indent * (depth + 1));

    if (val === null || val === undefined) return 'undefined';
    if (typeof val === 'string') {
      const escaped = val
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      return `"${escaped}"`;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const items = val.map((item) => `${padInner}${recurse(item, depth + 1)}`);
      return `[\n${items.join(',\n')}\n${pad}]`;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) return '{}';
      const entries = keys.map((k) => {
        const v = recurse((val as Record<string, unknown>)[k], depth + 1);
        return `${padInner}${k}: ${v}`;
      });
      return `{\n${entries.join(',\n')}\n${pad}}`;
    }
    return String(val);
  };
  return recurse(obj, 0);
}

function renderConfigFile(config: AppConfig): string {
  const body = jsonToTs(config);
  return [
    "import type { AppConfig } from '@app/domain';",
    '',
    '// Runtime config. Edit fields or run `pnpm configure`. Validated on load.',
    '',
    'const config: AppConfig = ' + body + ';',
    '',
    'export default config;',
    '',
  ].join('\n');
}

export { writeConfigFile };
