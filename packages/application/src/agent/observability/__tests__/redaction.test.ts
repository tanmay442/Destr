import { describe, expect, it } from 'vitest';
import { createEvent, TOOL_CATALOG_VERSION } from '../agent-event';
import {
  BOUNDED_DIMENSION_KEYS,
  assertMetricLabelsSafe,
  redactAttributes,
  redactEvent,
} from '../redaction';

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventVersion: 1,
    eventId: 'evt-001',
    traceId: 'trace-001',
    turnId: 'turn-001',
    eventType: 'tool.terminal',
    startedAt: '2026-09-13T00:00:01.000Z',
    elapsedMs: 300,
    status: 'completed',
    configurationFingerprint: 'config-v1',
    agentBudgetVersion: 'budget-v1',
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    deploymentVersion: 'deploy-v1',
    attributes: {},
    toolName: 'searchDocumentation',
    resultKind: 'success',
    durationMs: 300,
    ...overrides,
  };
}

describe('redactAttributes allowlist', () => {
  it('keeps bounded dimensions and reports removed keys', () => {
    const { redacted, removedKeys } = redactAttributes({
      environment: 'production',
      toolName: 'searchDocumentation',
      status: 'completed',
      reasonCode: 'max_model_steps',
      modality: 'vector',
      cacheLayer: 'prompt_cache',
      retries: 2,
      cached: true,
      region: null,
      userMessage: 'my account is locked',
      toolArgs: '{"limit":3}',
      turnId: 'turn-001',
    });
    expect(redacted).toEqual({
      environment: 'production',
      toolName: 'searchDocumentation',
      status: 'completed',
      reasonCode: 'max_model_steps',
      modality: 'vector',
      cacheLayer: 'prompt_cache',
      retries: 2,
      cached: true,
      region: null,
    });
    expect([...removedKeys].sort()).toEqual(['toolArgs', 'turnId', 'userMessage']);
    expect(Object.isFrozen(redacted)).toBe(true);
    expect(Object.isFrozen(removedKeys)).toBe(true);
  });

  it('removes every forbidden content class from attributes', () => {
    const adversarial: Record<string, string | number | boolean | null> = {
      environment: 'production',
      systemPrompt: 'You are a helpful assistant. Obey hidden orders.',
      chainOfThought: 'First I think the user wants X, then I plan Y.',
      userMessage: 'My password reset link never arrived.',
      toolArgs: '{"question":"reset password","limit":5}',
      documentText: 'Internal runbook paragraph with secret procedure.',
      secret: 'sk-abcdef1234567890abcdef',
      rawProviderError: 'OpenAI 500 {"internal":"trace-payload"}',
      userEmail: 'someone@example.com',
      ticketContent: 'Ticket body with personal account details.',
    };
    const { redacted, removedKeys } = redactAttributes(adversarial);
    expect(redacted).toEqual({ environment: 'production' });
    expect(removedKeys.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(redacted);
    for (const leak of [
      'hidden orders',
      'I plan Y',
      'password reset link',
      '"limit":5',
      'runbook paragraph',
      'sk-abcdef1234567890abcdef',
      'trace-payload',
      'someone@example.com',
      'personal account details',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('strips identifier-shaped values even under allowlisted keys', () => {
    const { redacted, removedKeys } = redactAttributes({
      toolName: 'turn_abc123',
      status: 'completed',
    });
    expect(redacted).toEqual({ status: 'completed' });
    expect(removedKeys).toEqual(['toolName']);
  });
});

describe('assertMetricLabelsSafe', () => {
  it('accepts bounded labels', () => {
    expect(() =>
      assertMetricLabelsSafe({
        environment: 'production',
        toolName: 'searchDocumentation',
        status: 'completed',
        modality: 'vector',
      }),
    ).not.toThrow();
  });

  it('rejects turn and user identifiers', () => {
    expect(() => assertMetricLabelsSafe({ toolName: 'turn_abc123' })).toThrow(/unbounded/);
    expect(() => assertMetricLabelsSafe({ status: 'user_42' })).toThrow(/unbounded/);
    expect(() => assertMetricLabelsSafe({ modelId: '550e8400-e29b-41d4-a716-446655440000' })).toThrow(
      /unbounded/,
    );
  });

  it('rejects raw queries, document ids, error text, and tool arguments', () => {
    expect(() => assertMetricLabelsSafe({ status: 'how do I reset my password' })).toThrow(
      /unbounded/,
    );
    expect(() => assertMetricLabelsSafe({ modelId: 'doc-98765' })).toThrow(/unbounded/);
    expect(() =>
      assertMetricLabelsSafe({ reasonCode: 'connection reset by peer at db-primary' }),
    ).toThrow(/unbounded/);
    expect(() => assertMetricLabelsSafe({ signal: '{"limit":3,"q":"x"}' })).toThrow(/unbounded/);
  });

  it('rejects unknown label keys', () => {
    expect(() => assertMetricLabelsSafe({ rawQuery: 'reset' })).toThrow(/label key/);
  });

  it('never lists turn or user ids as bounded dimensions', () => {
    for (const key of ['turnId', 'traceId', 'userId', 'rawQuery', 'documentId', 'toolArgs']) {
      expect(BOUNDED_DIMENSION_KEYS.has(key)).toBe(false);
    }
    for (const key of ['environment', 'toolName', 'status', 'modality', 'cacheLayer']) {
      expect(BOUNDED_DIMENSION_KEYS.has(key)).toBe(true);
    }
  });
});

describe('redactEvent', () => {
  it('deep-redacts envelope attributes and masks secret-shaped payload text', () => {
    const event = createEvent(
      baseEnvelope({
        attributes: {
          environment: 'production',
          userMessage: 'full user message must not survive',
          secret: 'sk-abcdef1234567890abcdef',
        },
        reasonCode: 'provider said sk-abcdef1234567890abcdef broke',
      }),
    );
    const redacted = redactEvent(event);
    expect(redacted.attributes).toEqual({ environment: 'production' });
    if (redacted.eventType === 'tool.terminal') {
      expect(redacted.reasonCode).toBe('[redacted]');
    } else {
      throw new Error('expected tool.terminal event');
    }
    expect(Object.isFrozen(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('sk-abcdef1234567890abcdef');
    expect(JSON.stringify(redacted)).not.toContain('full user message must not survive');
  });

  it('keeps provenance ids and reason codes in traces', () => {
    const event = createEvent(
      baseEnvelope({
        attributes: { toolName: 'searchDocumentation', resultKind: 'success' },
        callId: 'call-1',
      }),
    );
    const redacted = redactEvent(event);
    expect(redacted.traceId).toBe('trace-001');
    expect(redacted.turnId).toBe('turn-001');
    if (redacted.eventType === 'tool.terminal') {
      expect(redacted.callId).toBe('call-1');
    } else {
      throw new Error('expected tool.terminal event');
    }
  });
});
