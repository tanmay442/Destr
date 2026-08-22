'use client';

const EVENT_NAME = 'destr:conversations-changed';
const NEW_CHAT_EVENT = 'destr:new-chat-requested';

/** Fire after a conversation is created, renamed, deleted, or gains its first turn. */
export function notifyConversationsChanged(activeConversationId?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: activeConversationId ?? null }));
}

export function onConversationsChanged(callback: (activeConversationId?: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<string | null>).detail;
    callback(typeof detail === 'string' && detail !== '' ? detail : undefined);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

export function requestNewChat(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT));
}

export function onNewChatRequested(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(NEW_CHAT_EVENT, callback);
  return () => window.removeEventListener(NEW_CHAT_EVENT, callback);
}
