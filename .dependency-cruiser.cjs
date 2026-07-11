/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---- DOMAIN: pure types + zod, no I/O, no node APIs ----
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
        path: 'node_modules/(drizzle-orm|@ai-sdk|@clerk|next|pdf-lib|pg|@neondatabase|drizzle-kit|ai|unpdf/)',
      },
    },
    {
      name: 'no-domain-importing-node-builtins',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { path: '^node:' },
    },

    // ---- APPLICATION: depends on Domain only, not Infrastructure ----
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
        path: 'node_modules/(drizzle-orm|@ai-sdk|@clerk|next|pdf-lib|pg|@neondatabase|drizzle-kit|unpdf/)',
      },
    },
    {
      name: 'no-application-importing-src-lib',
      severity: 'error',
      from: { path: '^packages/(application|cli)' },
      to: { path: '^src/lib' },
    },

    // ---- INFRASTRUCTURE: no Next, no src/app ----
    {
      name: 'no-infrastructure-importing-app',
      severity: 'error',
      from: { path: '^packages/infrastructure' },
      to: { path: '^src/(app|components|lib)' },
    },
    {
      name: 'no-infrastructure-importing-next',
      severity: 'error',
      from: { path: '^packages/infrastructure' },
      to: {
        dependencyTypes: ['npm'],
        path: 'node_modules/next/',
      },
    },

    // ---- CLI: cannot import from src/app|components ----
    {
      name: 'cli-cannot-import-app-src',
      severity: 'error',
      from: { path: '^packages/cli' },
      to: { path: '^src/(app|components)' },
    },

    // ---- SRC APP/COMPONENTS: no direct infra or data layers ----
    {
      name: 'no-src-app-importing-infrastructure',
      severity: 'error',
      from: { path: '^src/(app|components)' },
      to: { path: '^packages/infrastructure' },
    },
    {
      name: 'no-src-app-importing-data-packages',
      severity: 'error',
      from: { path: '^src/(app|components)' },
      to: {
        dependencyTypes: ['npm'],
        path: 'node_modules/(drizzle-orm|pg|unpdf|@neondatabase|pdf-lib/)/',
      },
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
