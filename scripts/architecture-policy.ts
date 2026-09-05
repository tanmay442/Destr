import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export type ArchitectureLayer = 'application' | 'domain';

export interface ArchitectureViolation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

interface TemporaryException {
  readonly layer: ArchitectureLayer;
  readonly file: string;
  readonly specifier: string;
  readonly removalWorkPackage: 'WP-5';
}

const TEMPORARY_EXCEPTIONS: readonly TemporaryException[] = [
  {
    layer: 'application',
    file: 'packages/application/package.json',
    specifier: 'ai',
    removalWorkPackage: 'WP-5',
  },
  {
    layer: 'application',
    file: 'packages/application/package.json',
    specifier: '@ai-sdk/provider',
    removalWorkPackage: 'WP-5',
  },
  ...[
    'packages/application/src/chat/message-types.ts',
    'packages/application/src/chat/chat-turn/cached-answer.ts',
    'packages/application/src/chat/chat-turn/hallucination.ts',
    'packages/application/src/chat/chat-turn/turn.ts',
    'packages/application/src/chat/chat-turn/turn-types.ts',
    'packages/application/src/chat/__tests__/chat-turn.test.ts',
  ].map(
    (file): TemporaryException => ({
      layer: 'application',
      file,
      specifier: 'ai',
      removalWorkPackage: 'WP-5',
    }),
  ),
  {
    layer: 'application',
    file: 'packages/application/src/chat/chat-turn/turn-types.ts',
    specifier: '@ai-sdk/provider',
    removalWorkPackage: 'WP-5',
  },
  {
    layer: 'application',
    file: 'packages/application/src/chat/__tests__/chat-turn.test.ts',
    specifier: '@ai-sdk/provider',
    removalWorkPackage: 'WP-5',
  },
];

/**
 * Canonical vendor/package families forbidden to application and domain code.
 *
 * Keep this list aligned with the package-family alternatives in
 * `.dependency-cruiser.cjs`. Source imports and package manifests both flow
 * through `forbiddenReason`, so adding a family here closes both policy gaps
 * at once. Scope roots intentionally omit their trailing slash; matching
 * below still requires a package-boundary slash and therefore does not reject
 * similarly named unscoped packages.
 */
export const FORBIDDEN_VENDOR_PACKAGE_FAMILIES = [
  'ai',
  '@ai-sdk',
  '@clerk',
  'next',
  'drizzle-orm',
  'pdf-lib',
  'pg',
  '@neondatabase',
  'drizzle-kit',
  'unpdf',
  '@upstash',
  '@xenova/transformers',
  'onnxruntime-node',
  // Preserve the existing application policy for observability vendors.
  '@opentelemetry',
  '@sentry',
] as const;

const DOMAIN_FORBIDDEN_INTERNAL_PACKAGE_PREFIXES = [
  '@app/application',
  '@app/infrastructure',
  '@app/cli',
] as const;

const DOMAIN_FORBIDDEN_PREFIXES = [
  ...FORBIDDEN_VENDOR_PACKAGE_FAMILIES,
  ...DOMAIN_FORBIDDEN_INTERNAL_PACKAGE_PREFIXES,
] as const;

