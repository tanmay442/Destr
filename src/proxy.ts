import type { NextRequest, NextResponse } from 'next/server';
import { createAuthAdapter } from '@app/infrastructure/auth';

const adapter = createAuthAdapter();

const middleware: (req: NextRequest) => Promise<NextResponse> = adapter.middleware;
export default middleware;

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
