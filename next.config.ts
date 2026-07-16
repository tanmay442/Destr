import type { NextConfig } from "next";

// Derive the set of origins permitted to call Server Actions. Next's default
// (omitted) already whitelists the same-origin host, which is the safe choice.
// When the app is served from a known external origin (custom domain / Vercel),
// derive it from NEXT_PUBLIC_APP_URL / VERCEL_URL. A wildcard ('*') would
// disable Next's Origin-check CSRF mitigation, so we never use it.
function resolveServerActionOrigins(): string[] {
  const origins = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      /* ignore malformed URLs */
    }
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    origins.add(`https://${vercelUrl.replace(/^https?:\/\//, "")}`);
  }
  return [...origins];
}

const serverActionOrigins = resolveServerActionOrigins();

const nextConfig: NextConfig = {
  // standalone only for Docker; Vercel's standalone breaks dynamic route routing (404s)
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  poweredByHeader: false,
  experimental: {
    // limit server-action body size
    serverActions: {
      bodySizeLimit: '4mb',
      // allowed origins for CSRF mitigation; omit when none derived so the
      // default same-origin check applies (safe for local dev).
      ...(serverActionOrigins.length ? { allowedOrigins: serverActionOrigins } : {}),
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
  // unpdf pulls in pdfjs-dist (ESM worker code) — keep it external to the
  // Next server bundle so it isn't mis-transformed at build time.
  serverExternalPackages: ['unpdf', 'pdfjs-dist', '@xenova/transformers', 'onnxruntime-node', 'sharp'],
};

export default nextConfig;
