
# Contributing

Install dependencies with `pnpm install`, then run the complete local gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm arch
```

Use `pnpm db:migrate` only with an intentional local or test `DATABASE_URL`.
Production migrations run only from the production Vercel build.
