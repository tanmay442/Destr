import {
  err,
  ok,
  type Result,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  sanitizeText,
  logger,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_STORED_MESSAGE_BYTES,
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_LIST_LIMIT,
} from '@app/domain';
import type { AuditLog, ChatHistoryRepo, ConversationSummary, StoredChatMessage } from '@app/domain';
import { capCodePoints } from '../text';
import { safeAudit } from '../audit-reliability';
import { sanitizePagination } from '../service-result';
import type { EmittedCitation } from './emit-citations';

export interface HistoryDeps {
  repo: ChatHistoryRepo;
}

type HistoryAuditDeps = Pick<AuditLog, 'logEvent' | 'recordDeadLetter'>;

const ALLOWED_PART_TYPES = new Set(['text', 'reasoning', 'file']);

export interface MessagePartLike {
  type?: unknown;
  [key: string]: unknown;
}

/** Guardrail snapshot stored on assistant messages; optional fields carry the §A4 degraded soft banner. */
export interface GuardrailMeta {
  outOfDomain: boolean;
  offerTicket: boolean;
  degraded?: boolean | undefined;
  message?: string | undefined;
  isEmpty?: boolean | undefined;
  resultState?: string | undefined;
}

/** Copy the optional degraded soft-banner fields when present and well-typed. */
function readGuardrailMeta(data: Record<string, unknown>): GuardrailMeta {
  const guardrail: GuardrailMeta = {
    outOfDomain: Boolean(data.outOfDomain),
    offerTicket: Boolean(data.offerTicket),
  };
  if (typeof data.degraded === 'boolean') guardrail.degraded = data.degraded;
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

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

function findLastTextIndex(parts: Array<Record<string, unknown>>): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]?.type === 'text') return i;
  }
  return -1;
}

const STORED_BYTES_TARGET = MAX_STORED_MESSAGE_BYTES - 1_024;

/** Truncate the last text part until the snapshot fits the storage byte cap. */
export function enforceStoredBytes(message: StoredMessage): StoredMessage {
  if (jsonBytes(message) <= STORED_BYTES_TARGET) return message;
  const clone: StoredMessage = { ...message, parts: message.parts.map((p) => ({ ...p })) };
  for (;;) {
    const idx = findLastTextIndex(clone.parts);
    if (idx === -1) break;
    const part = clone.parts[idx];
    if (!part) break;
    const text = typeof part.text === 'string' ? part.text : '';
    const chars = [...text];
    if (chars.length === 0) {
      clone.parts.splice(idx, 1);
      continue;
    }
    const bytesWithoutText = jsonBytes(clone) - Buffer.byteLength(text);
    const budget = STORED_BYTES_TARGET - bytesWithoutText - 16;
    if (budget <= 0) {
      clone.parts.splice(idx, 1);
      continue;
    }
    const bytesPerChar = Math.max(1, Math.ceil(Buffer.byteLength(text) / chars.length));
    part.text = capCodePoints(text, Math.floor(budget / bytesPerChar));
    if (jsonBytes(clone) <= STORED_BYTES_TARGET) break;
  }
  logger.warn('chat.history.stored_bytes_truncated', {
    bytes: jsonBytes(clone),
  });
  return clone;
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

export async function listConversations(
  input: { userId: string; limit?: number; offset?: number },
  deps: HistoryDeps,
): Promise<Result<{ conversations: ConversationSummary[]; total: number }>> {
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const [conversations, total] = await Promise.all([
      deps.repo.listConversations(input.userId, { limit, offset }),
      deps.repo.countConversations(input.userId),
    ]);
    return ok({ conversations, total });
  } catch (e) {
    return err(new ExternalServiceError('Failed to list conversations', e));
  }
}

export async function getConversation(
  input: { userId: string; conversationId: string },
  deps: HistoryDeps,
): Promise<Result<{ conversation: ConversationSummary; messages: StoredChatMessage[] }>> {
  try {
    const found = await deps.repo.getConversation(input.userId, input.conversationId);
    if (!found) return err(new NotFoundError('Conversation not found'));
    return ok(found);
  } catch (e) {
    return err(new ExternalServiceError('Failed to load conversation', e));
  }
}

export async function renameConversation(
  input: { userId: string; conversationId: string; title: string },
  deps: HistoryDeps,
): Promise<Result<{ ok: true }>> {
  try {
    const title = capCodePoints(sanitizeText(input.title), MAX_CONVERSATION_TITLE_LENGTH);
    const renamed = await deps.repo.renameConversation(input.userId, input.conversationId, title);
    if (!renamed) return err(new NotFoundError('Conversation not found'));
    return ok({ ok: true });
  } catch (e) {
    return err(new ExternalServiceError('Failed to rename conversation', e));
  }
}

export async function deleteConversation(
  input: { userId: string; conversationId: string },
  deps: HistoryDeps & { audit: HistoryAuditDeps },
): Promise<Result<{ ok: true }>> {
  try {
    const deleted = await deps.repo.deleteConversation(input.userId, input.conversationId);
    if (!deleted) return err(new NotFoundError('Conversation not found'));
    const event = {
      kind: 'chat' as const,
      action: 'conversation_deleted',
      actorId: input.userId,
      targetType: 'chat_conversation',
      targetId: input.conversationId,
      details: {},
    };
    await safeAudit(
      () => deps.audit.logEvent(event),
      (payload, error) => deps.audit.recordDeadLetter({ kind: 'chat', payload, error }),
      event,
      'chat',
    );
    return ok({ ok: true });
  } catch (e) {
    return err(new ExternalServiceError('Failed to delete conversation', e));
  }
}

export interface AppendChatTurnInputUseCase {
  userId: string;
  conversationId: string;
  turnId: string;
  retryOfMessageId?: string | undefined;
  /** Auto-title used only when this call creates the conversation. */
  title?: string | undefined;
  userMessage: unknown;
  assistantMessage: unknown;
  /** Known message count for the target conversation, when the caller has one. */
  messageCount?: number | undefined;
}

export async function appendChatTurn(
  input: AppendChatTurnInputUseCase,
  deps: HistoryDeps & { captureQueryText: boolean },
): Promise<Result<{ conversationId: string }>> {
  if (!deps.captureQueryText) return ok({ conversationId: input.conversationId });
  try {
    if (input.messageCount !== undefined && input.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
      return err(new ConflictError('This chat is full — start a new one'));
    }
    const title =
      input.title !== undefined
        ? capCodePoints(sanitizeText(input.title), MAX_CONVERSATION_TITLE_LENGTH)
        : '';
    const result = await deps.repo.appendTurn({
      conversationId: input.conversationId,
      userId: input.userId,
      turnId: input.turnId,
      retryOfMessageId: input.retryOfMessageId,
      title,
      userMessage: enforceStoredBytes(toStoredMessage(input.userMessage as MessageLike)),
      assistantMessage: enforceStoredBytes(toStoredMessage(input.assistantMessage as MessageLike)),
    });
    return ok(result);
  } catch (e) {
    if (e instanceof ConflictError) return err(e);
    return err(new ExternalServiceError('Failed to save chat history', e));
  }
}
