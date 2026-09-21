import { assertSameOrigin } from '@/composition';
import { isRequestCancellationError } from '@app/domain';
import { logger } from '@/lib/logger';
import { respond } from '@/lib/http';
import {
  CHAT_ROUTE_MAX_DURATION_SECS,
  ROUTE_ENVELOPE_CURRENT_60,
  assertRouteEnvelopeValid,
} from '@app/application/runtime/route-envelope';
import { releaseAdmissionForRequest } from '@/admission';
import { streamChatResponseUseCase } from './handler';

export const maxDuration = 60;

// Build-time consistency: the Vercel route envelope must match the
// deployment-owned constant, and the application hard stop must stay
// strictly below the platform limit with the mandatory reserve intact.
// WP-8 decision: keep 60s (see docs/runtime/route-duration-decision.md).
assertRouteEnvelopeValid(ROUTE_ENVELOPE_CURRENT_60);
if (maxDuration !== CHAT_ROUTE_MAX_DURATION_SECS) {
  throw new Error(
    `chat route maxDuration (${maxDuration}s) must match CHAT_ROUTE_MAX_DURATION_SECS (${CHAT_ROUTE_MAX_DURATION_SECS}s)`,
  );
}

export async function POST(req: Request) {
  try {
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;
    // Await (not bare return) so async failures inside the use case land in
    // this catch: the admission lease is released instead of leaking until
    // the controller TTL, and the error becomes a shaped response.
    return await streamChatResponseUseCase(req);
  } catch (error) {
    // WP-9 workstream C: the admission lease is request-keyed. Release it
    // exactly-once on the unhandled-error path (null when admission never
    // completed, e.g. CSRF rejections). The controller release is
    // idempotent; a held Redis slot handle is handed back best-effort with
    // TTL expiry as the recovery net.
    releaseAdmissionForRequest(req, 'error');
    if (req.signal.aborted && isRequestCancellationError(error)) return new Response(null, { status: 499 });
    logger.error('Chat request failed', { error: String(error) });
    return respond(error);
  }
}
