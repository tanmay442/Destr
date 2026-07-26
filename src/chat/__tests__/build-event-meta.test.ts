import { describe, it, expect } from 'vitest';
import { buildEventMeta } from '../build-event-meta';

describe('buildEventMeta', () => {
  it('returns an empty object when no signals are present', () => {
    expect(buildEventMeta({})).toEqual({});
  });

  it('includes rewritten only when true', () => {
    expect(buildEventMeta({ rewritten: true })).toEqual({ rewritten: true });
    expect(buildEventMeta({ rewritten: false })).toEqual({});
  });

  it('dedupes and filters document ids', () => {
    expect(buildEventMeta({ documentIds: [3, 3, 0, -1] })).toEqual({ documentIds: [3] });
    expect(buildEventMeta({ documentIds: [] })).toEqual({});
  });

  it('includes the ticket id captured from the createSupportTicket tool result', () => {
    expect(buildEventMeta({ ticketId: 'TKT-abc123' })).toEqual({ ticketId: 'TKT-abc123' });
    expect(buildEventMeta({ ticketId: null })).toEqual({});
    expect(buildEventMeta({ ticketId: undefined })).toEqual({});
  });

  it('merges rewritten, documentIds and ticketId together', () => {
    expect(
      buildEventMeta({ rewritten: true, documentIds: [1, 2], ticketId: 'TKT-zzz' }),
    ).toEqual({ rewritten: true, documentIds: [1, 2], ticketId: 'TKT-zzz' });
  });
});
