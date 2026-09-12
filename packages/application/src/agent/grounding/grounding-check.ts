import type { GroundingCitation, GroundingDecision, StructuredEvidenceItem } from './grounding-decision';
import type { GroundingTelemetry } from './grounding-telemetry';
import { GROUNDING_TRACE_VERSION } from './grounding-telemetry';

export type GraderFn = (documentsText: string, candidateText: string) => Promise<'yes' | 'no'>;

export interface GroundingCheckInput {
  readonly candidateText: string;
  readonly documentationRequired: boolean;
  readonly citations: readonly GroundingCitation[];
  readonly evidence: readonly StructuredEvidenceItem[];
  readonly documentsText: string;
  readonly evidenceChunks: number;
  readonly evidenceTokens: number;
  readonly validatorOutcome: 'valid' | 'invalid' | 'skipped';
  readonly validatorReason: string | null;
  readonly validCitations: readonly GroundingCitation[];
  readonly grader: GraderFn | null;
  readonly releaseEnabled: boolean;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly nowMs?: () => number;
}

export type GroundingCheckResult =
  | { status: 'decided'; decision: GroundingDecision; telemetry: GroundingTelemetry }
  | { status: 'cancelled'; telemetry: GroundingTelemetry };

const MAX_GRADER_TIMEOUT_MS = 2_147_483_647;

const GRADER_TIMEOUT_PATTERN = /timed out|budget/i;

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return true;
    }
    return GRADER_TIMEOUT_PATTERN.test(error.message);
  }
  return false;
}

interface TelemetryFields {
  readonly decisionKind: GroundingTelemetry['decisionKind'];
  readonly decisionReason: string | null;
  readonly validatorOutcome: GroundingTelemetry['validatorOutcome'];
  readonly validatorReason: string | null;
  readonly graderOutcome: GroundingTelemetry['graderOutcome'];
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly attribution: GroundingTelemetry['attribution'];
}

