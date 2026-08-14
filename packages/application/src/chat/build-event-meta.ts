export interface EventMetaInput {
  rewritten?: boolean | undefined;
  documentIds?: number[] | undefined;
  ticketId?: string | null | undefined;
}

export function buildEventMeta(input: EventMetaInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.rewritten) meta.rewritten = true;
  if (input.documentIds && input.documentIds.length > 0) {
    meta.documentIds = [...new Set(input.documentIds.filter((id) => typeof id === 'number' && id > 0))];
  }
  if (input.ticketId) meta.ticketId = input.ticketId;
  return meta;
}
