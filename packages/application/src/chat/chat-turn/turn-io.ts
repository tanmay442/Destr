import {
  CHAT_MAX_BODY_BYTES,
  logger,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { MessageLike } from '../history';
import type { ChatTurnDeps } from './turn-types';

/** Best-effort history persistence; callers wait before closing a completed stream. */
export async function persistHistory(
  sink: ChatTurnDeps['historySink'],
  cfg: AppConfig,
  userId: string,
  input: {
    conversationId: string | undefined;
    turnId: string | null;
    retryOfMessageId?: string | undefined;
    title: string;
    userMessage: MessageLike | undefined;
    assistantMessage: MessageLike;
  },
): Promise<boolean> {
  if (!cfg.captureQueryText || !sink || !input.turnId || !input.userMessage) return false;
  if (!input.conversationId) {
    logger.debug('chat.history.persist_skipped', { turnId: input.turnId });
    return false;
  }
  try {
    await sink.appendTurn({
      userId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      retryOfMessageId: input.retryOfMessageId,
      title: input.title,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
    });
    return true;
  } catch (cause: unknown) {
    logger.error('chat.history.persist_failed', {
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: String(cause),
    });
    return false;
  }
}

async function readBoundedJson(request: Request): Promise<{ value: unknown; tooLarge: boolean }> {
  if (!request.body) return { value: null, tooLarge: false };
  const abortedBeforeRead = request.signal.aborted;
  const reader = request.body.getReader();
  const abortHandler = (): void => {
    reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', abortHandler, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (!abortedBeforeRead && request.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        return { value: null, tooLarge: false };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > CHAT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { value: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { value: null, tooLarge: false };
  } finally {
    request.signal.removeEventListener('abort', abortHandler);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
  } catch (e) {
    logger.debug('JSON parse failed', { error: String(e) });
    return { value: null, tooLarge: false };
  }
}

export { readBoundedJson };
