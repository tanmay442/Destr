# Stage 1: Build
# `pnpm next build` is used (not `pnpm build`) because the `pnpm build`
# script also runs `scripts/migrate.ts`, which needs a live DATABASE_URL —
# not available during an image build. Migrations run via the gated
# GitHub Actions deploy job (MIGRATION_DATABASE_URL). NEXT_PUBLIC_* build
# args must be passed explicitly via --build-arg; they stay empty otherwise.
FROM node:22.23.2-slim AS builder
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/application/package.json ./packages/application/
COPY packages/domain/package.json ./packages/domain/
COPY packages/infrastructure/package.json ./packages/infrastructure/
COPY packages/cli/package.json ./packages/cli/
COPY tsconfig.base.json ./
# The local reranker (`RERANKER_PROVIDER=local`) needs the optional
# @xenova/transformers package. It is installed by the line below; keep
# --no-optional off, and in the runtime stage make TRANSFORMERS_CACHE a
# writable path if you use it.
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=1
ENV SKIP_ENV_VALIDATION=1
RUN pnpm next build

# Stage 2: Runtime
FROM node:22.23.2-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]