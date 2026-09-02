import { validateChatFileUrl } from '@app/application/chat';

export function isAllowedUrl(url: string): boolean {
  return validateChatFileUrl({ url }).kind === 'valid';
}
