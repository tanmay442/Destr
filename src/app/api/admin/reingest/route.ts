import { requireAdminRoute, respondResult } from '@/composition';

const REINGEST_WINDOW_MS = 60_000;

let reingestInFlight = false;

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;

  const actorId = auth.session.user.id;
  const limit = await auth.comp.rateLimit(`reingest:${actorId}`, { limit: 1, windowMs: REINGEST_WINDOW_MS });
  if (!limit.ok) {
    const retryAfter = Number.isFinite(limit.retryAfterMs) ? String(Math.ceil(limit.retryAfterMs / 1000)) : '60';
    return Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': retryAfter } });
  }

  if (reingestInFlight) {
    return Response.json({ error: 'A re-ingest is already running' }, { status: 409 });
  }
  reingestInFlight = true;
  try {
    const result = await auth.comp.reingestAll();
    return respondResult(result);
  } finally {
    reingestInFlight = false;
  }
}