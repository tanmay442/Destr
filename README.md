<p align="center">
  <img src="public/logo.svg" alt="RAG Knowledge Agent" width="96" height="96">
</p>

<h1 align="center">RAG Knowledge Agent</h1>

<p align="center">
  Production-ready, modular AI knowledge agent built with Next.js 16, Vercel AI SDK v6, Drizzle ORM, and Neon Postgres with pgvector.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#system-architecture">Architecture</a> •
  <a href="#quality-gates--verification">Quality Gates</a> •
  <a href="#admin-console--features">Admin Console</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Overview

**RAG Knowledge Agent** is a full-stack, enterprise-grade Retrieval-Augmented Generation system. It features tool-calling chat, hybrid vector + lexical search, grounded citation tracking, agentic retrieval fallback, and administrative analytics.

Built on a **4-Layer Clean Architecture** monorepo, all business use-cases, domain models, and infrastructure ports are strictly decoupled and validated through single-command quality gates.

---

## Quick Start

### 1. Clone & Start Local Database
```bash
git clone https://github.com/tanmay442/rag_agent.git
cd rag_agent

# Start local Postgres + pgvector container
docker compose up -d db
pnpm install
```

### 2. Configure Environment
Copy `.env.example` to `.env.local` and add your Clerk credentials:
```bash
cp .env.example .env.local
```

### 3. Initialize & Run
```bash
# Push database schema & start development server
pnpm db:push
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000). The default setup boots against local Docker Postgres and Ollama with zero external LLM API keys required.

---

## System Architecture

The project is structured into a 4-layer monorepo inside `packages/`:

```
rag_agent/
├── packages/
│   ├── domain/         # @app/domain — Pure types, Zod schemas, Result<T,E>, port interfaces
│   ├── application/    # @app/application — Business use-cases returning Result<T, DomainError>
│   ├── infrastructure/ # @app/infrastructure — Drizzle ORM repos, AI SDK adapters, PDF parsers
│   └── cli/            # @app/cli — `rag-agent` management CLI (init, setup, seed, db-migrate)
└── src/                # Next.js App Router shell, UI components, and composition root
```

### Architecture Layer Rules
- **Domain (`@app/domain`)**: Zero runtime dependencies. Defines business schemas and port contracts.
- **Application (`@app/application`)**: Pure use-case functions. Depends only on `@app/domain`.
- **Infrastructure (`@app/infrastructure`)**: Implements database repositories, storage, LLM services, and queue ports.
- **Composition Root (`src/composition.ts`)**: Single dependency injection root assembling infrastructure implementations for application use-cases.

---

## Quality Gates & Verification

All code changes are validated locally and in CI using strict quality gates:

```bash
# Run complete verification gate (Tests + Typecheck + ESLint + Architecture Rules)
pnpm gate

# Run verification gate + Next.js production build
pnpm gate:build
```

### Automated Guardrails
- **Vitest**: Unit, integration, and port contract test matrix (1000+ tests).
- **TypeScript**: Strict typechecking (`tsc --noEmit`).
- **ESLint**: Code style & import order.
- **Dependency Cruiser**: Architecture layer boundary validation (`pnpm arch`).

---

## Tech Stack

| Component | Technology | Description |
|---|---|---|
| **Framework** | Next.js 16 (App Router) | React 19, Turbopack, Server Actions |
| **AI / RAG** | Vercel AI SDK v6 | Tool-calling, streaming, grounded citations |
| **Database** | Neon Postgres + pgvector | HNSW vector similarity search & BM25 hybrid ranking |
| **ORM** | Drizzle ORM | Type-safe schema definition and migrations |
| **Auth** | Clerk (`@clerk/nextjs` v7) | Middleware-gated sessions & RBAC roles |
| **Testing** | Vitest & Testing Library | Unit, integration, and port contract suites |
| **Styling** | Tailwind CSS v4 | Achromatic obsidian slate design system |

---

## Admin Console & Features

Admins access `/admin` to manage documents, inspect tickets, analyze chat performance, and adjust system settings:

- **`/admin` (Overview)**: Real-time status cards, document counts, open tickets, and live audit stream.
- **`/admin/documents`**: Document management, inline PDF preview, soft-delete with 7-day restore window, and re-counting.
- **`/admin/tickets`**: Support ticket queue with drawer details, notes history, status transitions, and audit trail.
- **`/admin/analytics`**: Chat telemetry, token cost breakdown, hallucination rates, search similarity distributions, and feedback metrics.
- **`/admin/settings`**: Dynamic runtime configuration (retrieval modes, search thresholds, persona prompt, chunking strategy, cache TTL) backed by optimistic concurrency controls.

---

## CLI & Scripts

The `rag-agent` CLI dispatcher handles administrative setup, database operations, and document seeding:

```bash
# Run interactive setup wizard
pnpm configure

# Command-line dispatcher
pnpm cli --help

# Ingest document directory
pnpm cli seed

# Preview chunking strategies across a PDF
pnpm chunks:preview path/to/document.pdf
```

| Script | Purpose |
|---|---|
| `pnpm dev` | Start Next.js development server |
| `pnpm build` | Run database migrations & production build |
| `pnpm gate` | Run full quality gate (`test` + `typecheck` + `lint` + `arch`) |
| `pnpm gate:build` | Run quality gate and production build validation |
| `pnpm db:push` | Push schema changes directly to local database |
| `pnpm db:migrate` | Execute pending Drizzle SQL migrations |
| `pnpm eval` | Run RAG evaluation harness over golden dataset |

---

## Recommended GitHub Repository Topics

When configuring this repository on GitHub, we suggest adding the following topics for maximum discoverability:

`nextjs-16` • `vercel-ai-sdk` • `rag-agent` • `pgvector` • `drizzle-orm` • `clean-architecture` • `typescript` • `pnpm-workspace` • `vitest` • `clerk-auth`

---

## License & Contributing

Contributions are welcome! Please read our [CONTRIBUTING.md](CONTRIBUTING.md) guide before submitting pull requests.
