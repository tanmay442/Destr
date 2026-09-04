import type { MyUIMessage } from '../types';
import { isRecord, type ResolvedStoredContent } from './parts';

export function extractMetadataParts(content: ResolvedStoredContent): MyUIMessage['parts'] {
  const parts: MyUIMessage['parts'] = [];
  const metadata = isRecord(content.metadata) ? content.metadata : {};
  if (Array.isArray(metadata.citations)) {
    for (const citation of metadata.citations) {
      if (isRecord(citation)) {
        parts.push({
          type: 'data-citation',
          data: citation,
        } as unknown as MyUIMessage['parts'][number]);
      }
    }
  }
  if (isRecord(metadata.guardrail)) {
    const guardrail = metadata.guardrail;
    parts.push({
      type: 'data-guardrail',
      data: {
        outOfDomain: Boolean(guardrail.outOfDomain),
        offerTicket: Boolean(guardrail.offerTicket),
        ...(typeof guardrail.notice === 'boolean' ? { notice: guardrail.notice } : {}),
        ...(typeof guardrail.message === 'string' && guardrail.message !== ''
          ? { message: guardrail.message }
          : {}),
        ...(typeof guardrail.isEmpty === 'boolean' ? { isEmpty: guardrail.isEmpty } : {}),
        ...(typeof guardrail.resultState === 'string' && guardrail.resultState !== ''
          ? { resultState: guardrail.resultState }
          : {}),
      },
    } as unknown as MyUIMessage['parts'][number]);
  }
  return parts;
}
