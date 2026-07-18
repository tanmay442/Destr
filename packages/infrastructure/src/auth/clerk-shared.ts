export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((e) => e && EMAIL_RE.test(e));

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

export interface ClerkEmailAddress {
  emailAddress?: string;
  verification?: { status?: string } | Array<{ status?: string }> | null;
}

function emailVerified(email: ClerkEmailAddress | undefined): boolean {
  if (!email) return false;
  const v = email.verification;
  if (Array.isArray(v)) return v.some((x) => x?.status === 'verified');
  return v?.status === 'verified';
}

export function isVerifiedAdminEmail(
  emailAddresses: ClerkEmailAddress[] | undefined,
): string | null {
  if (!emailAddresses) return null;
  for (const e of emailAddresses) {
    if (e.emailAddress && emailVerified(e) && isAdminEmail(e.emailAddress)) {
      return e.emailAddress;
    }
  }
  return null;
}

