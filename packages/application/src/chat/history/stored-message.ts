import type { EmittedCitation } from '../emit-citations';

const ALLOWED_PART_TYPES = new Set(['text', 'reasoning', 'file']);

export interface MessagePartLike {
  type?: unknown;
  [key: string]: unknown;
}

export interface GuardrailMeta {
  outOfDomain: boolean;
  offerTicket: boolean;
  notice?: boolean | undefined;
  message?: string | undefined;
  isEmpty?: boolean | undefined;
  resultState?: string | undefined;
}

function readGuardrailMeta(data: Record<string, unknown>): GuardrailMeta {
  const guardrail: GuardrailMeta = {
    outOfDomain: Boolean(data.outOfDomain),
    offerTicket: Boolean(data.offerTicket),
  };
  if (typeof data.notice === 'boolean') guardrail.notice = data.notice;
  if (typeof data.message === 'string' && data.message !== '') guardrail.message = data.message;
  if (typeof data.isEmpty === 'boolean') guardrail.isEmpty = data.isEmpty;
  if (typeof data.resultState === 'string' && data.resultState !== '') {
    guardrail.resultState = data.resultState;
  }
  return guardrail;
}

export interface MessageLike {
  id?: string;
  role?: string;
  parts?: MessagePartLike[] | undefined;
  metadata?: unknown;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<Record<string, unknown>>;
  metadata: { citations?: unknown[]; guardrail?: GuardrailMeta };
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toStoredMessage(message: MessageLike): StoredMessage {
  const stored: StoredMessage = {
    id: typeof message.id === 'string' ? message.id : '',
    role: message.role === 'assistant' ? 'assistant' : 'user',
    parts: [],
    metadata: {},
  };

  const citations: unknown[] = [];
  let guardrail: StoredMessage['metadata']['guardrail'];

  for (const part of message.parts ?? []) {
    const type = typeof part?.type === 'string' ? part.type : '';
    if (ALLOWED_PART_TYPES.has(type)) {
      if (type === 'text') {
        stored.parts.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
      } else if (type === 'reasoning') {
        const copy: Record<string, unknown> = { type: 'reasoning' };
        if (typeof part.text === 'string') copy.text = part.text;
        stored.parts.push(copy);
      } else {
        const copy: Record<string, unknown> = {
          type: 'file',
          url: typeof part.url === 'string' ? part.url : '',
        };
        if (typeof part.filename === 'string') copy.filename = part.filename;
        if (typeof part.mediaType === 'string') copy.mediaType = part.mediaType;
        stored.parts.push(copy);
      }
      continue;
    }
    if (type === 'data-citation') {
      const data = plainObject(part.data);
      if (data) citations.push(data);
    } else if (type === 'data-guardrail') {
      const data = plainObject(part.data);
      if (data) guardrail = readGuardrailMeta(data);
    }
  }

  const meta = plainObject(message.metadata);
  if (meta) {
    if (Array.isArray(meta.citations)) citations.unshift(...meta.citations);
    if (!guardrail && plainObject(meta.guardrail)) {
      guardrail = readGuardrailMeta(plainObject(meta.guardrail)!);
    }
  }

  if (citations.length > 0) stored.metadata.citations = citations;
  if (guardrail) stored.metadata.guardrail = guardrail;
  return stored;
}

export function buildAssistantMessageLike(input: {
  turnId: string | null;
  text: string;
  citations: ReadonlyArray<EmittedCitation>;
  guardrail: GuardrailMeta | null;
}): MessageLike {
  const parts: MessagePartLike[] = [{ type: 'text', text: input.text }];
  for (const citation of input.citations) {
    parts.push({ type: 'data-citation', data: citation });
  }
  if (input.guardrail) {
    parts.push({ type: 'data-guardrail', data: input.guardrail });
  }
  return {
    id: `assistant-${input.turnId ?? 'unknown'}`,
    role: 'assistant',
    parts,
  };
}
