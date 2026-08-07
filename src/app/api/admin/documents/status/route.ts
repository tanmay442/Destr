import { requireAdminRoute, respond } from '@/composition';
import { MAX_LIST_LIMIT } from '@app/domain';

export async function GET(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;

  let pending = 0;
  let offset = 0;
  while (true) {
    const result = await auth.comp.listDocuments({
      includeDeleted: true,
      limit: MAX_LIST_LIMIT,
      offset,
      actorId: auth.session.user.id,
    });
    if (!result.ok) return respond(result.error);
    const { documents, total } = result.value;
    for (const doc of documents) {
      if (doc.ingestStatus === 'queued' || doc.ingestStatus === 'ingesting') {
        pending += 1;
      }
    }
    offset += documents.length;
    if (offset >= total || documents.length === 0) break;
  }
  return Response.json({ pending });
}
