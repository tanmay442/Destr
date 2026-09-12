export const GROUNDING_TRACE_VERSION = 'grounding-v1' as const;

export interface GroundingTelemetry {
  readonly answerReadyMs: number | null;
  readonly verificationMs: number | null;
  readonly answerReleasedMs: number | null;
  readonly decisionKind: 'verified' | 'rejected' | 'unverified' | 'cancelled';
  readonly decisionReason: string | null;
  readonly validatorOutcome: 'valid' | 'invalid' | 'skipped';
  readonly validatorReason: string | null;
  readonly graderOutcome: 'supported' | 'unsupported' | 'timeout' | 'unavailable' | 'malformed' | 'skipped';
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly attribution: 'none' | 'request_cancelled' | 'deadline_exceeded' | 'grounding_timeout' | 'grader_unavailable' | 'grader_malformed';
  readonly evidenceChunks: number;
  readonly evidenceTokens: number;
  readonly citationCount: number;
  readonly validCitationCount: number;
  readonly traceVersion: string;
}

// Raw answer content, candidate text, retrieved document text, and provider
// payloads must never enter telemetry. This interface carries only counts,
// timings, and enum/reason codes, and toLogFields copies exactly those fields.
export function toLogFields(telemetry: GroundingTelemetry): Record<string, number | string | boolean | null> {
  return {
    answerReadyMs: telemetry.answerReadyMs,
    verificationMs: telemetry.verificationMs,
    answerReleasedMs: telemetry.answerReleasedMs,
    decisionKind: telemetry.decisionKind,
    decisionReason: telemetry.decisionReason,
    validatorOutcome: telemetry.validatorOutcome,
    validatorReason: telemetry.validatorReason,
    graderOutcome: telemetry.graderOutcome,
    cancelled: telemetry.cancelled,
    timedOut: telemetry.timedOut,
    attribution: telemetry.attribution,
    evidenceChunks: telemetry.evidenceChunks,
    evidenceTokens: telemetry.evidenceTokens,
    citationCount: telemetry.citationCount,
    validCitationCount: telemetry.validCitationCount,
    traceVersion: telemetry.traceVersion,
  };
}
