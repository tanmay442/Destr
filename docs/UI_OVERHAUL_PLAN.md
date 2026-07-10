# UI Overhaul Plan — Global Greyscale Redesign + Marketing Landing Rebuild

> **Status:** Planning only. Nothing in this document has been implemented.
> **Owner:** design pass (components provided later).
> **Scope:** Entire application theme + the public `(marketing)` landing page.
>
> **Companion doc:** [`UI_REFERENCE.md`](./UI_REFERENCE.md) — verbatim `pnpm dlx shadcn` commands and full React Bits component sources (LogoLoop, BorderGlow) as provided.

---

## 0. Summary

Two coordinated workstreams:

1. **Global theme** — replace the current teal + "obsidian slate" palette with a
   minimal **matte-black / white / metallic-grey** system and super-minimal
   typography, applied **project-wide** (not just the landing page).
2. **Marketing landing** — rebuild `src/app/(marketing)` as a single-screen,
   starter-template-style landing so visitors understand the project and
   developers know what to clone, run, and test. There is **no separate top
   header/navbar**; the only call-to-action lives in a minimal floating
   Open chat / Sign in card.

Decisions already made:

| Question | Decision |
| --- | --- |
| Build approach | Plan only — real components provided later, drop in after |
| Starter-template sections | Yes — add **Quick Start** terminal block **and** **Stack** section |
| Navbar | **No separate header** — fold CTA into floating card / hero |
| Semantic colors (danger/success/warning) | **Keep colored** (admin + chat) |
| Favicon / Open Graph image | **Defer** to logo pass (no change this round) |
| Brand logo (`BrandMark`/`BrandLogo`) | **Ditch** — plain wordmark until new logo arrives |

---

## 1. Global Visual Direction

### 1.1 Palette

Drop the current teal accent (`oklch(0.78 0.14 196)`) and the blue-tinted
obsidian-slate surfaces. New system is achromatic:

| Token | Role | Proposed value |
| --- | --- | --- |
| `--background` | Page background (matte black, not pure) | `#0a0a0a` |
| `--surface` | Default surface | `#141414` |
| `--surface-elevated` | Raised surface (cards, popovers) | `#1c1c1c` |
| `--surface-sunken` | Recessed surface (inputs, code) | `#070707` |
| `--border` | Standard border | `#2a2a2a` |
| `--border-subtle` | Quiet border | `#1f1f1f` |
| `--border-strong` | Emphasized border | `#3a3a3a` |
| `--foreground` | Primary text (white) | `#f5f5f5` |
| `--foreground-muted` | Secondary text | `#a3a3a3` |
| `--foreground-subtle` | Tertiary text | `#737373` |
| `--foreground-faint` | Disabled / faint | `#525252` |
| `--accent` | Metallic grey (primary actions) | `#e5e5e5` |
| `--accent-hover` | Metallic hover | `#ffffff` |
| `--accent-pressed` | Metallic pressed | `#cfcfcf` |
| `--accent-foreground` | Text on metallic button (black) | `#0a0a0a` |
| `--accent-soft` | Soft metallic wash | `rgba(229,229,229,0.12)` |
| `--ring` | Focus ring | `rgba(229,229,229,0.55)` |
| `--glow-accent` | Hero / focus glow | `rgba(229,229,229,0.14)` |

> **Note:** The proposed hex values are starting points. The eventual
> component pass may refine the exact metallic-grey tint (e.g. a warmer or
> cooler silver). All components must read these from CSS tokens — never
> hardcode the old teal.

**Preserved (colored) tokens** — keep exactly as they are today so functional
signals remain scannable:

- `--danger` / `--danger-soft`
- `--success` / `--success-soft`
- `--warning` / `--warning-soft`

### 1.2 Typography

- Keep **Geist Sans** (already wired in `src/app/layout.tsx` via `--font-geist-sans`)
  and **Geist Mono** for code.
- Super-minimal treatment: tighter tracking on display text
  (`tracking-tight`), restrained uppercase eyebrows with modest letter-spacing,
  generous vertical whitespace, no decorative flourishes.
- Keep the existing `--radius-*` scale, easing curves, and `--animate-reveal`
  (fade-up) utility.

