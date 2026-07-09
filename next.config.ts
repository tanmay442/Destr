import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone only for Docker; Vercel's standalone breaks dynamic route routing (404s)
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  poweredByHeader: false,
  experimental: {
    // limit server-action body size
    serverActions: {
      bodySizeLimit: '4mb',
      // allowed origins for CSRF mitigation
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
  // pdf-parse pinned to pure-Node 1.1.1; nothing to externalise
  serverExternalPackages: [],
};

export default nextConfig;
