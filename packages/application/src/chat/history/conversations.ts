import {
  err,
  ok,
  type Result,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  sanitizeText,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_LIST_LIMIT,
} from '@app/domain';
import type { AuditLog, ChatHistoryRepo, ConversationSummary, StoredChatMessage } from '@app/domain';
import { capCodePoints } from '../../text';
import { safeAudit } from '../../audit-reliability';
import { sanitizePagination } from '../../service-result';
import { toStoredMessage, type MessageLike } from './stored-message';
import { enforceStoredBytes } from './stored-bytes';

export interface HistoryDeps {
  repo: ChatHistoryRepo;
}

type HistoryAuditDeps = Pick<AuditLog, 'logEvent' | 'recordDeadLetter'>;

export async function listConversations(
  input: { userId: string; limit?: number; offset?: number },
  deps: HistoryDeps,
): Promise<Result<{ conversations: ConversationSummary[]; total: number }>> {
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    // Sequential to avoid list/count race causing pagination mismatch; UI redirects to last page correctly regardless.
    // Ideally use COUNT(*) OVER() in a single query or a snapshot transaction.
    const conversations = await deps.repo.listConversations(input.userId, { limit, offset });
    const total = await deps.repo.countConversations(input.userId);
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
