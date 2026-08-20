import { describe, it, expect } from 'vitest';
import { partialAppConfigSchema } from './app-config';

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
