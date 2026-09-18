import { describe, expect, it } from 'vitest';
import {
  assertRouteEnvelopeValid,
  CHAT_ROUTE_MAX_DURATION_SECS,
  minimumReserveForPlatform,
  resolveRouteEnvelope,
  ROUTE_ENVELOPE_CANDIDATE_90,
  ROUTE_ENVELOPE_CURRENT_60,
  ROUTE_ENVELOPE_PROFILES,
  ROUTE_ENVELOPE_PROVISIONAL_120,
  assertLedgerFitsEnvelope,
} from '../route-envelope';

describe('route envelope deployment constants', () => {
  it('keeps the 60s route envelope unchanged', () => {
    expect(CHAT_ROUTE_MAX_DURATION_SECS).toBe(60);
    expect(ROUTE_ENVELOPE_CURRENT_60.platformLimitMs).toBe(60_000);
    expect(ROUTE_ENVELOPE_CURRENT_60.appHardStopMs).toBe(50_000);
    expect(ROUTE_ENVELOPE_CURRENT_60.finalizeReserveMs).toBe(10_000);
    expect(Object.isFrozen(ROUTE_ENVELOPE_CURRENT_60)).toBe(true);
  });

  it('carries the 90/75/15 and 120/105/15 profiles as data, not config', () => {
    expect(ROUTE_ENVELOPE_CANDIDATE_90).toEqual({
      name: 'candidate-90s',
      platformLimitMs: 90_000,
      appHardStopMs: 75_000,
      finalizeReserveMs: 15_000,
    });
    expect(ROUTE_ENVELOPE_PROVISIONAL_120).toEqual({
      name: 'provisional-120s',
      platformLimitMs: 120_000,
      appHardStopMs: 105_000,
      finalizeReserveMs: 15_000,
    });
    expect(ROUTE_ENVELOPE_PROFILES).toHaveLength(3);
    expect(Object.isFrozen(ROUTE_ENVELOPE_PROFILES)).toBe(true);
  });

  it('computes the reserve floor as max(10s, 10% of platform)', () => {
    expect(minimumReserveForPlatform(60_000)).toBe(10_000);
    expect(minimumReserveForPlatform(90_000)).toBe(10_000);
    expect(minimumReserveForPlatform(100_000)).toBe(10_000);
    expect(minimumReserveForPlatform(120_000)).toBe(12_000);
    expect(minimumReserveForPlatform(200_000)).toBe(20_000);
    expect(() => minimumReserveForPlatform(0)).toThrow(/positive/);
  });

  it('holds at least the floor reserve in every profile', () => {
    for (const profile of ROUTE_ENVELOPE_PROFILES) {
      expect(profile.finalizeReserveMs).toBeGreaterThanOrEqual(
        minimumReserveForPlatform(profile.platformLimitMs),
      );
    }
    // The 120/105/15 profile reserves a full 15s, above the 12s floor.
    expect(ROUTE_ENVELOPE_PROVISIONAL_120.finalizeReserveMs).toBe(15_000);
  });
});

describe('route envelope build assertion', () => {
  it('requires the app hard stop to be smaller than the platform limit', () => {
    expect(() =>
      assertRouteEnvelopeValid({
        name: 'equal',
        platformLimitMs: 60_000,
        appHardStopMs: 60_000,
        finalizeReserveMs: 0,
      }),
    ).toThrow(/must be smaller/);
    expect(() =>
      assertRouteEnvelopeValid({
        name: 'higher',
        platformLimitMs: 60_000,
        appHardStopMs: 65_000,
        finalizeReserveMs: 1_000,
      }),
    ).toThrow(/must be smaller/);
  });

  it('requires the reserve to equal platform minus app hard stop', () => {
    expect(() =>
      assertRouteEnvelopeValid({
        name: 'mismatch',
        platformLimitMs: 60_000,
        appHardStopMs: 50_000,
        finalizeReserveMs: 5_000,
      }),
    ).toThrow(/must equal platform limit minus app hard stop/);
  });

  it('rejects a reserve below the minimum floor', () => {
    expect(() =>
      assertRouteEnvelopeValid({
        name: 'thin',
        platformLimitMs: 120_000,
        appHardStopMs: 112_000,
        finalizeReserveMs: 8_000,
      }),
    ).toThrow(/below the minimum/);
  });

  it('rejects malformed envelopes at the boundary', () => {
    expect(() => assertRouteEnvelopeValid(null)).toThrow();
    expect(() => assertRouteEnvelopeValid({})).toThrow();
    expect(() =>
      assertRouteEnvelopeValid({
        name: 'bad',
        platformLimitMs: -1,
        appHardStopMs: 1,
        finalizeReserveMs: 0,
      }),
    ).toThrow();
  });
});

describe('resolveRouteEnvelope', () => {
  it('resolves every known profile by name', () => {
    expect(resolveRouteEnvelope('current-60s')).toBe(ROUTE_ENVELOPE_CURRENT_60);
    expect(resolveRouteEnvelope('candidate-90s')).toBe(ROUTE_ENVELOPE_CANDIDATE_90);
    expect(resolveRouteEnvelope('provisional-120s')).toBe(ROUTE_ENVELOPE_PROVISIONAL_120);
  });

  it('rejects unknown envelope names', () => {
    expect(() => resolveRouteEnvelope('prod-300s')).toThrow(/unknown envelope/);
  });
});

describe('assertLedgerFitsEnvelope', () => {
  it('accepts a deadline at or below the app hard stop', () => {
    expect(() =>
      assertLedgerFitsEnvelope({
        acceptedAtMs: 1_000,
        deadlineAt: 51_000,
        envelope: ROUTE_ENVELOPE_CURRENT_60,
      }),
    ).not.toThrow();
  });

  it('rejects an incompatible higher deadline', () => {
    expect(() =>
      assertLedgerFitsEnvelope({
        acceptedAtMs: 1_000,
        deadlineAt: 51_001,
        envelope: ROUTE_ENVELOPE_CURRENT_60,
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      assertLedgerFitsEnvelope({
        acceptedAtMs: 0,
        deadlineAt: 120_000,
        envelope: ROUTE_ENVELOPE_CURRENT_60,
      }),
    ).toThrow(/exceeds/);
  });
});
