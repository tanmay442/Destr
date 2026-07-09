// Auth adapter factory: dispatches to a provider based on AUTH_PROVIDER.
// Only `clerk` is implemented; the seam allows adding others later.
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
