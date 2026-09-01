import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { appConfigSchema, partialAppConfigSchema } from './app-config';

const parse = (input: Record<string, unknown>) =>
  partialAppConfigSchema.safeParse(input);

describe('partialAppConfigSchema', () => {
  it('accepts an empty patch', () => {
    expect(parse({}).success).toBe(true);
  });

  it('keeps top-level scalar keys (guarded against the walker silently dropping keys)', () => {
    const result = parse({ orgName: 'Acme', seedDocsDir: './seed' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ orgName: 'Acme', seedDocsDir: './seed' });
    }
  });

  it('keeps nested object keys', () => {
    const result = parse({ agentPersona: { name: 'Nova' }, branding: { title: 'Help' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ agentPersona: { name: 'Nova' }, branding: { title: 'Help' } });
    }
  });

  it('keeps array fields', () => {
    const result = parse({ adminEmails: ['ops@example.com'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ adminEmails: ['ops@example.com'] });
    }
  });

  it('still rejects invalid enums through the partial schema', () => {
    expect(parse({ retrievalMode: 'bogus' }).success).toBe(false);
    expect(parse({ agentPersona: { tone: 'sarcastic' } }).success).toBe(false);
  });

  it('still rejects invalid numbers and coerces numeric strings', () => {
    expect(parse({ parentChunkSize: -5 }).success).toBe(false);
    expect(parse({ adminEmails: ['not-an-email'] }).success).toBe(false);
    const coerced = parse({ parentChunkSize: '2000' });
    expect(coerced.success).toBe(true);
    if (coerced.success) {
      expect(coerced.data).toEqual({ parentChunkSize: 2000 });
    }
  });
});

function unwrapObjectKeys(schema: unknown): string[] | null {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape).sort();
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return unwrapObjectKeys(schema.unwrap());
  }
  return null;
}

describe('configuration schema parity', () => {
  it('keeps every full-schema key in the partial override schema', () => {
    const fullKeys = Object.keys(appConfigSchema.shape).sort();
    const partialKeys = Object.keys(partialAppConfigSchema.shape).sort();
    expect(partialKeys).toEqual(fullKeys);
  });

  it('keeps keys for every nested configuration object in sync', () => {
    const partialEntries = new Map(Object.entries(partialAppConfigSchema.shape));
    for (const [key, fullSchema] of Object.entries(appConfigSchema.shape)) {
      const fullNestedKeys = unwrapObjectKeys(fullSchema);
      if (fullNestedKeys === null) continue;

      const partialSchema = partialEntries.get(key);
      if (!partialSchema) throw new Error(`Missing partial configuration key: ${key}`);
      const partialNestedKeys = unwrapObjectKeys(partialSchema);
      if (partialNestedKeys === null) throw new Error(`Partial key is not an object: ${key}`);
      expect(partialNestedKeys, `nested key parity for ${key}`).toEqual(fullNestedKeys);
    }
  });
});

describe('agentic pipeline toggles', () => {
  it('defaults both toggles to true in a full parse', () => {
    const result = appConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agenticQueryRewriteEnabled).toBe(true);
      expect(result.data.hallucinationCheckEnabled).toBe(true);
    }
  });

  it('round-trips explicit false values', () => {
    const result = appConfigSchema.safeParse({
      agenticQueryRewriteEnabled: false,
      hallucinationCheckEnabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agenticQueryRewriteEnabled).toBe(false);
      expect(result.data.hallucinationCheckEnabled).toBe(false);
    }
  });

  it('booleans are strict — no coercion of strings', () => {
    for (const key of ['agenticQueryRewriteEnabled', 'hallucinationCheckEnabled']) {
      expect(appConfigSchema.safeParse({ [key]: 'true' }).success).toBe(false);
      expect(appConfigSchema.safeParse({ [key]: 1 }).success).toBe(false);
    }
  });

  it('accepts a deepPartial override for each toggle', () => {
    const result = parse({ agenticQueryRewriteEnabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ agenticQueryRewriteEnabled: false });
    }
  });
});

describe('judgeSampleRate and auxModel', () => {
  it('defaults judgeSampleRate to 0.02 and auxModel to undefined', () => {
    const result = appConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.judgeSampleRate).toBe(0.02);
      expect(result.data.auxModel).toBeUndefined();
    }
  });

  it('rejects judgeSampleRate outside [0,1] and non-numeric auxModel', () => {
    expect(appConfigSchema.safeParse({ judgeSampleRate: 1.5 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ judgeSampleRate: -0.1 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ auxModel: 42 }).success).toBe(false);
  });

  it('coerces numeric strings for judgeSampleRate and accepts deepPartial overrides', () => {
    const coerced = appConfigSchema.safeParse({ judgeSampleRate: '0.1' });
    expect(coerced.success).toBe(true);
    if (coerced.success) {
      expect(coerced.data.judgeSampleRate).toBe(0.1);
    }
    const partial = parse({ auxModel: 'gemini-2.0-flash' });
    expect(partial.success).toBe(true);
    if (partial.success) {
      expect(partial.data).toEqual({ auxModel: 'gemini-2.0-flash' });
    }
  });
});

describe('chatHistoryRetentionDays', () => {
  it('defaults to 120 in a full parse', () => {
    const result = appConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chatHistoryRetentionDays).toBe(120);
    }
  });

  it('round-trips each allowed value through a full parse', () => {
    for (const days of [0, 30, 120, 365]) {
      const result = appConfigSchema.safeParse({ chatHistoryRetentionDays: days });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chatHistoryRetentionDays).toBe(days);
      }
    }
  });

  it('rejects disallowed values', () => {
    expect(appConfigSchema.safeParse({ chatHistoryRetentionDays: 60 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ chatHistoryRetentionDays: 90 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ chatHistoryRetentionDays: -1 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ chatHistoryRetentionDays: '30' }).success).toBe(false);
  });

  it('accepts a deepPartial override and still rejects disallowed values', () => {
    const result = parse({ chatHistoryRetentionDays: 365 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ chatHistoryRetentionDays: 365 });
    }
    expect(parse({ chatHistoryRetentionDays: 60 }).success).toBe(false);
  });
});
