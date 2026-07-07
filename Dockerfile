# Stage 1: Build
# Install layer is cached: package.json + lockfile copied before source,
# so `pnpm install` only re-runs when deps change. `pnpm next build` is
# used (not `pnpm build`) because the `pnpm build` script also runs
# `scripts/migrate.ts`, which needs a live DATABASE_URL — not available
# during an image build. For non-Vercel deploys, run migrations
# separately against the production DB (e.g. a one-off `pnpm db:migrate`
# job from a build-stage image).
FROM node:20-slim AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/application/package.json ./packages/application/
COPY packages/domain/package.json ./packages/domain/
COPY packages/infrastructure/package.json ./packages/infrastructure/
COPY packages/cli/package.json ./packages/cli/
COPY tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=1
RUN pnpm next build

# Stage 2: Runtime
FROM node:20-slim AS runner
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
CMD ["node", "server.js"]
