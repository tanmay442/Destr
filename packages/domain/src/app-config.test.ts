import { describe, it, expect } from 'vitest';
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
