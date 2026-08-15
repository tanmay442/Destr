import type { AuditKind } from '@app/domain';

export const PAGE_SIZE = 30;

export const ADMIN_KINDS: readonly AuditKind[] = ['document', 'ticket', 'user', 'settings'];

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'closed':
      return 'border-success/40 text-success';
    case 'in_progress':
      return 'border-warning/40 text-warning';
    case 'created':
    default:
      return 'border-primary/40 text-primary';
  }
}

export function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
