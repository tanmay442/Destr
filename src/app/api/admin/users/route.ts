import { requireAdminGet, parseQueryPagination, respondResult } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const { comp, url } = auth;
  const search = url.searchParams.get('search')?.slice(0, 200) || undefined;
  const { limit, offset } = parseQueryPagination(url);
  const result = await comp.listUsers({ search, limit, offset });
  return respondResult(result);
}
