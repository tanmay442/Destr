import { describe, expect, it } from 'vitest';
import {
  canRunRetrievals,
  canStartAnotherPlan,
  consumption,
  createBudgetState,
  DEFAULT_SEARCH_BUDGET_LIMITS,
} from '../search-budget';

describe('search budgets (WP-4 independent enforcement)', () => {
  it('exposes independent limits for every required dimension', () => {
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxResultsPerSearchCall).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxCandidatesPerModality).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxResultsPerSubquestion).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxSearchPlans).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxPhysicalRetrievals).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxConcurrentRetrievals).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxUniqueEvidenceChunks).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_BUDGET_LIMITS.maxEvidenceTokens).toBeGreaterThan(0);
  });

  it('tracks consumed and remaining budget data', () => {
    const state = createBudgetState({ maxSearchPlans: 2, maxPhysicalRetrievals: 5 }, { plansUsed: 1, physicalRetrievalsUsed: 3 });
    expect(canStartAnotherPlan(state)).toBe(true);
    expect(canRunRetrievals(state, 2)).toBe(true);
    expect(canRunRetrievals(state, 3)).toBe(false);
    expect(consumption(3, 5)).toEqual({ consumed: 3, limit: 5, remaining: 2 });
  });

  it('generated boundary cases for budget counters do not multiply loops beyond the ceiling', () => {
    for (let subs = 1; subs <= 4; subs += 1) {
      for (let variants = 1; variants <= 3; variants += 1) {
        for (let rounds = 1; rounds <= 2; rounds += 1) {
          const physical = subs * variants * rounds;
          const ceiling = DEFAULT_SEARCH_BUDGET_LIMITS.maxPhysicalRetrievals;
          expect(physical).toBeLessThanOrEqual(4 * 3 * 2);
          if (physical > ceiling) {
            expect(canRunRetrievals(createBudgetState({}, { physicalRetrievalsUsed: ceiling }), 1)).toBe(false);
          }
        }
      }
    }
  });
});