### 1.3 Logo

- The current `BrandMark` / `BrandLogo` (teal chat-bubble) is **ditched**.
- Until the new logo is supplied, render a **plain wordmark** `RAG Support` in
  white (no icon) wherever the brand previously appeared.
- `src/app/icon.tsx`, `apple-icon.tsx`, `opengraph-image.tsx` currently hardcode
  the teal `#3ddbd9` stroke on a `#1a1d2e` background — **left untouched** this
  round; handled in the logo pass.

---

## 2. Global Theme — Required File Changes

> The app is overwhelmingly token-driven (`bg-accent`, `text-foreground`,
> `border-border`, etc.), so redefining the tokens in `globals.css` cascades
> across every route group (`(marketing)`, `(app)`, API error pages, admin).

### 2.1 `src/app/globals.css`

Rewrite the `@theme { … }` primitive block (lines 30–85) with the greyscale
tokens from §1.1. Keep:
- the `@theme inline` mapping block (lines 5–26),
- `@layer base` rules,
- `@layer components` (`.chat-markdown` rules — they reference `text-accent`
  for inline code, which now resolves to metallic grey, which is fine),
- the `prefers-reduced-motion` block.

### 2.2 `src/components/ChatInterface.tsx` (lines ~239–242)

Hardcoded `oklch` status colors:

```ts
? 'oklch(0.78 0.16 155)'   // success  -> KEEP (colored)
? 'oklch(0.78 0.14 196)'   // accent   -> REPLACE with new grey accent
: 'oklch(0.82 0.15 80)'    // warning  -> KEEP (colored)
```

Only the middle (info/neutral accent) value is swapped to the metallic grey.

### 2.3 Deferred (no change this round)

- `src/app/icon.tsx`, `apple-icon.tsx`, `opengraph-image.tsx` — await logo pass.
- `src/components/icons/BrandMark.tsx` — deprecate; swap usages to plain
  wordmark. Remove from import graphs once the new logo component exists.

### 2.4 Unaffected

- `Ferrofluid` background (marketing `layout.tsx`) uses white — fits the scheme.
- `next.config.ts` / `vercel.json` — no color config.
- Security headers, middleware, architecture layers — untouched.

---

## 3. React Bits Components (LogoLoop + BorderGlow)

The tech marquee and the auth card use two open-source React Bits components
(JavaScript + CSS variant). `react-icons` and `shadcn` are **not installed** in
this repo, so the `pnpm dlx shadcn add` command is recorded for reference only
in [`UI_REFERENCE.md`](./UI_REFERENCE.md) — the source is **copied manually**
and converted to TSX + `'use client'` (both use refs / pointer events).

```bash
pnpm dlx shadcn@latest add @react-bits/LogoLoop-JS-CSS
pnpm dlx shadcn@latest add @react-bits/BorderGlow-JS-CSS
```

**Files to create:** `src/components/react-bits/LogoLoop.tsx` (+ `LogoLoop.css`)
and `src/components/react-bits/BorderGlow.tsx` (+ `BorderGlow.css`), both
`'use client'`, CSS imported alongside the component.

### 3.1 LogoLoop → tech marquee (`MarketingTechMarquee`)
- Logos are **text nodes, not `react-icons`** (dependency-free, greyscale-friendly):
  `{ node: <span className="font-medium tracking-tight text-foreground-muted">{name}</span>, title, href? }`.
- `Docker` is included in `TECH` (see §4.2).
- Props: `speed={80}`, `direction="left"`, `logoHeight={28}`, `gap={48}`,
  `fadeOut`, `fadeOutColor="#0a0a0a"` (matte-black edge fade), `scaleOnHover`,
  `ariaLabel="Built with"`.

### 3.2 BorderGlow → chat / sign-in card
- Greyscale customization (overrides the default purple/pink/blue):
  `edgeSensitivity={35}`, `glowColor="0 0 85"` (grey), `backgroundColor="#141414"`
  (surface), `borderRadius={16}`, `glowRadius={28}`,
  `colors={['#f5f5f5', '#a3a3a3', '#525252']}` (metallic silver ramp).
