import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `output: 'standalone'` produces a self-contained server for the
  // Docker image. On Vercel it must be OFF — Next 16's standalone output
  // collapses every route into a single `index` function and Vercel's
  // edge stops routing dynamic paths (/chat, /admin/*, /api/*), returning
  // 404 for them. The Dockerfile sets DOCKER_BUILD=1 so only `docker
  // build` gets standalone; Vercel builds (no DOCKER_BUILD) use Vercel's
  // native per-route serverless output.
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  poweredByHeader: false,
  experimental: {
    // Limit request body size for server actions (replaces the spoofable
    // Content-Length header check the chat route previously relied on).
    serverActions: {
      bodySizeLimit: '4mb',
      // Explicit allowed origins for CSRF mitigation. Next.js checks
      // the Origin header against these for server-action requests.
      allowedOrigins: ['*'],
    },
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://vercel.live",
              "style-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev",
              "img-src 'self' https://img.clerk.com https://*.clerk.accounts.dev data: blob:",
              "font-src 'self' https://fonts.gstatic.com",
              "connect-src 'self' https://*.clerk.accounts.dev https://clerk.clerk.accounts.dev https://api.clerk.com https://api.openai.com https://generativelanguage.googleapis.com https://vercel.live",
              "frame-src 'self' https://*.clerk.accounts.dev https://accounts.google.com https://www.google.com https://vercel.live https://*.r2.cloudflarestorage.com",
              "form-action 'self' https://*.clerk.accounts.dev",
              "worker-src 'self' blob:",
              "child-src 'self' https://*.clerk.accounts.dev https://accounts.google.com",
              "object-src 'none'",
              "base-uri 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  // pdf-parse is now pinned to 1.1.1 (pure Node, no native
  // canvas / DOMMatrix dependency). Nothing to externalise.
  serverExternalPackages: [],
};

export default nextConfig;
