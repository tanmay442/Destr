import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditArchitecturePolicy,
  checkManifestPolicy,
  checkSourcePolicy,
  collectModuleSpecifiers,
  FORBIDDEN_VENDOR_PACKAGE_FAMILIES,
} from './architecture-policy';

const FORBIDDEN_IMPORT_FIXTURES = [
  { family: 'ai', specifier: 'ai' },
  { family: '@ai-sdk', specifier: '@ai-sdk/provider' },
  { family: '@clerk', specifier: '@clerk/nextjs' },
  { family: 'next', specifier: 'next/navigation' },
  { family: 'drizzle-orm', specifier: 'drizzle-orm' },
  { family: 'pdf-lib', specifier: 'pdf-lib' },
  { family: 'pg', specifier: 'pg' },
  { family: '@neondatabase', specifier: '@neondatabase/serverless' },
  { family: 'drizzle-kit', specifier: 'drizzle-kit' },
  { family: 'unpdf', specifier: 'unpdf' },
  { family: '@upstash', specifier: '@upstash/redis' },
  { family: '@xenova/transformers', specifier: '@xenova/transformers' },
  { family: 'onnxruntime-node', specifier: 'onnxruntime-node' },
  { family: '@opentelemetry', specifier: '@opentelemetry/api' },
  { family: '@sentry', specifier: '@sentry/nextjs' },
] as const;

const IMPORT_SYNTAX_FIXTURES = [
  ['static', (specifier: string) => `import { value } from '${specifier}';`],
  ['type-only', (specifier: string) => `import type { Value } from '${specifier}';`],
  ['re-export', (specifier: string) => `export { value } from '${specifier}';`],
  ['dynamic import', (specifier: string) => `const value = import('${specifier}');`],
  ['require', (specifier: string) => `const value = require('${specifier}');`],
] as const;

const manifestFixtures = FORBIDDEN_IMPORT_FIXTURES.map(({ family, specifier }) => ({
  family,
  specifier,
}));

const ARCHITECTURE_POLICY_CLI = fileURLToPath(new URL('./architecture-policy.ts', import.meta.url));

function createArchitectureFixture(illegalApplicationSource?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'destr-architecture-cli-'));
  for (const layer of ['domain', 'application'] as const) {
    const sourceDirectory = join(root, 'packages', layer, 'src');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(root, 'packages', layer, 'package.json'),
      JSON.stringify({ dependencies: { zod: '4.4.3' } }),
    );
    writeFileSync(join(sourceDirectory, 'valid.ts'), "import { z } from 'zod';\n");
  }
  if (illegalApplicationSource !== undefined) {
    writeFileSync(
      join(root, 'packages', 'application', 'src', 'illegal.ts'),
      illegalApplicationSource,
    );
  }
  return root;
}

