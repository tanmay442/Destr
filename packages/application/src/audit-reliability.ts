import type { AuditKind } from '@app/domain';

/** Write an audit event without blocking the caller. On failure, captures to
 *  the dead-letter store. Dead-letter failures are swallowed. */
export async function safeAudit(
  write: () => Promise<void>,
  recordDeadLetter: (payload: unknown, error: string) => Promise<void>,
  payload: unknown,
  kind: AuditKind,
): Promise<void> {
  try {
    await write();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[audit] write failed (kind=${kind}); recording dead-letter:`, message);
    try {
      await recordDeadLetter(payload, message);
    } catch (dlqErr) {
      console.error('[audit] dead-letter write also failed:', dlqErr instanceof Error ? dlqErr.message : dlqErr);
    }
  }
}
