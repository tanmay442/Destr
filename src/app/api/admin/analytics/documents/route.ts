import { requireAdminGet, respondResult } from '@/composition';

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const rawLimit = Number(auth.url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
  const from = parseDate(auth.url.searchParams.get('from'));
  const to = parseDate(auth.url.searchParams.get('to'));
  const range = from || to ? { from, to } : undefined;
  const result = await auth.comp.getDocumentAnalytics({ actorId: auth.session.user.id, range, limit });
  return respondResult(result);
}
