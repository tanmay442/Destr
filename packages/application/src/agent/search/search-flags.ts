export type PlannerFlagEnv = {
  get(key: string): string | undefined;
};

function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

export const STRUCTURED_PLANNER_FLAG = 'SEARCH_STRUCTURED_PLANNER_ENABLED';
export const PLANNER_SHADOW_FLAG = 'SEARCH_PLANNER_SHADOW';
export const QUERY2DOC_FLAG = 'SEARCH_QUERY2DOC_ENABLED';

export interface PlannerFlagState {
  readonly plannerEnabled: boolean;
  readonly shadowEnabled: boolean;
  readonly query2docEnabled: boolean;
  readonly plannerPath: 'planner' | 'normal' | 'planner_shadow';
}

export function readPlannerFlags(env: PlannerFlagEnv): PlannerFlagState {
  const rawPlanner = env.get(STRUCTURED_PLANNER_FLAG);
  const rawShadow = env.get(PLANNER_SHADOW_FLAG);
  const rawHyde = env.get(QUERY2DOC_FLAG);
  const plannerEnabled = isTruthyFlag(rawPlanner);
  const shadowEnabled = isTruthyFlag(rawShadow);
  const query2docEnabled = isTruthyFlag(rawHyde);
  const plannerPath: PlannerFlagState['plannerPath'] = plannerEnabled
    ? 'planner'
    : shadowEnabled
      ? 'planner_shadow'
      : 'normal';
  return { plannerEnabled, shadowEnabled, query2docEnabled, plannerPath };
}

export const STRUCTURED_PLANNER_FLAG_OWNER = 'chat agent on-call';
export const STRUCTURED_PLANNER_DEFAULT = 'disabled (normal hybrid retrieval is the default)';
export const STRUCTURED_PLANNER_REMOVAL_CONDITION =
  'WP-9: remove the flag only after the planner passes the Section 12.3 retrieval gates on the pinned corpus; if the planner is rejected, remove the planner path and keep normal hybrid retrieval.';
export const STRUCTURED_PLANNER_ROLLBACK =
  'Set SEARCH_STRUCTURED_PLANNER_ENABLED=0 (and SEARCH_PLANNER_SHADOW=0) and restart. Rollback preserves WP-1 error classification, WP-2 score semantics, stable identity, over-fetch, and backfill behavior.';
export const QUERY2DOC_FLAG_OWNER = 'chat agent on-call';
export const QUERY2DOC_DEFAULT = 'disabled; experimental only, never enabled by default in WP-4.';