export function runGroundingCheck(input: GroundingCheckInput): Promise<GroundingCheckResult> {
  const now = input.nowMs ?? Date.now;
  const startedAt = now();

  // Caller-stamping contract: the chat-turn caller stamps answerReadyMs before
  // invoking the runner and answerReleasedMs after the release policy runs.
  // The runner owns only verificationMs (measured here) and the decision
  // fields, so answerReadyMs/answerReleasedMs are always null in its output.
  const makeTelemetry = (fields: TelemetryFields): GroundingTelemetry => {
    const telemetry: GroundingTelemetry = {
      answerReadyMs: null,
      verificationMs: now() - startedAt,
      answerReleasedMs: null,
      decisionKind: fields.decisionKind,
      decisionReason: fields.decisionReason,
      validatorOutcome: fields.validatorOutcome,
      validatorReason: fields.validatorReason,
      graderOutcome: fields.graderOutcome,
      cancelled: fields.cancelled,
      timedOut: fields.timedOut,
      attribution: fields.attribution,
      evidenceChunks: input.evidenceChunks,
      evidenceTokens: input.evidenceTokens,
      citationCount: input.citations.length,
      validCitationCount: input.validCitations.length,
      traceVersion: GROUNDING_TRACE_VERSION,
    };
    return Object.freeze(telemetry);
  };

  const cancelledResult = (): GroundingCheckResult => ({
    status: 'cancelled',
    telemetry: makeTelemetry({
      decisionKind: 'cancelled',
      decisionReason: null,
      validatorOutcome: input.validatorOutcome,
      validatorReason: input.validatorReason,
      graderOutcome: 'skipped',
      cancelled: true,
      timedOut: false,
      attribution: 'request_cancelled',
    }),
  });

  if (input.signal.aborted) {
    return Promise.resolve(cancelledResult());
  }

  // Casual answers require no documentation: release without the grader.
  if (!input.documentationRequired) {
    return Promise.resolve({
      status: 'decided',
      decision: { kind: 'verified', citations: [...input.validCitations] },
      telemetry: makeTelemetry({
        decisionKind: 'verified',
        decisionReason: null,
        validatorOutcome: 'skipped',
        validatorReason: null,
        graderOutcome: 'skipped',
        cancelled: false,
        timedOut: false,
        attribution: 'none',
      }),
    });
  }

  // Deterministic rejection short-circuits before the grader ever runs.
  if (input.validatorOutcome === 'invalid') {
    const reason = input.validatorReason === 'missing_citation' ? 'missing_citation' : 'unsupported_claim';
    return Promise.resolve({
      status: 'decided',
      decision: { kind: 'rejected', reason },
      telemetry: makeTelemetry({
        decisionKind: 'rejected',
        decisionReason: reason,
        validatorOutcome: 'invalid',
        validatorReason: input.validatorReason,
        graderOutcome: 'skipped',
        cancelled: false,
        timedOut: false,
        attribution: 'none',
      }),
    });
  }

  // Flag rollback or missing grader: fail closed without calling the grader.
  if (!input.releaseEnabled || input.grader === null) {
    return Promise.resolve({
      status: 'decided',
      decision: { kind: 'unverified', reason: 'grader_unavailable' },
      telemetry: makeTelemetry({
        decisionKind: 'unverified',
        decisionReason: 'grader_unavailable',
        validatorOutcome: input.validatorOutcome,
        validatorReason: input.validatorReason,
        graderOutcome: 'skipped',
        cancelled: false,
        timedOut: false,
        attribution: 'grader_unavailable',
      }),
    });
  }

  // Non-positive budgets cannot fit grader work: fail closed without calling it.
  if (!(input.timeoutMs > 0)) {
    return Promise.resolve({
      status: 'decided',
      decision: { kind: 'unverified', reason: 'timeout' },
      telemetry: makeTelemetry({
        decisionKind: 'unverified',
        decisionReason: 'timeout',
        validatorOutcome: input.validatorOutcome,
        validatorReason: input.validatorReason,
        graderOutcome: 'timeout',
        cancelled: false,
        timedOut: true,
        attribution: 'grounding_timeout',
      }),
    });
  }

  const grader: GraderFn = input.grader;
  const timeoutMs = Math.min(Math.max(1, Math.floor(input.timeoutMs)), MAX_GRADER_TIMEOUT_MS);

  const decideFromVerdict = (verdict: 'yes' | 'no'): GroundingCheckResult => {
    if (verdict === 'yes') {
      // documentationRequired + valid implies at least one valid citation;
      // an empty set here is a defensive fail-closed rejection, never verified.
      if (input.validCitations.length === 0) {
        return {
          status: 'decided',
          decision: { kind: 'rejected', reason: 'missing_citation' },
          telemetry: makeTelemetry({
            decisionKind: 'rejected',
            decisionReason: 'missing_citation',
            validatorOutcome: input.validatorOutcome,
            validatorReason: input.validatorReason,
            graderOutcome: 'supported',
            cancelled: false,
            timedOut: false,
            attribution: 'none',
          }),
        };
      }
      return {
        status: 'decided',
        decision: { kind: 'verified', citations: [...input.validCitations] },
        telemetry: makeTelemetry({
          decisionKind: 'verified',
          decisionReason: null,
          validatorOutcome: input.validatorOutcome,
          validatorReason: input.validatorReason,
          graderOutcome: 'supported',
          cancelled: false,
          timedOut: false,
          attribution: 'none',
        }),
      };
    }
    if (verdict === 'no') {
      return {
        status: 'decided',
        decision: { kind: 'rejected', reason: 'unsupported_claim' },
        telemetry: makeTelemetry({
          decisionKind: 'rejected',
          decisionReason: 'unsupported_claim',
          validatorOutcome: input.validatorOutcome,
          validatorReason: input.validatorReason,
          graderOutcome: 'unsupported',
          cancelled: false,
          timedOut: false,
          attribution: 'none',
        }),
      };
    }
    // Any other wire value is malformed infrastructure output, not a verdict.
    return {
      status: 'decided',
      decision: { kind: 'unverified', reason: 'malformed' },
      telemetry: makeTelemetry({
        decisionKind: 'unverified',
        decisionReason: 'malformed',
        validatorOutcome: input.validatorOutcome,
        validatorReason: input.validatorReason,
        graderOutcome: 'malformed',
        cancelled: false,
        timedOut: false,
        attribution: 'grader_malformed',
      }),
    };
  };

  const decideFromThrow = (error: unknown): GroundingCheckResult => {
    // Infrastructure failures are never support verdicts: timeout-likes stay
    // timeouts, everything else is grader_unavailable.
    if (isTimeoutFailure(error)) {
      return {
        status: 'decided',
        decision: { kind: 'unverified', reason: 'timeout' },
        telemetry: makeTelemetry({
          decisionKind: 'unverified',
          decisionReason: 'timeout',
          validatorOutcome: input.validatorOutcome,
          validatorReason: input.validatorReason,
          graderOutcome: 'timeout',
          cancelled: false,
          timedOut: true,
          attribution: 'grounding_timeout',
        }),
      };
    }
    return {
      status: 'decided',
      decision: { kind: 'unverified', reason: 'grader_unavailable' },
      telemetry: makeTelemetry({
        decisionKind: 'unverified',
        decisionReason: 'grader_unavailable',
        validatorOutcome: input.validatorOutcome,
        validatorReason: input.validatorReason,
        graderOutcome: 'unavailable',
        cancelled: false,
        timedOut: false,
        attribution: 'grader_unavailable',
      }),
    };
  };

  return new Promise<GroundingCheckResult>((resolve) => {
    let settled = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish({
        status: 'decided',
        decision: { kind: 'unverified', reason: 'timeout' },
        telemetry: makeTelemetry({
          decisionKind: 'unverified',
          decisionReason: 'timeout',
          validatorOutcome: input.validatorOutcome,
          validatorReason: input.validatorReason,
          graderOutcome: 'timeout',
          cancelled: false,
          timedOut: true,
          attribution: 'grounding_timeout',
        }),
      });
    }, timeoutMs);
    const finish = (result: GroundingCheckResult): void => {
      // The settled guard makes timeout the winner permanent: verified is
      // reachable only via the grader resolving 'yes' while still pending,
      // and late grader settlement after timeout/cancel is ignored.
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', handleAbort);
      resolve(result);
    };
    function handleAbort(): void {
      finish(cancelledResult());
    }
    input.signal.addEventListener('abort', handleAbort, { once: true });
    if (input.signal.aborted) {
      handleAbort();
      return;
    }
    let pending: Promise<'yes' | 'no'>;
    try {
      pending = grader(input.documentsText, input.candidateText);
    } catch (error) {
      finish(decideFromThrow(error));
      return;
    }
    // Two-callback .then handles fulfillment and rejection inline, so a late
    // or failing grader can never produce an unhandled rejection.
    void Promise.resolve(pending).then(
      (verdict) => {
        finish(decideFromVerdict(verdict));
      },
      (error: unknown) => {
        finish(decideFromThrow(error));
      },
    );
  });
}
