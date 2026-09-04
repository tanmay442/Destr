/** @type {import('dependency-cruiser').IConfiguration} */
const BANNED_PACKAGES =
  'node_modules/(drizzle-orm|@ai-sdk|@clerk|next|pdf-lib|pg|@neondatabase|drizzle-kit|unpdf|ai|@upstash/qstash|@upstash/redis|@xenova/transformers|onnxruntime-node)/';

module.exports = {
  forbidden: [
    {
      name: 'no-domain-importing-other-packages',
      severity: 'error',
      comment: 'Domain is pure: it may only depend on zod.',
      from: { path: '^packages/domain' },
      to: { path: '^packages/(application|infrastructure|cli)' },
    },
    {
      name: 'no-domain-importing-src',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { path: '^src/(app|components)' },
    },
    {
      name: 'no-domain-importing-banned-packages',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: {
        dependencyTypes: ['npm'],
        path: BANNED_PACKAGES,
      },
    },
    {
      name: 'no-domain-importing-node-builtins',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { path: '^node:' },
    },

    {
      name: 'no-application-importing-infrastructure',
      severity: 'error',
      from: { path: '^packages/application' },
      to: { path: '^packages/infrastructure' },
    },
    {
      name: 'no-application-importing-src',
      severity: 'error',
      from: { path: '^packages/application' },
      to: { path: '^src/(app|components)' },
    },
    {
      name: 'no-application-importing-banned-packages',
      severity: 'error',
      from: { path: '^packages/application' },
      to: {
        dependencyTypes: ['npm'],
        path: BANNED_PACKAGES,
      },
    },
    {
      name: 'no-application-importing-src-lib',
      severity: 'error',
      from: { path: '^packages/(application|cli)' },
      to: { path: '^src/lib' },
    },

    {
      name: 'no-infrastructure-importing-app',
      severity: 'error',
      from: { path: '^packages/infrastructure' },
      to: { path: '^src/(app|components|lib)' },
    },
    {
      name: 'no-infrastructure-importing-next',
      severity: 'error',
      comment: 'Clerk adapters are vendor-locked in this program (see MODULARITY_IMPROVEMENT_PLAN §10).',
      from: {
        path: '^packages/infrastructure',
        // Sanctioned by MODULARITY_IMPROVEMENT_PLAN.md §10 — Clerk is
        // vendor-locked in this program. Auth portability is deferred to a
        // future plan, so these four adapter files may import next/*.
        pathNot: '^packages/infrastructure/src/auth/(auth-factory|clerk-adapter|clerk-session|clerk-shared)\\.ts$',
      },
      to: { path: 'node_modules/next/' },
    },
    {
      name: 'no-infrastructure-importing-application',
      severity: 'error',
      from: { path: '^packages/infrastructure' },
      to: { path: '^packages/application' },
    },

    {
      name: 'cli-cannot-import-app-src',
      severity: 'error',
      from: { path: '^packages/cli' },
      to: { path: '^src/(app|components)' },
    },

    {
      name: 'no-src-app-importing-infrastructure',
      severity: 'error',
      from: { path: '^src/(?!composition\.ts$|composition/|proxy\.ts$|__tests__/|.*\.test\.[jt]sx?$)' },
      to: { path: '^packages/infrastructure' },
    },
    {
      name: 'no-src-app-importing-data-packages',
      severity: 'error',
      from: { path: '^src/(?!composition\.ts$|composition/|proxy\.ts$|__tests__/|.*\.test\.[jt]sx?$)' },
      to: {
        dependencyTypes: ['npm'],
        path: 'node_modules/(drizzle-orm|pg|unpdf|@neondatabase|pdf-lib/)/',
      },
    },
    {
      name: 'no-scripts-importing-src',
      severity: 'error',
      from: { path: '^scripts' },
      to: { path: '^src' },
    },

  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
