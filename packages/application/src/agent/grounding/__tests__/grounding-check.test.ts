import { describe, expect, it } from 'vitest';
import type { GroundingCitation, StructuredEvidenceItem } from '../grounding-decision';
import { runGroundingCheck, type GraderFn, type GroundingCheckInput } from '../grounding-check';
import { GROUNDED_RELEASE_FLAG, readGroundedReleaseFlag } from '../grounding-flags';
import { GROUNDING_TRACE_VERSION, toLogFields } from '../grounding-telemetry';
import { SAFE_NEXT_ACTIONS, SAFE_RESPONSE_VERSION, safeResponseFor } from '../safe-response';

const CANDIDATE_SECRET = 'candidate-secret-zxq-9981';
const DOCUMENTS_SECRET = 'documents-secret-zxq-7781';

function citation(overrides: Partial<GroundingCitation> = {}): GroundingCitation {
  return {
    id: 1,
    documentId: 10,
    chunkIndex: 0,
    snippet: 'a cited snippet',
    ...overrides,
  };
}

function evidenceItem(): StructuredEvidenceItem {
  return {
    documentId: 10,
    chunkIndex: 0,
    subquestionIds: ['sq-a'],
    callIds: ['call-1'],
    queryIds: ['q-1'],
    content: 'evidence content',
  };
}

function baseInput(overrides: Partial<GroundingCheckInput> = {}): GroundingCheckInput {
  return {
    candidateText: `candidate answer ${CANDIDATE_SECRET}`,
    documentationRequired: true,
    citations: [citation()],
    evidence: [evidenceItem()],
    documentsText: `packed documents ${DOCUMENTS_SECRET}`,
    evidenceChunks: 1,
    evidenceTokens: 120,
    validatorOutcome: 'valid',
    validatorReason: null,
    validCitations: [citation()],
    grader: () => Promise.resolve('yes'),
    releaseEnabled: true,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yesGrader(calls: { count: number }): GraderFn {
  return () => {
    calls.count += 1;
    return Promise.resolve('yes');
  };
}

describe('runGroundingCheck grader path', () => {
  it('resolves verified when the grader answers yes', async () => {
    const calls = { count: 0 };
    const result = await runGroundingCheck(baseInput({ grader: yesGrader(calls) }));
    expect(calls.count).toBe(1);
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'verified', citations: [citation()] });
    expect(result.telemetry.decisionKind).toBe('verified');
    expect(result.telemetry.decisionReason).toBeNull();
    expect(result.telemetry.graderOutcome).toBe('supported');
    expect(result.telemetry.cancelled).toBe(false);
    expect(result.telemetry.timedOut).toBe(false);
    expect(result.telemetry.attribution).toBe('none');
  });

  it('resolves rejected unsupported_claim when the grader answers no', async () => {
    const result = await runGroundingCheck(baseInput({ grader: () => Promise.resolve('no') }));
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'rejected', reason: 'unsupported_claim' });
    expect(result.telemetry.decisionKind).toBe('rejected');
    expect(result.telemetry.decisionReason).toBe('unsupported_claim');
    expect(result.telemetry.graderOutcome).toBe('unsupported');
  });

  it('rejects missing_citation when yes arrives with no valid citations', async () => {
    const result = await runGroundingCheck(
      baseInput({ validCitations: [], citations: [], grader: () => Promise.resolve('yes') }),
    );
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'rejected', reason: 'missing_citation' });
  });

  it('maps a malformed grader value to unverified malformed', async () => {
    const malformed = (() => Promise.resolve('maybe')) as unknown as GraderFn;
    const result = await runGroundingCheck(baseInput({ grader: malformed }));
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'unverified', reason: 'malformed' });
    expect(result.telemetry.graderOutcome).toBe('malformed');
    expect(result.telemetry.attribution).toBe('grader_malformed');
  });

  it('maps a throwing grader to unverified grader_unavailable', async () => {
    const failing: GraderFn = () => Promise.reject(new Error('grader exploded'));
    const result = await runGroundingCheck(baseInput({ grader: failing }));
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'unverified', reason: 'grader_unavailable' });
    expect(result.telemetry.graderOutcome).toBe('unavailable');
    expect(result.telemetry.attribution).toBe('grader_unavailable');
    expect(result.telemetry.timedOut).toBe(false);
  });

  it('maps TimeoutError, AbortError, and timeout-like messages to unverified timeout', async () => {
    const timeoutError = new Error('provider blew up');
    timeoutError.name = 'TimeoutError';
    const abortError = new DOMException('aborted', 'AbortError');
    const messageMatch = new Error('request timed out waiting for budget room');
    for (const thrown of [timeoutError, abortError, messageMatch]) {
      const failing: GraderFn = () => Promise.reject(thrown);
      const result = await runGroundingCheck(baseInput({ grader: failing }));
      expect(result.status).toBe('decided');
      if (result.status !== 'decided') return;
      expect(result.decision).toEqual({ kind: 'unverified', reason: 'timeout' });
      expect(result.telemetry.graderOutcome).toBe('timeout');
      expect(result.telemetry.timedOut).toBe(true);
      expect(result.telemetry.attribution).toBe('grounding_timeout');
    }
  });

  it('returns unverified timeout on a never-resolving grader and never verifies', async () => {
    const hanging: GraderFn = () => new Promise<'yes' | 'no'>(() => {});
    const result = await runGroundingCheck(baseInput({ grader: hanging, timeoutMs: 10 }));
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'unverified', reason: 'timeout' });
    expect(result.telemetry.timedOut).toBe(true);
    expect(result.telemetry.attribution).toBe('grounding_timeout');
  });
});