- **Appears in BOTH hero and footer:**
  - **Hero:** floating instance — wrap `BorderGlow` in an outer
    `<div className="auth-card-float">`; add a `--float-y` keyframe to
    `globals.css` (reduced-motion disables it). Float on the wrapper so it does
    not fight `BorderGlow`'s own `transform`.
  - **Footer:** static (non-floating) `BorderGlow` instance wrapping the same
    Open chat / Sign in card, above the source/marketing links.
- `MarketingAuthCard.tsx` becomes a **client component** (`'use client'`) since
  it nests `BorderGlow` + Clerk `SignInButton`.

---

## 4. Marketing Landing — New Structure

Single screen, **no top header**. Sections top → bottom:

```
┌─────────────────────────────────────────────┐
│  HERO  (project info from README + current)  │
│   ├─ eyebrow                                  │
│   ├─ headline                                 │
│   ├─ subcopy                                  │
│   ├─ 4 feature bullets                        │
│   └─ demo notice                              │
│                                               │
│  FLOATING AUTH CARD  (Open chat + Sign in)    │
│   └─ super-minimal, animated float            │
│                                               │
│  TECH LOGO LOOP  (marquee of tech)            │
│                                               │
│  QUICK START  (terminal block)                │
│                                               │
│  STACK  (grid from README)                    │
│                                               │
│  FOOTER  (source + doc/marketing links)       │
└─────────────────────────────────────────────┘
```

`src/app/(marketing)/layout.tsx` keeps the `Ferrofluid` background wrapper.

### 4.1 File inventory

| Action | File |
| --- | --- |
| **Modify** | `src/app/(marketing)/page.tsx` — recompose in §4 order |
| **Rewrite** | `src/components/marketing/MarketingHero.tsx` |
| **Rewrite** | `src/components/marketing/MarketingFooter.tsx` |
| **Create** | `src/components/marketing/MarketingAuthCard.tsx` (client; wraps `BorderGlow`) |
| **Create** | `src/components/marketing/MarketingTechMarquee.tsx` (uses `LogoLoop`) |
| **Create** | `src/components/marketing/MarketingQuickStart.tsx` |
| **Create** | `src/components/marketing/MarketingStack.tsx` |
| **Create** | `src/components/marketing/marketing-content.ts` (single copy/data source) |
| **Create** | `src/components/react-bits/LogoLoop.tsx` + `LogoLoop.css` (`'use client'`) |
| **Create** | `src/components/react-bits/BorderGlow.tsx` + `BorderGlow.css` (`'use client'`) |
| **Remove** | `src/components/marketing/MarketingHeader.tsx` (no header) |
| **Remove** | `src/components/marketing/MarketingCard.tsx` (replaced by `MarketingAuthCard`) |

### 4.2 `marketing-content.ts` (single source of truth)

Holds all copy + data arrays so the later-provided components consume the same
content without re-gathering it:

```ts
export const HERO = {
  eyebrow: 'SERVERLESS · GROUNDED · ESCALATION-READY',
  headline: 'Serverless AI customer support.',
  subcopy:
    'A retrieval-augmented generation (RAG) agent that answers questions with ' +
    'cited documentation, resolves ambiguous requests, and escalates to a human ' +
    'support ticket — built on Next.js 16, the Vercel AI SDK v6, and Drizzle ORM ' +
    'on Neon Serverless Postgres with pgvector.',
  demoNotice:
    'Demo notice: This is a live demo. While fully functional, tickets created ' +
    'during your session are stored in a demo sandbox environment.',
};

export const FEATURES = [
  { title: 'Grounded Answers', description: 'RAG-based context retrieval with high-accuracy vector semantic citations.' },
  { title: 'Multi-step Workflows', description: 'Dynamically clarifies vague prompts, searches docs, and synthesizes answers.' },
  { title: 'Human Escalation', description: 'Creates a structured support ticket when the documentation cannot solve the query.' },
  { title: 'Serverless Architecture', description: 'Built entirely on edge-ready, pay-as-you-go serverless infrastructure.' },
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

export const STACK = [
  { label: 'Framework', value: 'Next.js 16 (App Router) with Turbopack' },
  { label: 'Auth', value: 'Clerk — email/password + Google' },
  { label: 'LLM', value: 'Google AI Studio gemini-embedding-001 + OpenAI-compatible chat' },
  { label: 'Database', value: 'Neon Serverless Postgres + pgvector (HNSW cosine)' },
  { label: 'ORM', value: 'Drizzle' },
  { label: 'Tooling', value: 'Vitest, Testing Library, drizzle-kit' },
  { label: 'UI', value: 'Dark CSS-token theme (matte black / metallic grey)' },
];

export const FOOTER_LINKS = [
  { label: 'Source', href: 'https://github.com/tanmay442/rag_agent' },
  { label: 'Documentation', href: '/docs' },
  { label: 'Getting API keys', href: '/docs/GETTING_YOUR_API_KEYS' },
  { label: 'Deploy to Vercel', href: 'https://vercel.com' },
  { label: 'README', href: 'https://github.com/tanmay442/rag_agent#readme' },
];
```

