import { z } from 'zod';
import { appConfigSchema, type AppConfig } from '@app/domain/app-config';
import { appConfig } from '@/lib/config';
import { fieldConfig, type FieldMeta } from './field-config';

export const NON_EDITABLE_FIELDS = ['adminEmails', 'seedDocsDir', 'prefetchFirstTurn', 'analyticsTopics'] as const;

export const IMMUTABLE_FIELDS = ['embeddingModel', ...NON_EDITABLE_FIELDS] as const;

export type FieldSource = 'default' | 'db' | 'env-locked';

export interface FieldIntrospection {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  options?: string[];
}

export interface FieldDescriptor extends Partial<FieldMeta> {
  key: string;
  type: FieldIntrospection['type'];
  options?: string[];
  default: unknown;
  current: unknown;
  source: FieldSource;
  readOnly?: boolean;
  available: boolean;
  unavailableReason?: string;
}

interface UnwrapResult {
  def: { type?: string; entries?: Record<string, string> };
  schema: z.ZodTypeAny;
}

function unwrap(schema: z.ZodTypeAny): UnwrapResult {
  let cur = schema;
  let def = (cur as { _def?: UnwrapResult['def'] })._def ?? {};
  while (def.type === 'default' || def.type === 'optional' || def.type === 'nullable') {
    const inner = (cur as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
    if (!inner) break;
    cur = inner;
    def = (cur as { _def?: UnwrapResult['def'] })._def ?? {};
  }
  return { def, schema: cur };
}

function mapType(zodType: string | undefined): FieldIntrospection['type'] {
  switch (zodType) {
    case 'number':
    case 'boolean':
    case 'enum':
    case 'array':
    case 'object':
      return zodType;
    default:
      return 'string';
  }
}

export function flattenSchema(): Map<string, FieldIntrospection> {
  const out = new Map<string, FieldIntrospection>();
  const walk = (schema: z.ZodTypeAny, prefix: string): void => {
    const { def, schema: base } = unwrap(schema);
    if (def.type === 'object') {
      const shape = (base as { _def?: { shape?: Record<string, z.ZodTypeAny> } })._def?.shape ?? {};
      for (const key of Object.keys(shape)) {
        const field = shape[key];
        if (field) walk(field, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    const type = mapType(def.type);
    const options = def.type === 'enum' && def.entries ? Object.values(def.entries) : undefined;
    out.set(prefix, { type, options });
  };
  walk(appConfigSchema, '');
  return out;
}

export function deepGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function computeSource(
  path: string,
  overrides: Partial<AppConfig>,
  lockedPaths: readonly string[],
): FieldSource {
  if (lockedPaths.includes(path)) return 'env-locked';
  if (deepGet(overrides, path) !== undefined) return 'db';
  return 'default';
}

export interface DescriptorContext {
  cfg: AppConfig;
  overrides: Partial<AppConfig>;
  lockedPaths: readonly string[];
  rerankers: Map<string, { ok: boolean; reason?: string }>;
  embeddingModel: string;
}

function availability(
  path: string,
  current: unknown,
  rerankers: DescriptorContext['rerankers'],
): { available: boolean; unavailableReason?: string } {
  if (path === 'rerankerProvider' && typeof current === 'string') {
    const status = rerankers.get(current);
    if (status && !status.ok) return { available: false, unavailableReason: status.reason };
  }
  return { available: true };
}

export function buildDescriptor(ctx: DescriptorContext): FieldDescriptor[] {
  const fields = flattenSchema();
  const descriptors: FieldDescriptor[] = [];

  for (const [key, meta] of fields) {
    const fc = fieldConfig[key];
    const source = computeSource(key, ctx.overrides, ctx.lockedPaths);
    const immutable = (IMMUTABLE_FIELDS as readonly string[]).includes(key);
    const current = deepGet(ctx.cfg, key);
    const { available, unavailableReason } = availability(key, current, ctx.rerankers);
    descriptors.push({
      ...fc,
      key,
      type: meta.type,
      options: meta.options,
      default: deepGet(appConfig, key),
      current,
      source,
      readOnly: source === 'env-locked' || immutable || !fc ? true : undefined,
      available,
      unavailableReason,
    });
  }

  descriptors.push({
    key: 'embeddingModel',
    type: 'string',
    default: ctx.embeddingModel,
    current: ctx.embeddingModel,
    source: 'default',
    readOnly: true,
    available: true,
  });

  return descriptors;
}

export function buildEffective(
  ctx: Omit<DescriptorContext, 'rerankers'>,
): Record<string, { value: unknown; source: FieldSource }> {
  const fields = flattenSchema();
  const out: Record<string, { value: unknown; source: FieldSource }> = {};
  for (const [key] of fields) {
    out[key] = { value: deepGet(ctx.cfg, key), source: computeSource(key, ctx.overrides, ctx.lockedPaths) };
  }
  out.embeddingModel = { value: ctx.embeddingModel, source: 'env-locked' };
  return out;
}

export function lockedPathsInPatch(patch: Partial<AppConfig>, lockedPaths: readonly string[]): string[] {
  return lockedPaths.filter((path) => deepGet(patch, path) !== undefined);
}

export function mergePatch(
  base: Partial<AppConfig>,
  patch: Partial<AppConfig>,
): Partial<AppConfig> {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const src = patch as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const o = src[key];
    const b = out[key];
    if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[key] = mergePatch(b as Partial<AppConfig>, o as Partial<AppConfig>);
    } else if (o !== undefined) {
      out[key] = o;
    }
  }
  return out as Partial<AppConfig>;
}

export function resolveEmbeddingModelId(): string {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  switch (provider) {
    case 'google':
      return 'gemini-embedding-001';
    case 'openai':
      return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    case 'ollama':
      return process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma:latest';
    default:
      return 'unknown';
  }
}
