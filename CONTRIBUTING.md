# Contributing to Destr

Thank you for your interest in contributing to Destr, a RAG knowledge agent. We welcome contributions that align with our architecture, code quality, and testing standards.

Please take a moment to review these guidelines before submitting code.

---

## 1. Feature Requests & Proposal Process

- **Open an Issue First**: Before working on any new feature, significant refactor, or architectural change, please **open a GitHub Issue** to discuss your proposal.
- **Why?**: Opening an issue ensures your idea aligns with the project roadmap, architectural goals, and security boundaries before you spend time writing code.
- **Bug Fixes & Docs**: For minor bug fixes, typo corrections, or documentation updates, feel free to open a PR directly.

---

## 2. Codebase Architecture & Guidelines

Our codebase uses a **4-layer monorepo structure** (Clean Architecture) under `packages/`:

```
packages/
├── domain/         # @app/domain — Pure types, domain errors, Result<T,E>, port interfaces
├── application/    # @app/application — Pure business use-cases returning Result<T, DomainError>
├── infrastructure/ # @app/infrastructure — Drizzle ORM repos, AI SDK adapters, auth, PDF parsers
├── cli/            # @app/cli — CLI setup, seed, migration tools
```

### Architectural Layer Rules (Enforced by `pnpm arch`)
1. **Domain (`@app/domain`)**: Pure logic, Zod schemas, and interfaces only. No external runtime dependencies (no Next.js, Drizzle, AI SDK, or Node built-ins).
2. **Application (`@app/application`)**: Pure use-cases. May only import `@app/domain`. Cannot import infrastructure, Next.js, or UI.
3. **Infrastructure (`@app/infrastructure`)**: Implements domain ports (DB, LLMs, Storage, Queue). May only import `@app/domain`. Cannot import application or UI.
4. **App Shell (`src/`)**: Next.js App Router. Imports use-cases and UI components. Adapter instantiation is isolated in `src/composition.ts`.

---

## 3. Local Verification & CI Quality Gates

Before opening or updating a Pull Request, use the quick local check command to validate your changes.

Run the quick local check:

```bash
# Run tests, TypeScript typecheck, ESLint, and dependency architecture check
pnpm gate

# Run the production build when it is relevant to your change
pnpm gate:build
```

### Verification Checklist
- [ ] `pnpm test` — All unit, integration, and contract tests pass.
- [ ] `pnpm typecheck` — Zero TypeScript compilation errors (`tsc --noEmit`).
- [ ] `pnpm lint` — Zero ESLint warnings or errors.
- [ ] `pnpm arch` — Zero dependency boundary violations (`dependency-cruiser`).
- [ ] `pnpm build` — Production build succeeds cleanly when applicable.

CI runs the checks independently and performs the production build on every workflow run.

---

## 4. Testing Requirements

- **Unit & Integration Tests**: Every new use-case or helper must include corresponding Vitest tests.
- **Contract Tests**: If you add or modify a multi-implementation port (such as `BlobStorage`, `RateLimiter`, `AnswerCache`, `IngestQueue`, `EmbeddingService`, or `Reranker`), you **must** update or add contract tests under `packages/infrastructure/src/<module>/__tests__/contracts/`.
- **No Mocking Swallows**: Tests must assert genuine failure and success contracts. Do not swallow errors or add dummy fallbacks to force tests to pass.

---

## 5. Pull Request Standards

- **Verified / Signed Commits**: Pull Requests with GPG/SSH signed commits (`git commit -S`) are preferred.
- **Clear Commit Messages**: Use conventional commit prefixes (e.g. `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Self-Contained Changes**: Keep PRs focused on a single feature or bug fix. Avoid sprawling PRs that mix unrelated changes.
- **Clean Git History**: Rebase against the target branch (`master`) and eliminate fixup/merge commits before requesting review.

---

## 6. Development Workflow

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/your-username/rag_agent.git
   cd rag_agent
   ```
2. Start the local database and install dependencies:
   ```bash
   docker compose up -d db
   pnpm install
   pnpm db:push
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feat/my-new-feature
   ```
4. Make your changes and run verification:
   ```bash
   pnpm gate
   ```
5. Commit and open your PR!
