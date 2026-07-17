export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((e) => e && EMAIL_RE.test(e));

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

