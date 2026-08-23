import { z } from 'zod';
import {
  requireAdminGet,
  requireAdminRoute,
  respond,
  respondResult,
} from '@/composition';
import { ValidationError, ok, ExternalServiceError } from '@app/domain';
import { V4_UUID_REGEX } from '@app/application/chat';

const SAMPLES_LIMIT = 20;

const ReviewRequestSchema = z.object({
  turnId: z.string().regex(V4_UUID_REGEX, 'turnId must be a v4 UUID'),
  verdict: z.enum(['good', 'bad', 'docs_missing']),
  note: z.string().max(2000).optional(),
});

/** GET: the two §C4 review samples (degraded + hallucination-blocked turns). */
export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const { comp } = auth;
  try {
    const [degraded, blocked] = await Promise.all([
      comp.chatEventBatcher.getQualitySamples(SAMPLES_LIMIT, { degraded: true }),
      comp.chatEventBatcher.getQualitySamples(SAMPLES_LIMIT, { blocked: true }),
    ]);
    return Response.json({ degraded, blocked });
  } catch (e) {
    return respond(new ExternalServiceError('Failed to load quality samples', e));
  }
}

/** POST: write one human review verdict to quality_reviews [§C4]. */
export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;

  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const parsed = ReviewRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return respond(new ValidationError('Invalid quality review', { issues: parsed.error.issues }));
  }

  const { comp } = auth;
  try {
    const row = await comp.qualityReviewsRepo.create({
      turnId: parsed.data.turnId,
      reviewerId: session.user.id,
      verdict: parsed.data.verdict,
      note: parsed.data.note ?? null,
    });
    return respondResult(ok(row));
  } catch (e) {
    return respond(new ExternalServiceError('Failed to save quality review', e));
  }
}
