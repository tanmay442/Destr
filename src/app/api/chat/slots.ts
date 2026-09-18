import type { AnswerCache, LeaseHandle } from '@app/domain';

export function positiveIntEnv(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const CHAT_MAX_CONCURRENT = 2;
const chatSlotCounts = new Map<string, number>();
export const chatSlotOwners = new WeakMap<Request, string>();

/**
 * Distributed per-user turn slots (WP-8 F-35).
 *
 * The process-local map above remains only as a fast-path optimization.
 * Correctness across Fluid instances comes from these distributed leases:
 * one of `CHAT_DISTRIBUTED_SLOTS_PER_USER` Redis-backed slot keys per user,
 * each with an ownership handle, TTL expiry/recovery, and exactly-once
 * release. Flag-gated (`WP8_DISTRIBUTED_ADMISSION_ENABLED`); when the
 * coordinator is absent, non-distributed, or errors, acquisition reports
 * `unavailable` and the caller keeps the local fast-path decision while
 * logging the degradation (see handler).
 */
export const CHAT_DISTRIBUTED_SLOTS_PER_USER = 2;
export const CHAT_DISTRIBUTED_SLOT_TTL_SEC = 65;

const distributedSlotOwners = new WeakMap<Request, LeaseHandle>();

export function isDistributedAdmissionEnabled(): boolean {
  const raw = (process.env.WP8_DISTRIBUTED_ADMISSION_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function distributedSlotKey(userId: string, slot: number): string {
  return `rag:turn-slot:${encodeURIComponent(userId)}:${slot}`;
}

export type DistributedSlotOutcome =
  | { readonly kind: 'acquired'; readonly handle: LeaseHandle; readonly slot: number }
  | { readonly kind: 'held' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export async function acquireDistributedChatSlot(
  cache: AnswerCache | undefined,
  userId: string,
): Promise<DistributedSlotOutcome> {
  const coordination = cache?.coordination;
  if (!coordination) return { kind: 'unavailable', reason: 'no_coordinator' };
  if (coordination.scope !== 'distributed') return { kind: 'unavailable', reason: 'local_scope' };
  for (let slot = 0; slot < CHAT_DISTRIBUTED_SLOTS_PER_USER; slot += 1) {
    let acquired: Awaited<ReturnType<typeof coordination.acquire>>;
    try {
      acquired = await coordination.acquire(
        distributedSlotKey(userId, slot),
        CHAT_DISTRIBUTED_SLOT_TTL_SEC,
      );
    } catch {
      return { kind: 'unavailable', reason: 'coordinator_error' };
    }
    if (acquired.kind === 'acquired') return { kind: 'acquired', handle: acquired.handle, slot };
    if (acquired.kind === 'unavailable') return { kind: 'unavailable', reason: 'coordinator_unavailable' };
  }
  return { kind: 'held' };
}

export function trackDistributedSlot(req: Request, handle: LeaseHandle): void {
  distributedSlotOwners.set(req, handle);
}

export async function releaseDistributedSlot(req: Request): Promise<void> {
  const handle = distributedSlotOwners.get(req);
  if (!handle) return;
  distributedSlotOwners.delete(req);
  try {
    await handle.release();
  } catch {
    // Release is best-effort; TTL expiry recovers the slot.
  }
}

export function acquireChatSlot(userId: string): boolean {
  const current = chatSlotCounts.get(userId) ?? 0;
  if (current >= CHAT_MAX_CONCURRENT) return false;
  chatSlotCounts.set(userId, current + 1);
  return true;
}

function releaseChatSlot(userId: string): void {
  const current = chatSlotCounts.get(userId) ?? 1;
  if (current <= 1) chatSlotCounts.delete(userId);
  else chatSlotCounts.set(userId, current - 1);
}

export function releaseOwnedChatSlot(req: Request, userId: string): void {
  if (chatSlotOwners.get(req) !== userId) return;
  chatSlotOwners.delete(req);
  releaseChatSlot(userId);
}

export function releaseSlotWhenStreamEnds<T extends Response>(res: T, release: () => void): T {
  const body = res.body;
  if (!body) {
    release();
    return res;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
  };
  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = body.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              controller.enqueue(value);
            } catch {
              finish();
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
          finish();
          controller.close();
        } catch {
          finish();
          try {
            controller.error(new Error('Chat stream interrupted'));
          } catch {
          }
        }
      })();
    },
    cancel() {
      finish();
    },
  });
  return new Response(tracked, { status: res.status, statusText: res.statusText, headers: res.headers }) as T;
}