describe('runGroundingCheck fast paths', () => {
  it('short-circuits an invalid validator without calling the grader', async () => {
    const calls = { count: 0 };
    const result = await runGroundingCheck(
      baseInput({ validatorOutcome: 'invalid', validatorReason: 'missing_citation', grader: yesGrader(calls) }),
    );
    expect(calls.count).toBe(0);
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'rejected', reason: 'missing_citation' });
    expect(result.telemetry.validatorOutcome).toBe('invalid');
    expect(result.telemetry.graderOutcome).toBe('skipped');
  });

  it('maps a non-citation invalid reason to unsupported_claim', async () => {
    const calls = { count: 0 };
    for (const validatorReason of ['stale_chunk', null]) {
      const result = await runGroundingCheck(
        baseInput({ validatorOutcome: 'invalid', validatorReason, grader: yesGrader(calls) }),
      );
      expect(result.status).toBe('decided');
      if (result.status !== 'decided') return;
      expect(result.decision).toEqual({ kind: 'rejected', reason: 'unsupported_claim' });
    }
    expect(calls.count).toBe(0);
  });

  it('releases casual answers as verified without calling the grader', async () => {
    const calls = { count: 0 };
    const result = await runGroundingCheck(
      baseInput({
        documentationRequired: false,
        citations: [],
        validCitations: [],
        validatorOutcome: 'skipped',
        grader: yesGrader(calls),
      }),
    );
    expect(calls.count).toBe(0);
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'verified', citations: [] });
    expect(result.telemetry.validatorOutcome).toBe('skipped');
    expect(result.telemetry.graderOutcome).toBe('skipped');
  });

  it('fails closed without the grader when the release flag is off', async () => {
    const calls = { count: 0 };
    const result = await runGroundingCheck(
      baseInput({ releaseEnabled: false, grader: yesGrader(calls) }),
    );
    expect(calls.count).toBe(0);
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'unverified', reason: 'grader_unavailable' });
    expect(result.telemetry.attribution).toBe('grader_unavailable');
  });

  it('fails closed when no grader is configured', async () => {
    const result = await runGroundingCheck(baseInput({ grader: null }));
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toEqual({ kind: 'unverified', reason: 'grader_unavailable' });
  });

  it('fails closed without calling the grader when timeoutMs is not positive', async () => {
    for (const timeoutMs of [0, -5]) {
      const calls = { count: 0 };
      const result = await runGroundingCheck(baseInput({ timeoutMs, grader: yesGrader(calls) }));
      expect(calls.count).toBe(0);
      expect(result.status).toBe('decided');
      if (result.status !== 'decided') return;
      expect(result.decision).toEqual({ kind: 'unverified', reason: 'timeout' });
      expect(result.telemetry.timedOut).toBe(true);
    }
  });
});

describe('runGroundingCheck cancellation', () => {
  it('returns cancelled without calling the grader when already aborted', async () => {
    const calls = { count: 0 };
    const controller = new AbortController();
    controller.abort();
    const result = await runGroundingCheck(baseInput({ signal: controller.signal, grader: yesGrader(calls) }));
    expect(calls.count).toBe(0);
    expect(result.status).toBe('cancelled');
    expect(result.telemetry.decisionKind).toBe('cancelled');
    expect(result.telemetry.cancelled).toBe(true);
    expect(result.telemetry.attribution).toBe('request_cancelled');
  });

  it('ignores a late grader yes after a mid-flight abort', async () => {
    const controller = new AbortController();
    const lateYes: GraderFn = () => sleep(20).then((): 'yes' => 'yes');
    const pending = runGroundingCheck(baseInput({ signal: controller.signal, grader: lateYes, timeoutMs: 1000 }));
    await sleep(5);
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    await sleep(60);
    expect(result.status).toBe('cancelled');
    expect(result.telemetry.attribution).toBe('request_cancelled');
  });
});

