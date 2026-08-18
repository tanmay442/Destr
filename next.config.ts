import type { NextConfig } from "next";
import { MAX_UPLOAD_PDF_BYTES } from "./src/lib/limits";

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

// Derive the Clerk proxy origin. When Clerk runs behind a custom proxy domain
// (CLERK_PROXY_URL / NEXT_PUBLIC_CLERK_PROXY_URL), that origin serves the JS
// bundle, all frontend API calls, and the sign-in/up iframes, so every CSP
// directive that lists Clerk hosts must include it.
//
// Fallback: when no proxy is registered (local dev, Clerk dev mode, Docker
// builds — `.dockerignore` keeps `.env*` out of the image — or a free domain
// without a registered Clerk proxy), the vars are unset and the CSP stays
// exactly as before, allowing only the default Clerk frontend API domain
// https://*.clerk.accounts.dev. Same-image deploys switch modes by setting
// CLERK_PROXY_URL at container runtime; it is read from the server process
// env, not baked into the bundle.
function resolveClerkProxyOrigins(): string[] {
  const origins = new Set<string>();
  for (const raw of [
    process.env.CLERK_PROXY_URL,
    process.env.NEXT_PUBLIC_CLERK_PROXY_URL,
  ]) {
    if (raw) {
      try {
        origins.add(new URL(raw).origin);
      } catch {
        /* ignore malformed URLs */
      }
    }
  }
  return [...origins];
}

const clerkProxyOrigins = resolveClerkProxyOrigins();
const clerkProxySrc = clerkProxyOrigins.join(' ');

// Clerk's account portal on a custom domain lives on `accounts.<host>`
// (proxy clerk.destr.dpdns.org → accounts.destr.dpdns.org). Only relevant
// when a proxy domain is registered; in dev/fallback mode the account portal
// is already covered by https://*.clerk.accounts.dev.
const clerkAccountsSrc = clerkProxyOrigins
  .map((origin) => {
    const url = new URL(origin);
    if (url.hostname.startsWith('clerk.')) {
      url.hostname = `accounts.${url.hostname.slice('clerk.'.length)}`;
      return url.origin;
    }
    return null;
  })
  .filter((o): o is string => o !== null)
  .join(' ');

// Append the Clerk proxy origin to any CSP directive that lists Clerk hosts.
const withClerkProxy = (directive: string) =>
  clerkProxySrc ? `${directive} ${clerkProxySrc}` : directive;

// frame-src needs both the proxy (sign-in iframes) and the account portal.
const withClerkFrameSrc = (directive: string) => {
  const origins = [clerkProxySrc, clerkAccountsSrc].filter(Boolean);
  return origins.length ? `${directive} ${origins.join(' ')}` : directive;
};

const nextConfig: NextConfig = {
  // standalone only for Docker; Vercel's standalone breaks dynamic route routing (404s)
  ...(process.env.DOCKER_BUILD === '1' ? { output: 'standalone' as const } : {}),
  poweredByHeader: false,
  experimental: {
    serverActions: {
      bodySizeLimit: `${MAX_UPLOAD_PDF_BYTES / (1024 * 1024)}mb`,
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
              withClerkProxy("script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://challenges.cloudflare.com https://vercel.live"),
              withClerkProxy("style-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev"),
              withClerkProxy("img-src 'self' https://img.clerk.com https://*.clerk.accounts.dev data: blob:"),
              "font-src 'self' https://fonts.gstatic.com",
              withClerkProxy("connect-src 'self' https://*.clerk.services https://*.clerk.accounts.dev https://clerk.clerk.accounts.dev https://api.clerk.com https://challenges.cloudflare.com https://api.openai.com https://generativelanguage.googleapis.com https://vercel.live"),
              withClerkFrameSrc("frame-src 'self' https://*.clerk.accounts.dev https://accounts.google.com https://www.google.com https://challenges.cloudflare.com https://vercel.live https://*.r2.cloudflarestorage.com"),
              withClerkProxy("form-action 'self' https://*.clerk.accounts.dev"),
              "worker-src 'self' blob:",
              withClerkProxy("child-src 'self' https://*.clerk.accounts.dev https://accounts.google.com"),
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
  serverExternalPackages: ['unpdf', 'pdfjs-dist', '@xenova/transformers', 'onnxruntime-node'],
};

export default nextConfig;
