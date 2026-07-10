export const HERO = {
  eyebrow: 'SERVERLESS · GROUNDED · READY',
  headline: 'Serverless AI customer support.',
  subcopy:
    'A RAG agent that answers with cited docs, clarifies vague prompts, ' +
    'and escalates to a human ticket — built on Next.js 16, Vercel AI SDK v6, ' +
    'and Drizzle on Neon Postgres + pgvector.',
};

export const FEATURES = [
  { title: 'Grounded Answers', description: 'Cited, high-accuracy RAG answers.' },
  { title: 'Multi-step Workflows', description: 'Clarifies, searches, and synthesizes.' },
  { title: 'Human Escalation', description: 'Escalates to a structured support ticket.' },
  { title: 'Serverless Architecture', description: 'Edge-ready, pay-as-you-go infra.' },
];

export const TECH = [
  'Next.js', 'React', 'Clerk', 'Vercel AI SDK', 'Drizzle', 'Neon Postgres',
  'pgvector', 'Docker', 'Ollama', 'Google AI Studio', 'OpenAI-compatible',
  'Cloudflare R2', 'Upstash Redis', 'Upstash QStash', 'Tailwind CSS', 'Vitest',
  'TypeScript',
];

export const QUICK_START = {
  commands: [
    'git clone https://github.com/tanmay442/rag_agent.git && cd rag_agent',
    'docker compose up -d db          # Postgres + pgvector',
    'pnpm install',
    'pnpm db:push                     # create tables in local DB',
    'pnpm dev                         # http://localhost:3000',
  ],
  note: 'Clerk keys are still required for sign-in. For a zero-key local setup use the Ollama profile; see the README "Deploy to Vercel" section for production.',
};

export const FOOTER_LINKS = [
  { label: 'Source', href: 'https://github.com/tanmay442/rag_agent' },
  { label: 'README', href: 'https://github.com/tanmay442/rag_agent#readme' },
  { label: 'Contributing', href: '/CONTRIBUTING' },
];
