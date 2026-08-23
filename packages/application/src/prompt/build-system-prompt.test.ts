import { describe, it, expect } from 'vitest';
import type { AppConfig } from '@app/domain';
import { buildSystemPrompt, FALLBACK_BLOCK } from './build-system-prompt';

function makeCfg(): AppConfig {
  return {
    orgName: 'Test Corp',
    audience: 'test customers',
    agentPersona: { name: 'Destr', tone: 'friendly' },
    outOfScopeTopics: [],
    customInstructions: undefined,
    retrievalMode: 'agentic',
    retrievalModeRolloutPercent: 100,
    agentStepBudget: 8,
    similarityThreshold: 0.5,
    hybridEnabled: true,
    rerankerProvider: 'cosine',
    gradeModel: undefined,
    answerCacheEnabled: true,
    answerCacheTtlSec: 3600,
    captureQueryText: true,
  } as unknown as AppConfig;
}

describe('buildSystemPrompt', () => {
  it('does not include the fallback block by default or when degraded is false', () => {
    expect(buildSystemPrompt(makeCfg(), null)).not.toContain(FALLBACK_BLOCK);
    expect(buildSystemPrompt(makeCfg(), null, false)).not.toContain(FALLBACK_BLOCK);
  });

  it('appends FALLBACK_BLOCK after the guardrail block when degraded is true', () => {
    const prompt = buildSystemPrompt(makeCfg(), null, true);
    expect(prompt).toContain(FALLBACK_BLOCK);
    expect(prompt).toContain('4 reference chunks');
    expect(prompt).toContain('best guess from related pages');
    const guardrailAt = prompt.indexOf('# Guardrails');
    const fallbackAt = prompt.indexOf('# Fallback Context');
    const outOfScopeAt = prompt.indexOf('# Out-of-Scope Topics');
    expect(guardrailAt).toBeGreaterThanOrEqual(0);
    expect(fallbackAt).toBeGreaterThan(guardrailAt);
    // The block sits directly after the guardrails and before later sections.
    expect(outOfScopeAt).toBeGreaterThan(fallbackAt);
  });

  it('keeps the rest of the prompt identical apart from the injected block', () => {
    const base = buildSystemPrompt(makeCfg(), null, false);
    const degraded = buildSystemPrompt(makeCfg(), null, true);
    expect(degraded.replace(`\n\n${FALLBACK_BLOCK}`, '')).toBe(base);
  });
});
