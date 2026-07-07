// Auth adapter factory. Dispatches to a concrete provider based on the
// AUTH_PROVIDER env var. Currently only `clerk` is implemented; the
// factory creates the seam for adding a future Auth.js adapter without
// touching route code.
import type { NextRequest, NextResponse } from 'next/server';
import type { clerkClient } from '@clerk/nextjs/server';
import { createClerkAdapter, type AppSessionFull } from './clerk-adapter';

export type AuthMiddleware = (req: NextRequest) => Promise<NextResponse>;

export interface AuthAdapter {
  middleware: AuthMiddleware;
  getAppSession: () => Promise<AppSessionFull | null>;
  requireAdmin: () => Promise<AppSessionFull>;
  requireSession: () => Promise<AppSessionFull>;
  clerkClient?: typeof clerkClient;
}

export function createAuthAdapter(): AuthAdapter {
  const provider = process.env.AUTH_PROVIDER ?? 'clerk';
  switch (provider) {
    case 'clerk':
      return createClerkAdapter();
    default:
      throw new Error(`Unknown AUTH_PROVIDER: ${provider}`);
  }
}
