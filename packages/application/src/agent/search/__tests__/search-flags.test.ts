import { describe, expect, it } from 'vitest';
import {
  QUERY2DOC_FLAG,
  readPlannerFlags,
  STRUCTURED_PLANNER_FLAG,
} from '../search-flags';

describe('structured planner flags (WP-4 rollout)', () => {
  it('defaults to normal hybrid retrieval with planner disabled', () => {
    const flags = readPlannerFlags({ get: () => undefined });
    expect(flags.plannerEnabled).toBe(false);
    expect(flags.plannerPath).toBe('normal');
    expect(flags.query2docEnabled).toBe(false);
  });

  it('enables planner explicitly and supports shadow comparison without changing results', () => {
    const enabled = readPlannerFlags({ get: (key: string) => (key === STRUCTURED_PLANNER_FLAG ? '1' : undefined) });
    expect(enabled.plannerEnabled).toBe(true);
    expect(enabled.plannerPath).toBe('planner');

    const shadow = readPlannerFlags({ get: (key: string) => (key === 'SEARCH_PLANNER_SHADOW' ? 'true' : undefined) });
    expect(shadow.plannerEnabled).toBe(false);
    expect(shadow.shadowEnabled).toBe(true);
    expect(shadow.plannerPath).toBe('planner_shadow');
  });

  it('query2doc/HyDE remains separately flagged and disabled by default', () => {
    const flags = readPlannerFlags({ get: () => undefined });
    expect(flags.query2docEnabled).toBe(false);
    const enabled = readPlannerFlags({ get: (key: string) => (key === QUERY2DOC_FLAG ? 'true' : undefined) });
    expect(enabled.query2docEnabled).toBe(true);
    expect(enabled.plannerEnabled).toBe(false);
  });

  it('rollback preserves error classification by disabling planner only', () => {
    const rollback = readPlannerFlags({ get: (key: string) => (key === STRUCTURED_PLANNER_FLAG ? '0' : undefined) });
    expect(rollback.plannerEnabled).toBe(false);
    expect(rollback.plannerPath).toBe('normal');
  });
});