function matchesPackage(specifier: string, prefix: string): boolean {
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

function forbiddenReason(layer: ArchitectureLayer, specifier: string): string | null {
  const prefixes = layer === 'domain' ? DOMAIN_FORBIDDEN_PREFIXES : FORBIDDEN_VENDOR_PACKAGE_FAMILIES;
  const forbidden = prefixes.find((prefix) => matchesPackage(specifier, prefix));
  if (forbidden) {
    return `${layer} must not depend on vendor package ${specifier}`;
  }
  if (layer === 'application' && matchesPackage(specifier, '@app/infrastructure')) {
    return 'application must not depend on infrastructure';
  }
  return null;
}

function isTemporaryException(
  layer: ArchitectureLayer,
  file: string,
  specifier: string,
): boolean {
  return TEMPORARY_EXCEPTIONS.some(
    (exception) =>
      exception.layer === layer &&
      exception.file === file &&
      exception.specifier === specifier,
  );
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

export function collectModuleSpecifiers(sourceText: string, fileName: string): readonly string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier) found.add(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = stringLiteralValue(node.moduleReference.expression);
      if (specifier) found.add(specifier);
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument)
        ? stringLiteralValue(node.argument.literal)
        : null;
      if (specifier) found.add(specifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const specifier = stringLiteralValue(node.arguments[0]);
        if (specifier) found.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return [...found].sort();
}

export function checkSourcePolicy(input: {
  readonly layer: ArchitectureLayer;
  readonly file: string;
  readonly sourceText: string;
  readonly allowTemporaryExceptions?: boolean;
}): readonly ArchitectureViolation[] {
  return collectModuleSpecifiers(input.sourceText, input.file).flatMap((specifier) => {
    const reason = forbiddenReason(input.layer, specifier);
    if (!reason) return [];
    if (
      input.allowTemporaryExceptions !== false &&
      isTemporaryException(input.layer, input.file, specifier)
    ) {
      return [];
    }
    return [{ file: input.file, specifier, reason } satisfies ArchitectureViolation];
  });
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export function checkManifestPolicy(input: {
  readonly layer: ArchitectureLayer;
  readonly file: string;
  readonly manifest: unknown;
  readonly allowTemporaryExceptions?: boolean;
}): readonly ArchitectureViolation[] {
  if (typeof input.manifest !== 'object' || input.manifest === null) {
    return [{ file: input.file, specifier: '<manifest>', reason: 'package manifest must be an object' }];
  }

  const manifest = input.manifest;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const violations: ArchitectureViolation[] = [];
  for (const section of sections) {
    if (!(section in manifest)) continue;
    const dependencies: unknown = Reflect.get(manifest, section);
    if (!isStringRecord(dependencies)) {
      violations.push({
        file: input.file,
        specifier: `<${section}>`,
        reason: `${section} must contain string versions`,
      });
      continue;
    }
    for (const specifier of Object.keys(dependencies).sort()) {
      const reason = forbiddenReason(input.layer, specifier);
      if (!reason) continue;
      if (
        input.allowTemporaryExceptions !== false &&
        isTemporaryException(input.layer, input.file, specifier)
      ) {
        continue;
      }
      violations.push({ file: input.file, specifier, reason });
    }
  }
  return violations;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export function auditArchitecturePolicy(rootDirectory: string): readonly ArchitectureViolation[] {
  const root = resolve(rootDirectory);
  const layers: readonly ArchitectureLayer[] = ['domain', 'application'];
  const violations: ArchitectureViolation[] = [];

  for (const layer of layers) {
    const packageDirectory = join(root, 'packages', layer);
    const manifestPath = join(packageDirectory, 'package.json');
    const manifestFile = relative(root, manifestPath);
    violations.push(
      ...checkManifestPolicy({
        layer,
        file: manifestFile,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      }),
    );
    for (const absoluteFile of sourceFiles(join(packageDirectory, 'src'))) {
      const file = relative(root, absoluteFile);
      violations.push(
        ...checkSourcePolicy({
          layer,
          file,
          sourceText: readFileSync(absoluteFile, 'utf8'),
        }),
      );
    }
  }
  return violations;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

function rootDirectoryFromArgs(args: readonly string[]): string {
  let rootDirectory = process.cwd();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw new Error('unexpected missing command-line argument');
    if (argument === '--root') {
      const nextArgument = args[index + 1];
      if (nextArgument === undefined || nextArgument.startsWith('--')) {
        throw new Error('missing value for --root (expected a directory path)');
      }
      rootDirectory = nextArgument;
      index += 1;
      continue;
    }

    if (argument.startsWith('--root=')) {
      const value = argument.slice('--root='.length);
      if (value.length === 0) throw new Error('missing value for --root (expected a directory path)');
      rootDirectory = value;
      continue;
    }

    throw new Error(`unknown argument ${argument}`);
  }

  return rootDirectory;
}

if (isMainModule()) {
  try {
    const violations = auditArchitecturePolicy(rootDirectoryFromArgs(process.argv.slice(2)));
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`${violation.file}: forbidden ${violation.specifier} — ${violation.reason}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `Architecture source/manifest policy passed; ${TEMPORARY_EXCEPTIONS.length} exact compatibility exceptions expire in WP-5.`,
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Architecture source/manifest policy failed: ${message}`);
    process.exitCode = 2;
  }
}
