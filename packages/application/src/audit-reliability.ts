type AuditKind = 'document' | 'ticket' | 'user';

/**
 * Write an audit event without blocking the calling operation. The primary
 * write is awaited; if it throws, the failure is captured to the audit
 * dead-letter store (for compliance replay) instead of being silently lost.
 * The dead-letter write's own failure is swallowed so a logging outage can
 * never fail the request.
 */
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
