export const GROUNDED_RELEASE_FLAG = 'GROUNDED_RELEASE_ENABLED' as const;

export const GROUNDED_RELEASE_FLAG_OWNER = 'chat agent on-call' as const;

export const GROUNDED_RELEASE_DEFAULT = 'enabled' as const;

export const GROUNDED_RELEASE_EFFECT =
  'When enabled, documentation-required answers use buffered verified-answer release: ' +
  'deterministic citation/evidence validation runs first, then the LLM grounding grader, ' +
  'then the release policy (verified releases with citations; rejected/unverified get the safe response). ' +
  'When disabled (rollback), the turn still runs deterministic validation and releases fail-closed ' +
  'WITHOUT calling the LLM grader: documentation-required answers without verification get the safe ' +
  'response, while casual answers that require no evidence still release.';

export const GROUNDED_RELEASE_REMOVAL =
  'Remove the flag after the enabled verified-release path and the disabled fail-closed path both pass ' +
  'the WP-6 grounding gates (Section 12.1, 12.4).';

export const GROUNDED_RELEASE_ROLLBACK =
  'Set GROUNDED_RELEASE_ENABLED=0 and restart. Rollback keeps deterministic validation and the ' +
  'fail-closed release: it never calls the grader, never streams unverified text as verified, and never ' +
  'writes rejected/unverified answers to the grounded answer cache. Rollback MUST NOT restore ' +
  'fail-open streaming or grounded-cache writes for unverified answers.';

export interface GroundedReleaseFlagEnv {
  get(key: string): string | undefined;
}

export interface GroundedReleaseFlagResult {
  readonly enabled: boolean;
  readonly source: 'env' | 'default';
}

function parseFlagValue(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return undefined;
}

export function readGroundedReleaseFlag(env: GroundedReleaseFlagEnv): GroundedReleaseFlagResult {
  const raw = env.get(GROUNDED_RELEASE_FLAG);
  if (raw === undefined) {
    const result: GroundedReleaseFlagResult = { enabled: true, source: 'default' };
    return Object.freeze(result);
  }
  const parsed = parseFlagValue(raw);
  // Unrecognized values fail open to the default production path.
  const result: GroundedReleaseFlagResult = { enabled: parsed ?? true, source: 'env' };
  return Object.freeze(result);
}
