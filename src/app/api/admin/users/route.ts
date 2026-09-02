import { requireAdminGet, parseQueryPagination, respondResult } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const { comp, url } = auth;
  const search = url.searchParams.get('search')?.slice(0, 200) || undefined;
  const { limit, offset } = parseQueryPagination(url);
  const cursor = url.searchParams.get('cursor');
  const before = url.searchParams.get('before');
  const result = await comp.listUsers({
    search,
    limit,
    ...(cursor !== null ? { cursor } : {}),
    ...(before !== null ? { before } : {}),
    ...(cursor === null && before === null ? { offset } : {}),
  });
  return respondResult(result);
}
