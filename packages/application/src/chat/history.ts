import {
  err,
  ok,
  type Result,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  sanitizeText,
  logger,
  MAX_CONVERSATIONS_PER_USER,
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
  metadata: { citations?: unknown[]; guardrail?: { outOfDomain: boolean; offerTicket: boolean } };
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
      if (data) guardrail = { outOfDomain: Boolean(data.outOfDomain), offerTicket: Boolean(data.offerTicket) };
    }
  }

  const meta = plainObject(message.metadata);
  if (meta) {
    if (Array.isArray(meta.citations)) citations.unshift(...meta.citations);
    if (!guardrail && plainObject(meta.guardrail)) {
      const g = plainObject(meta.guardrail)!;
      guardrail = { outOfDomain: Boolean(g.outOfDomain), offerTicket: Boolean(g.offerTicket) };
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

/** Truncate the last text part until the snapshot fits the storage byte cap. */
export function enforceStoredBytes(message: StoredMessage): StoredMessage {
  if (jsonBytes(message) <= MAX_STORED_MESSAGE_BYTES) return message;
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
    const budget = MAX_STORED_MESSAGE_BYTES - bytesWithoutText - 16;
    if (budget <= 0) {
      clone.parts.splice(idx, 1);
      continue;
    }
    const bytesPerChar = Math.max(1, Math.ceil(Buffer.byteLength(text) / chars.length));
    part.text = capCodePoints(text, Math.floor(budget / bytesPerChar));
    if (jsonBytes(clone) <= MAX_STORED_MESSAGE_BYTES) break;
  }
  logger.warn('[chat-history] stored message exceeded byte cap; truncated last text part', {
    bytes: jsonBytes(clone),
  });
  return clone;
}

export function buildAssistantMessageLike(input: {
  turnId: string | null;
  text: string;
  citations: ReadonlyArray<EmittedCitation>;
  guardrail: { outOfDomain: boolean; offerTicket: boolean } | null;
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
): Promise<Result<{ conversations: ConversationSummary[] }>> {
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const conversations = await deps.repo.listConversations(input.userId, { limit, offset });
    return ok({ conversations });
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
  conversationId: string | null;
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
  deps: HistoryDeps,
): Promise<Result<{ conversationId: string }>> {
  try {
    if (input.messageCount !== undefined && input.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
      return err(new ConflictError('This chat is full — start a new one'));
    }
    if (input.conversationId === null) {
      const total = await deps.repo.countConversations(input.userId);
      if (total >= MAX_CONVERSATIONS_PER_USER) {
        return err(new ConflictError('Conversation limit reached'));
      }
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
    return err(new ExternalServiceError('Failed to save chat history', e));
  }
}
