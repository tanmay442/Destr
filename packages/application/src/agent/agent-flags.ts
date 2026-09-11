export const SUPPORT_AGENT_FLAG = 'SUPPORT_AGENT_ENABLED' as const;

export const SUPPORT_AGENT_FLAG_OWNER = 'chat agent on-call' as const;

export const SUPPORT_AGENT_DEFAULT = 'enabled' as const;

export const SUPPORT_AGENT_EFFECT =
  'When enabled, chat-turn uses the project-owned SupportAgent loop with the catalog tools; ' +
  'when disabled, it uses the same loop for one model step with tools hidden. ' +
  'The rollback preserves the same prompt, model port, budget, deadline, and output handling.';

export const SUPPORT_AGENT_REMOVAL =
  'Remove the flag after the one-step no-tools rollback and the enabled SupportAgent path pass the behavior gates.';

export const SUPPORT_AGENT_ROLLBACK = 'Set SUPPORT_AGENT_ENABLED=0 and restart.';

export interface SupportAgentFlagEnv {
  get(key: string): string | undefined;
}

export interface SupportAgentFlagResult {
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

export function readSupportAgentFlag(env: SupportAgentFlagEnv): SupportAgentFlagResult {
  const raw = env.get(SUPPORT_AGENT_FLAG);
  if (raw === undefined) {
    const result: SupportAgentFlagResult = { enabled: true, source: 'default' };
    return Object.freeze(result);
  }
  const parsed = parseFlagValue(raw);
  // Unrecognized values fail open to the default production path.
  const result: SupportAgentFlagResult = { enabled: parsed ?? true, source: 'env' };
  return Object.freeze(result);
}