describe('grounding telemetry hygiene', () => {
  it('populates counters and the trace version without leaking content', async () => {
    const result = await runGroundingCheck(
      baseInput({ evidenceChunks: 3, evidenceTokens: 450, grader: () => Promise.resolve('yes') }),
    );
    if (result.status !== 'decided') throw new Error('expected a decided result');
    expect(result.telemetry.evidenceChunks).toBe(3);
    expect(result.telemetry.evidenceTokens).toBe(450);
    expect(result.telemetry.citationCount).toBe(1);
    expect(result.telemetry.validCitationCount).toBe(1);
    expect(result.telemetry.traceVersion).toBe(GROUNDING_TRACE_VERSION);
    expect(result.telemetry.answerReadyMs).toBeNull();
    expect(result.telemetry.answerReleasedMs).toBeNull();
    expect(typeof result.telemetry.verificationMs).toBe('number');
    const logged = JSON.stringify(toLogFields(result.telemetry));
    expect(logged).not.toContain(CANDIDATE_SECRET);
    expect(logged).not.toContain(DOCUMENTS_SECRET);
  });

  it('toLogFields exposes exactly the declared telemetry fields', () => {
    const fields = toLogFields({
      answerReadyMs: null,
      verificationMs: 12,
      answerReleasedMs: null,
      decisionKind: 'verified',
      decisionReason: null,
      validatorOutcome: 'valid',
      validatorReason: null,
      graderOutcome: 'supported',
      cancelled: false,
      timedOut: false,
      attribution: 'none',
      evidenceChunks: 2,
      evidenceTokens: 200,
      citationCount: 1,
      validCitationCount: 1,
      traceVersion: GROUNDING_TRACE_VERSION,
    });
    expect(Object.keys(fields).sort()).toEqual(
      [
        'answerReadyMs', 'verificationMs', 'answerReleasedMs',
        'decisionKind', 'decisionReason', 'validatorOutcome', 'validatorReason',
        'graderOutcome', 'cancelled', 'timedOut', 'attribution',
        'evidenceChunks', 'evidenceTokens', 'citationCount', 'validCitationCount',
        'traceVersion',
      ].sort(),
    );
  });
});

describe('safe responses', () => {
  it('uses the rejected variant for unsupported answers', () => {
    const response = safeResponseFor({ decisionKind: 'rejected', reason: 'missing_citation', ticketEligible: false });
    expect(response.text).toContain("I couldn't verify this against our documentation");
    expect(response.offerTicket).toBe(false);
  });

  it('uses the unverified variant when verification is unavailable', () => {
    const response = safeResponseFor({ decisionKind: 'unverified', reason: 'timeout', ticketEligible: false });
    expect(response.text).toContain("I couldn't complete source verification");
    expect(response.offerTicket).toBe(false);
  });

  it('offers a ticket only when eligible and leaks no internals', () => {
    const withTicket = safeResponseFor({ decisionKind: 'rejected', reason: 'unsupported_claim', ticketEligible: true });
    expect(withTicket.offerTicket).toBe(true);
    expect(withTicket.text).toContain('knowledge ticket');
    const withoutTicket = safeResponseFor({ decisionKind: 'unverified', reason: 'timeout', ticketEligible: false });
    expect(withoutTicket.text).not.toContain('ticket');
    for (const text of [withTicket.text, withoutTicket.text]) {
      expect(text).not.toContain('Error');
      expect(text).not.toContain('error');
      expect(text).not.toContain('timeout');
      expect(text).not.toContain('Timeout');
      expect(text).not.toContain(CANDIDATE_SECRET);
      expect(text).not.toContain(DOCUMENTS_SECRET);
    }
    expect(SAFE_RESPONSE_VERSION).toBe('v1');
    expect(SAFE_NEXT_ACTIONS.length).toBeGreaterThan(0);
  });
});

describe('grounded release flag', () => {
  function envWith(values: Record<string, string>): { get(key: string): string | undefined } {
    return {
      get: (key: string): string | undefined => values[key],
    };
  }

  it('uses the documented flag name and defaults to enabled', () => {
    expect(GROUNDED_RELEASE_FLAG).toBe('GROUNDED_RELEASE_ENABLED');
    expect(readGroundedReleaseFlag(envWith({}))).toEqual({ enabled: true, source: 'default' });
  });

  it('parses explicit on and off values', () => {
    expect(readGroundedReleaseFlag(envWith({ [GROUNDED_RELEASE_FLAG]: '1' }))).toEqual({ enabled: true, source: 'env' });
    expect(readGroundedReleaseFlag(envWith({ [GROUNDED_RELEASE_FLAG]: '0' }))).toEqual({ enabled: false, source: 'env' });
    expect(readGroundedReleaseFlag(envWith({ [GROUNDED_RELEASE_FLAG]: 'off' }))).toEqual({ enabled: false, source: 'env' });
  });

  it('fails open to the default on unrecognized values', () => {
    expect(readGroundedReleaseFlag(envWith({ [GROUNDED_RELEASE_FLAG]: 'sometimes' }))).toEqual({ enabled: true, source: 'env' });
  });
});
