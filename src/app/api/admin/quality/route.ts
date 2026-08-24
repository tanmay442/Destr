import { z } from 'zod';
import {
  requireAdminGet,
  requireAdminRoute,
  respond,
  respondResult,
} from '@/composition';
import { ValidationError, ok, ExternalServiceError } from '@app/domain';
import { V4_UUID_REGEX } from '@app/application/chat';

const QUALITY_WRITE_WINDOW_MS = 5_000;

const SAMPLES_LIMIT = 20;

const ReviewRequestSchema = z.object({
  turnId: z.string().regex(V4_UUID_REGEX, 'turnId must be a v4 UUID'),
  verdict: z.enum(['good', 'bad', 'docs_missing']),
  note: z.string().max(2000).optional(),
});

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
  const limit = await comp.rateLimit(`quality-review:${session.user.id}`, {
    limit: 1,
    windowMs: QUALITY_WRITE_WINDOW_MS,
  });
  if (!limit.ok) {
    const retryAfter = Number.isFinite(limit.retryAfterMs)
      ? String(Math.ceil(limit.retryAfterMs / 1000))
      : '5';
    return Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': retryAfter } });
  }

  try {
    const row = await comp.qualityReviewsRepo.create({
      turnId: parsed.data.turnId,
      reviewerId: session.user.id,
      verdict: parsed.data.verdict,
      note: parsed.data.note ?? null,
    });
    return respondResult(ok(row));
  } catch (e) {
    const code =
      (e as { code?: string })?.code ??
      (e as { cause?: { code?: string } })?.cause?.code ??
      (e as { cause?: { cause?: { code?: string } } })?.cause?.cause?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === '23503' || /violates foreign key/i.test(msg) || /23503/.test(msg)) {
      return respond(new ValidationError('Turn not found', { turnId: parsed.data.turnId }));
    }
    return respond(new ExternalServiceError('Failed to save quality review', e));
  }
}
