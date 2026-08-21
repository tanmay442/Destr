'use client';

const EVENT_NAME = 'destr:conversations-changed';

/** Fire after a conversation is created, renamed, deleted, or gains its first turn. */
export function notifyConversationsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function onConversationsChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT_NAME, callback);
  return () => window.removeEventListener(EVENT_NAME, callback);
}