### 4.3 Component responsibilities (placeholders to be styled later)

- **`MarketingHero`** — eyebrow, `h1` headline, subcopy (no "personal portfolio"
  phrasing), `FEATURES` bullet list (reuse the existing check-icon row pattern),
  and the demo-notice note block (reworded, see §4.2 `HERO.demoNotice`).
- **`MarketingAuthCard`** — client component wrapping `BorderGlow`. Primary
  action `Open chat` (`Link` → `/chat`, `data-testid="home-open-chat"`); secondary
  action `Sign in` (Clerk `SignInButton`, `data-testid="home-sign-in"`). Rendered
  **floating in the hero** and **static in the footer** (see §3.2).
- **`MarketingTechMarquee`** — renders the React Bits `LogoLoop` over `TECH`
  (includes `Docker`), text-node logos, greyscale `fadeOutColor`.
- **`MarketingQuickStart`** — terminal-styled block rendering `QUICK_START.commands`
  with a mono font and a copy button; `note` beneath.
- **`MarketingStack`** — responsive grid of `STACK` label/value pairs.
- **`MarketingFooter`** — `FOOTER_LINKS` + a "view source" GitHub entry
  (`data-testid="landing-footer-source"`) + the static `BorderGlow` auth card.

### 4.4 Preserved test ids (do not break)

`landing-main`, `landing-left`, `landing-demo-notice`, `home-open-chat`,
`home-sign-in`, `landing-footer`, `landing-footer-source`.

Add new ids as needed (e.g. `landing-marquee`, `landing-quickstart`,
`landing-stack`) for future tests.

---

## 5. Verification (post-implementation checklist)

```bash
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest suite (ensure marketing + chat tests still pass)
pnpm dev         # visual: greyscale applied everywhere, landing renders
pnpm arch        # dependency-cruiser boundary check (unchanged import graph)
```

Manual checks:
- App shell (`/chat`, `/admin/*`), loading/error/not-found states all greyscale.
- Success/warning/danger still colored in admin + chat.
- Landing has no header; floating card present; marquee + quick-start + stack
  render; footer links resolve.

---

## 6. Open Items & Extension Points

1. **Token values** are proposed — confirm or refine in the component pass.
2. **New logo** replaces `BrandMark`/`BrandLogo` and the favicon/OG assets.
3. All new marketing components are token-driven and read from
   `marketing-content.ts`, so the polished visual components drop in without
   copy changes.
4. `ChatInterface.tsx` line 241 is the only non-token color that must change for
   full greyscale consistency (success/warning intentionally kept).
5. **Remove "personal portfolio project"** from all UI copy:
   - `src/components/marketing/MarketingHero.tsx` (subcopy + demo notice) — done
     via §4.2 `HERO` reword.
   - `src/components/marketing/MarketingFooter.tsx` line 12 →
     "RAG Support — open-source AI customer support."
   - `src/components/marketing/MarketingHeader.tsx` line 23 ("Personal Next.js
     project") — file is removed in this plan; if retained during transition,
     change to neutral. (README has **no** such phrase.)
6. **BorderGlow grey props** (§3.2) are starting points — tune the metallic tint
   in the component pass. Source + `pnpm` commands in [`UI_REFERENCE.md`](./UI_REFERENCE.md).
