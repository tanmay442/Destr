import type { ConversationItem } from './types';

const RECENT_COUNT = 3;

/** UI-only split: the three most recently active chats, then everything else. */
export function sectionConversations(items: ConversationItem[]): Array<{ label: string; items: ConversationItem[] }> {
  const sections: Array<{ label: string; items: ConversationItem[] }> = [];
  const recent = items.slice(0, RECENT_COUNT);
  const rest = items.slice(RECENT_COUNT);
  if (recent.length > 0) sections.push({ label: 'Recent', items: recent });
  if (rest.length > 0) sections.push({ label: 'All chats', items: rest });
  return sections;
}

export function parseConversationId(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = /^\/chat\/([0-9a-fA-F-]{36})$/.exec(pathname);
  return match ? match[1]! : null;
}