function runArchitecturePolicyCli(root: string) {
  return spawnSync('pnpm', ['exec', 'tsx', ARCHITECTURE_POLICY_CLI, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('architecture source and manifest policy', () => {
  it('detects static, dynamic, type-only, re-export, and require dependencies', () => {
    const source = [
      "import type { UIMessage } from 'ai';",
      "export { sql } from 'drizzle-orm';",
      "type Provider = typeof import('@ai-sdk/provider');",
      "const redis = import('@upstash/redis');",
      "const pg = require('pg');",
    ].join('\n');

    expect(collectModuleSpecifiers(source, 'fixture.ts')).toEqual([
      '@ai-sdk/provider',
      '@upstash/redis',
      'ai',
      'drizzle-orm',
      'pg',
    ]);
  });

  it('fails an intentional application vendor import fixture', () => {
    const violations = checkSourcePolicy({
      layer: 'application',
      file: 'packages/application/src/agent/illegal-fixture.ts',
      sourceText: "import type { LanguageModelV3 } from '@ai-sdk/provider';",
    });

    expect(violations).toEqual([
      expect.objectContaining({
        specifier: '@ai-sdk/provider',
        reason: expect.stringContaining('must not depend on vendor package'),
      }),
    ]);
  });

  it.each(FORBIDDEN_IMPORT_FIXTURES.flatMap((fixture) =>
    IMPORT_SYNTAX_FIXTURES.map(([syntax, makeSource]) => ({
      ...fixture,
      syntax,
      sourceText: makeSource(fixture.specifier),
    })),
  ))('rejects the $family family through $syntax imports', ({ family, specifier, sourceText }) => {
    const violations = checkSourcePolicy({
      layer: 'application',
      file: `packages/application/src/illegal-${family.replaceAll('/', '-')}.ts`,
      sourceText,
    });

    expect(violations).toEqual([
      expect.objectContaining({
        specifier,
        reason: expect.stringContaining('must not depend on vendor package'),
      }),
    ]);
  });

  it.each(manifestFixtures)('rejects the $family family in manifests', ({ family, specifier }) => {
    expect(FORBIDDEN_VENDOR_PACKAGE_FAMILIES).toContain(family);

    const violations = checkManifestPolicy({
      layer: 'application',
      file: 'packages/application/illegal-package.json',
      manifest: { dependencies: { [specifier]: '1.0.0' } },
    });

    expect(violations).toEqual([
      expect.objectContaining({
        specifier,
        reason: expect.stringContaining('must not depend on vendor package'),
      }),
    ]);
  });

  it('fails an intentional domain-to-infrastructure import fixture', () => {
    const violations = checkSourcePolicy({
      layer: 'domain',
      file: 'packages/domain/src/illegal-fixture.ts',
      sourceText: "import { db } from '@app/infrastructure';",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('@app/infrastructure');
  });

  it('fails a newly declared forbidden application dependency', () => {
    const violations = checkManifestPolicy({
      layer: 'application',
      file: 'packages/application/package.json',
      manifest: { dependencies: { next: '16.0.0', zod: '4.0.0' } },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('next');
  });

  it('keeps compatibility exceptions exact and removable', () => {
    const existing = checkSourcePolicy({
      layer: 'application',
      file: 'packages/application/src/chat/message-types.ts',
      sourceText: "import type { UIMessage } from 'ai';",
    });
    const sameImportElsewhere = checkSourcePolicy({
      layer: 'application',
      file: 'packages/application/src/agent/new-module.ts',
      sourceText: "import type { UIMessage } from 'ai';",
    });
    const withoutExceptions = checkSourcePolicy({
      layer: 'application',
      file: 'packages/application/src/chat/message-types.ts',
      sourceText: "import type { UIMessage } from 'ai';",
      allowTemporaryExceptions: false,
    });

    expect(existing).toEqual([]);
    expect(sameImportElsewhere).toHaveLength(1);
    expect(withoutExceptions).toHaveLength(1);
  });

  it('runs the repository policy over an intentional illegal-import fixture tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'destr-architecture-policy-'));
    try {
      for (const layer of ['domain', 'application']) {
        const sourceDirectory = join(root, 'packages', layer, 'src');
        mkdirSync(sourceDirectory, { recursive: true });
        writeFileSync(
          join(root, 'packages', layer, 'package.json'),
          JSON.stringify({ dependencies: { zod: '4.4.3' } }),
        );
        writeFileSync(join(sourceDirectory, 'valid.ts'), "import { z } from 'zod';\n");
      }
      writeFileSync(
        join(root, 'packages', 'application', 'src', 'illegal.ts'),
        "import type { LanguageModelV3 } from '@ai-sdk/provider';\n",
      );
      writeFileSync(
        join(root, 'packages', 'domain', 'src', 'illegal.ts'),
        "import { db } from '@app/infrastructure';\n",
      );

      expect(auditArchitecturePolicy(root)).toEqual([
        expect.objectContaining({
          file: 'packages/domain/src/illegal.ts',
          specifier: '@app/infrastructure',
        }),
        expect.objectContaining({
          file: 'packages/application/src/illegal.ts',
          specifier: '@ai-sdk/provider',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails through the architecture-policy CLI for a forbidden type-only import', () => {
    const root = createArchitectureFixture("import type { Clerk } from '@clerk/nextjs';\n");
    try {
      const result = runArchitecturePolicyCli(root);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'packages/application/src/illegal.ts: forbidden @clerk/nextjs',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes through the architecture-policy CLI for a clean fixture', () => {
    const root = createArchitectureFixture();
    try {
      const result = runArchitecturePolicyCli(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'Architecture source/manifest policy passed',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('audits the current repository with only the named WP-5 exceptions', () => {
    expect(auditArchitecturePolicy(process.cwd())).toEqual([]);
  });
});
