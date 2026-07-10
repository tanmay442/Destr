# shadcn/ui Migration Plan — Non-Marketing Surfaces

> Status: PLANNED, NOT YET EXECUTED.
> Scope: Every UI surface **except** the `(marketing)` route is migrated to
> **shadcn/ui** primitives while preserving the existing matte-black /
> metallic-grey greyscale theme. Marketing is exempt from visual re-theming
> (already done) but receives the same token *rename* so the vocabulary is
> unified app-wide.

---

## 0. Decisions (confirmed with user)

1. **Adopt shadcn's canonical token vocabulary wholesale.** The custom token
   names (`--surface`, `--accent`, `--danger`, `--foreground-muted`, …) are
   renamed to shadcn's canonical names (`--card`, `--primary`, `--destructive`,
   `--muted-foreground`, …) with greyscale values. Marketing is included in the
   rename so there is a single shared vocabulary.
2. **Transient feedback becomes sonner toasts.** Inline "banner" feedback that
   is momentary (upload result, recount error, row-action results, chat error)
   is converted to `sonner` toasts. Persistent state (ingest status banners,
   ticket not-in-view, live/deleted badges) stays as inline `Alert`.
3. **Convert both hand-rolled dialogs to shadcn now.** The mobile sidebar
   drawer → shadcn `Sheet`; the ticket detail overlay → shadcn `Dialog`/`Sheet`.
   Both gain Radix-backed focus-trap, portal, and Esc handling.

---

## 1. Current state (audit summary)

- Stack: Next.js 16 (App Router), React 19, Tailwind v4 (CSS `@theme` tokens,
  no JS config), TypeScript. Package manager `pnpm`.
- shadcn/ui is **not** installed: no `components.json`, no `src/components/ui`,
  no `@/lib/utils`, no `clsx`/`tailwind-merge`/`class-variance-authority`.
- `lucide-react` already present (icons). Used heavily already.
- Theme tokens live in `src/app/globals.css` (`@theme inline` aliases + `@theme`
  values). Greyscale base: `--background:#0a0a0a`, `--foreground:#f5f5f5`,
  `--accent:#e5e5e5`, `--danger`/`--success`/`--warning` kept as semantic
  colors (intentional).
- Validation gates used historically: `pnpm typecheck`, `pnpm lint`,
  `pnpm arch`, `pnpm test` (230 passing), `pnpm build`.
- Most non-marketing files **already render in greyscale** via our custom
  tokens. Real off-theme strays are limited to:
  - `src/app/(app)/admin/documents/recount-all-button.tsx:41` → `text-red-500`
  - `src/components/app/AppSidebar.tsx:147` → `bg-black/60` scrim
  - `src/app/(app)/admin/tickets/ticket-overlay.tsx:86` → `bg-black/60` scrim
  - `src/components/ChatInterface.tsx:239-242` → hardcoded `simTone`
    (`oklch(0.78 0.16 155)`, `#e5e5e5`, `oklch(0.82 0.15 80)`) applied via
    inline `style`.
- No `react-hook-form`, no `zod` UI usage, no toast lib. Forms use native
  `<form>` + `useActionState`/`useTransition`. **Do not introduce RHF** (would
  risk breaking server actions). shadcn `Form` primitive is out of scope.
- Third-party UI already present: `@clerk/nextjs` (`<SignIn>`/`<SignUp>` own
  their own UI — leave untouched), `ai` + `@ai-sdk/react` (`useChat`),
  `react-markdown` + `remark-gfm`.

### 1.1 Full file inventory (non-marketing)

Shell / layouts:
- `src/app/layout.tsx` (root; `ClerkProvider`, fonts, `bg-background text-foreground`)
- `src/app/(app)/layout.tsx` (renders `AppSidebar` + `<main>`)
- `src/app/(app)/admin/layout.tsx` (centered `max-w-6xl` wrapper, `requireAdmin()`)

Sidebar:
- `src/components/app/AppSidebar.tsx` — hand-rolled nav `Link`s, hamburger,
  admin collapse toggle, sign-out, avatar (`<img>` + initial fallback),
  mobile drawer (`role="dialog"`, `bg-black/60` scrim, no focus trap).

Chat:
- `src/app/(app)/chat/page.tsx` — "Online" `Badge` pill with `animate-ping`
  `bg-success` dot; renders `ChatInterface`.
- `src/app/(app)/chat/error.tsx` — hand-rolled "Try again" `Button`.
- `src/components/ChatInterface.tsx` — chat frame `Card`, user/assistant
  bubbles, citation cards w/ match-% `Badge` + inline progress bar, send/stop/
  quick-prompt `Button`s, composer `Textarea`, error `Alert`, `simTone` inline
  colors.

Admin shared:
- `src/components/admin/StatCard.tsx` — `Card` (static + link variants).
- `src/components/admin/Pagination.tsx` — `Link` styled as button.
- `src/components/admin/AuditEventList.tsx` — `Card`/list.
- `src/app/(app)/admin/page.tsx` — composes StatCard + AuditEventList.
- `src/app/(app)/admin/analytics/page.tsx` — hand-rolled `Table`.
- `src/app/(app)/admin/audit/page.tsx` — `Input`(number+text), `Label`(sr-only),
  `Button`(Filter), `Table`, Pagination.
- `src/app/(app)/admin/documents/page.tsx` — `Input`(search), `Label`(sr-only),
  `Button`(Search), `Badge`(ingest/live/deleted via `ingestBadgeClass`),
  `Table`, status `Alert` banner.
- `src/app/(app)/admin/documents/recount-all-button.tsx` — `Button` +
  `text-red-500` error.
- `src/app/(app)/admin/documents/document-row-actions.tsx` — `Button`s
  (Preview/Download/Delete/Recount/Restore/Hard-delete) w/ semantic variants.
- `src/app/(app)/admin/documents/ingest-status-poller.tsx` — renders `null`.
- `src/app/(app)/admin/documents/[id]/preview/page.tsx` — `Link` back buttons,
  `iframe` `Card`, empty-state `Card`.
- `src/app/(app)/admin/users/page.tsx` — `Input`(search), `Label`, `Button`,
  `Table`, `Badge`(role), Pagination.
- `src/app/(app)/admin/users/user-row-actions.tsx` — Promote/Demote `Button`s.
- `src/app/(app)/admin/upload/page.tsx` — file `Input` + dropzone `Card`,
  Replace/Submit `Button`s, error/success `Alert` banners.
- `src/app/(app)/admin/tickets/page.tsx` — `Select`(status, assignee),
  `Input`(search), `Button`(Apply; uses `rounded` not `rounded-xl`), `Table`,
  `Badge`(anonymous/status), Pagination.
- `src/app/(app)/admin/tickets/ticket-overlay.tsx` — hand-rolled `Dialog`
  (`createPortal`, `role="dialog"`, `bg-black/60` scrim, no focus trap).
- `src/app/(app)/admin/tickets/ticket-drawer.tsx` — `Card` form body, visible
  uppercase `Label`s, `Select`s, `Textarea`, Save/Post-note `Button`s, error
  `Alert`.

Loading / error / not-found:
- `src/app/(app)/admin/loading.tsx`, `documents/loading.tsx`,
  `users/loading.tsx`, `audit/loading.tsx`, `tickets/loading.tsx` — hand-rolled
  `animate-pulse` skeletons.
- `src/app/(app)/admin/error.tsx`, `chat/error.tsx`, `admin/not-found.tsx`.

Sign-in / Sign-up (out of scope for primitives; Clerk owns UI):
- `src/app/sign-in/[[...sign-in]]/page.tsx`
- `src/app/sign-up/[[...sign-up]]/page.tsx`

### 1.2 Primitive → files map

| shadcn primitive | Files using a hand-rolled equivalent |
|---|---|
| Button | AppSidebar, ChatInterface, chat/error, documents/page, document-row-actions, recount-all-button, users/page, user-row-actions, upload/page, audit/page, tickets/page, ticket-overlay, ticket-drawer, admin/error, preview/page, StatCard |
| Card | StatCard, ChatInterface, chat/page, ticket-drawer, ticket-overlay, upload, preview, analytics/page, AuditEventList, documents banners |
| Input | documents/page, users/page, audit/page, tickets/page, upload/page, ticket-drawer |
| Textarea | ChatInterface, ticket-drawer |
| Label | documents/page, users/page, audit/page (sr-only); ticket-drawer (visible) |
| Select | tickets/page, ticket-drawer |
| Table | analytics/page, documents/page, users/page, audit/page, tickets/page |
| Badge | chat/page, documents/page, users/page, tickets/page, ChatInterface |
| Dialog / Sheet | AppSidebar (drawer), ticket-overlay |
| Avatar | AppSidebar |
| Alert | ChatInterface error, upload errors/success, recount errors, row-action errors, ticket-drawer error, admin not-found |
| Skeleton | all 5 `loading.tsx` |
| Sonner (Toast) | NEW — replaces transient banners |

---

## 2. Phase 0 — Scaffold shadcn/ui (sequential; everything depends on it)

### 2.1 Install base deps
```
pnpm add class-variance-authority clsx tailwind-merge lucide-react
```
Radix packages (`@radix-ui/react-*`) are pulled automatically by `shadcn add`
in later steps. `next-themes` is NOT required (dark is the only theme; we set
`Toaster theme="dark"` and skip theme toggle).

### 2.2 Create `src/lib/utils.ts`
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### 2.3 Create `components.json`
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

### 2.4 Rewrite token block in `src/app/globals.css`
Replace our custom `@theme`/`@theme inline` token names with shadcn's canonical
set (greyscale-valued) while **keeping** the supplementary tokens shadcn lacks.

Draft new `@theme inline` mapping (top):
```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  /* supplementary (kept) */
  --color-surface-elevated: var(--surface-elevated);
  --color-surface-sunken: var(--surface-sunken);
  --color-foreground-subtle: var(--foreground-subtle);
  --color-foreground-faint: var(--foreground-faint);
  --color-border-subtle: var(--border-subtle);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-accent-soft: var(--accent-soft);
  --color-glow-accent: var(--glow-accent);
}
```

Draft new `@theme`/`:root` values (greyscale):
```css
@theme {
  --background: #0a0a0a;
  --foreground: #f5f5f5;

  --card: #141414;
  --card-foreground: #f5f5f5;
  --popover: #141414;
  --popover-foreground: #f5f5f5;

  --primary: #e5e5e5;
  --primary-foreground: #0a0a0a;
  --secondary: #1c1c1c;
  --secondary-foreground: #f5f5f5;

  --muted: #141414;
  --muted-foreground: #a3a3a3;

  --accent: #1c1c1c;
  --accent-foreground: #f5f5f5;

  --destructive: oklch(0.7 0.18 25);
  --destructive-foreground: #f5f5f5;

  --border: #2a2a2a;
  --input: #2a2a2a;
  --ring: rgba(229,229,229,0.55);

  /* supplementary (kept) */
  --surface-elevated: #1c1c1c;
  --surface-sunken: #070707;
  --foreground-subtle: #737373;
  --foreground-faint: #525252;
  --border-subtle: #1f1f1f;
  --success: oklch(0.78 0.16 155);
  --success-soft: oklch(0.32 0.08 155);
  --warning: oklch(0.82 0.15 80);
  --warning-soft: oklch(0.32 0.08 80);
  --accent-soft: rgba(229,229,229,0.12);
  --glow-accent: rgba(229,229,229,0.14);

  /* keep existing animation/easing/radius/duration vars */
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 140ms;
  --dur-base: 200ms;
  --dur-slow: 320ms;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius: 12px;
  --animate-reveal: ...;
  --animate-float-y: ...;
}
```
Note: Because this is Tailwind v4 with `:root` defaults, ensure no `.dark`
selector is required (everything is the dark palette). If shadcn's generator
adds a `:root`/`.dark` split, collapse it to a single `:root` using the values
above (only the dark palette exists).

### 2.5 Add components
```
pnpm dlx shadcn@latest add button card input label textarea select badge \
  avatar alert skeleton sheet dialog sonner separator table -y
```
- If the CLI lacks network, **vendor the component source manually** (copy from
  the shadcn registry / CN-licensed copy) into `src/components/ui/*`. The token
  aliases above make them render correctly regardless.
- Confirm each generated file imports `cn` from `@/lib/utils` and uses
  `bg-primary`, `bg-card`, `text-muted-foreground`, `border`, `bg-destructive`,
  etc. (they will, since we defined those tokens).

### 2.6 Mount the Toaster
Edit `src/app/layout.tsx` to render `<Toaster theme="dark" position="bottom-right" />`
inside `<body>` (e.g. just before `{children}` or after). Import from
`@/components/ui/sonner`.

---

## 3. Phase 1 — Token rename (mechanical, script + per-file review)

Run a repo-wide find/replace across `src` (marketing included). **Preserve**
supplementary tokens. Mapping:

| old token / class | new |
|---|---|
| `bg-surface` | `bg-card` |
| `bg-surface / hover:bg-surface-elevated` | `bg-card hover:bg-card` (or `hover:bg-secondary` where an elevated hover is desired) |
| `text-foreground-muted` | `text-muted-foreground` |
| `bg-accent` (grey fill) | `bg-primary` |
| `text-accent-foreground` | `text-primary-foreground` |
| `bg-accent-foreground` | `bg-primary-foreground` |
| `hover:bg-accent-hover` | `hover:bg-primary` (or `hover:bg-primary/90`) |
| `active:bg-accent-pressed` | `active:bg-primary/80` |
| `border-border` | `border` |
| `ring-border` | `ring` |
| `text-danger` | `text-destructive` |
| `bg-danger/...`, `border-danger/...` | `bg-destructive/...`, `border-destructive/...` |
| `text-red-500` | `text-destructive` |
| `bg-success`, `text-success`, `bg-success/...` | keep (`--success` supplementary) |
| `bg-warning`, `text-warning`, `bg-warning/...` | keep (`--warning` supplementary) |
| `bg-surface-elevated`, `bg-surface-sunken` | keep (supplementary) |
| `text-foreground-subtle`, `text-foreground-faint` | keep (supplementary) |
| `border-border-subtle` | keep (supplementary) |
| `bg-black/60` scrim | keep as-is (neutral) — optional: `bg-foreground/60` |
| `simTone` literals (`oklch(0.78 0.16 155)`, `#e5e5e5`, `oklch(0.82 0.15 80)`) in `ChatInterface` | `var(--success)`, `var(--primary)`, `var(--warning)` |

Execution: use `sed`/`rg` batch replace for the unambiguous tokens, then a
focused `git diff` review pass to catch compound classes (e.g.
`bg-surface-elevated` must NOT be collapsed to `bg-card` when an elevated look
is intended — decide per occurrence: prefer `bg-card` default, `bg-secondary`
for subtle elevated, keep `bg-surface-elevated`/`bg-surface-sunken` only where
the darker/lighter shade is load-bearing such as sunken inputs or elevated
hover panels). Keep `surface-elevated`/`surface-sunken` tokens defined
(registered in Phase 0) so any leftover usages still compile.

---

## 4. Phase 2 — Swap primitives for shadcn (parallel subagents, 4 lanes)

Each lane's contract: import from `@/components/ui/*`, preserve exact greyscale
visual result, **do not alter any behavior / server actions / data flow**,
update tests only if a `data-testid`/selector actually breaks (current tests
use `data-testid`, not color classes — should be safe), run `pnpm typecheck`
and `pnpm lint` within the lane before returning.

### Lane A — App shell & sidebar (`Sheet` + `Button` + `Avatar`)
- `src/components/app/AppSidebar.tsx`:
  - Replace mobile drawer `<div role="dialog">` + manual Esc/scroll-lock with
    shadcn `Sheet` (`side="left"`), which provides portal + focus-trap + Esc.
    Keep the same visual classes on `SheetContent` (`w-72 max-w-[85vw] border-r
    border-border-subtle bg-card shadow-2xl`) and the `bg-black/60 backdrop-blur-sm`
    overlay (Sheet provides the overlay; style it).
  - Nav items → `Button` variant `ghost`/`secondary` sized `sm`, or keep as
    `Link` wrapped in `Button` asChild. Active state = `bg-secondary text-foreground`.
  - Hamburger → `Button` variant `outline`/`ghost` `size="icon"`.
  - Sign-out → `Button` variant `ghost` `size="sm"`.
  - Avatar → shadcn `Avatar` (`AvatarImage` + `AvatarFallback` initial). Keep
    `ring-1 ring-border-subtle rounded-full`.
  - Admin submenu stays an inline collapsible list (no `Collapsible` required,
    but may use shadcn `Collapsible` for consistency).
- `src/app/(app)/layout.tsx`, `src/app/(app)/admin/layout.tsx`: no logic change;
  only adjust any class names caught by the Phase 1 rename.

### Lane B — Admin CRUD pages + shared components
- `StatCard.tsx` → build on shadcn `Card` (keep static + link variants; link
  variant uses `Card` as `Link` via `asChild` or wraps a `Button`).
- `Pagination.tsx` → `Button` (`variant="outline"`/`size="sm"`) as `Link` (or
  keep `Link` styled with `buttonVariants`).
- `AuditEventList.tsx` → `Card` + list.
- `documents/page.tsx`: search `Input` + `Label`(sr-only) + Search `Button`;
  `Table` (thead `bg-secondary text-muted-foreground`, rows `border-border-subtle
  hover:bg-secondary/40`); `Badge` for ingest/live/deleted (use `Badge`
  variants: `destructive` for failed/deleted, `secondary`/`outline` for others,
  `default`=primary for ingesting); status banner → keep as `Alert`
  (`bg-success/10 text-success border-success/40`).
- `recount-all-button.tsx`: `Button` + replace `text-red-500` error with
  `text-destructive`; the error is a **transient** result → move to sonner
  toast (Lane B also wires sonner here).
- `document-row-actions.tsx`: `Button`(`size="sm" variant="outline"`) for
  Preview/Download/Delete/Recount; semantic variants via `variant="destructive"`
  / custom classes for Restore (`text-success`); results → sonner toast.
- `users/page.tsx`, `user-row-actions.tsx`: same `Input`/`Label`/`Button`/
  `Table`/`Badge` treatment; Promote/Demote results → toast.
- `audit/page.tsx`: `Input`(number+text) + `Label`(sr-only) + Filter `Button` +
  `Table`.
- `upload/page.tsx`: file `Input`(sr-only) + dropzone built on `Card`
  (`border-2 border-dashed`); Replace/Submit `Button`s; error/success banners →
  sonner toasts (success) + `Alert` only if persistent.
- `analytics/page.tsx`: `Table` (StatCard unchanged).
- `admin/page.tsx`: composes StatCard + AuditEventList (no change beyond rename).

### Lane C — Chat
- `ChatInterface.tsx`:
  - chat frame → `Card` (`rounded-2xl border-border-subtle bg-card/40`).
  - user bubble → `bg-primary text-primary-foreground`; assistant bubble →
    `Card` variant (`bg-secondary/80 border-border-subtle`).
  - citation card → `Card` (`bg-surface-sunken/70`); match-% → `Badge`;
    progress bar stays inline-width `<div>` but driven by `var(--success)`
    (fixed in Phase 1 `simTone` change).
  - send/stop/quick-prompt → `Button` (variants `default`/`outline`/`ghost`).
  - composer `Textarea` → shadcn `Textarea`.
  - error → `Alert` (`border-destructive/30 bg-destructive/10 text-destructive`)
    AND/OR sonner toast (chat error is transient → toast + keep inline Alert as
    fallback).
  - `simTone`: replace hardcoded literals with `var(--success)`/`var(--primary)`
    /`var(--warning)` (Phase 1).
- `chat/page.tsx`: "Online" pill → `Badge` variant `secondary` with `animate-ping`
  `bg-success` dot.
- `chat/error.tsx`: "Try again" → shadcn `Button`.

### Lane D — Tickets (Dialog/Sheet + Form)
- `ticket-overlay.tsx`: replace `createPortal` + manual `role="dialog"` + `bg-black/60`
  scrim with shadcn `Dialog` (or `Sheet side="right"`) — portal + focus-trap +
  Esc handled by Radix. Keep panel visual (`w-full max-w-md border-l border-border
  bg-card shadow-2xl`) on `DialogContent`/`SheetContent`; "Clear filter" +
  close → `Button`.
- `ticket-drawer.tsx`: body → `Card`; visible labels → shadcn `Label`;
  status/assignee → shadcn `Select`; note → `Textarea`; Save/Post-note →
  `Button`; error → `Alert` (`border-destructive/40 bg-destructive/10 text-destructive`).
- `tickets/page.tsx`: status/assignee → shadcn `Select`; search `Input` +
  `Label`(sr-only); Apply `Button` (fix `rounded` → `rounded-md`/shadcn default);
  `Table`; anonymous/status `Badge`; Pagination.

---

## 5. Phase 3 — Sonner toasts

- Already mounted in `src/app/layout.tsx` (Phase 0.6) via `<Toaster theme="dark" />`.
- Convert **transient** feedback to `toast.success` / `toast.error`:
  - `upload/page.tsx` success + error banners.
  - `recount-all-button.tsx` error.
  - `document-row-actions.tsx` + `user-row-actions.tsx` success/error results.
  - `ChatInterface` error (keep inline `Alert` as fallback too).
- **Keep inline `Alert`** (do NOT toast) for persistent state that must remain
  visible in context: ingest status banner (`documents/page.tsx`), ticket
  not-in-view (`ticket-overlay.tsx`), live/deleted document badges, ticket-drawer
  error (form-level, keep inline).
- Import `toast` from `@/components/ui/sonner` (re-exported from `sonner`).

---

## 6. Phase 4 — Loading / error / not-found states

- `admin/loading.tsx`, `documents/loading.tsx`, `users/loading.tsx`,
  `audit/loading.tsx`, `tickets/loading.tsx`: replace hand-rolled
  `animate-pulse rounded bg-secondary` blocks with shadcn `Skeleton`.
- `admin/error.tsx`: "Try again" → `Button`; wrap message in `Alert`.
- `chat/error.tsx`: already touched in Lane C.
- `admin/not-found.tsx`: static copy only; optionally wrap in `Card`.

---

## 7. Phase 5 — Decorative cohesion (optional, minor)

- `src/components/react-bits/BorderGlow.tsx`: default `colors` prop currently
  `['#c084fc', '#f472b6', '#38bdf8']` (purple/pink/blue). Default to greyscale
  `['#e5e5e5', '#ffffff', '#a3a3a3']` so the marketing auth-card glow matches the
  theme. (`Ferrofluid` already defaults to white — leave.) Marketing is exempt
  from re-theme, but this keeps the decorative glow on-theme.

---

## 8. Validation gates (run after each lane + final)

```
pnpm typecheck      # must be clean (0 errors)
pnpm lint           # expect 0 errors (9 pre-existing warnings may remain)
pnpm arch           # expect "no dependency violations found"
pnpm test           # expect 230 passing; re-check src/components/ChatInterface.test.tsx
pnpm build          # must succeed
```
- `ChatInterface.test.tsx` uses `data-testid` selectors (not color classes) so
  the rename should not break it; still run the file explicitly.
- `pnpm arch` enforces import boundaries — new `components/ui` and `lib/utils`
  imports must respect them (no server-only imports into client components, etc.).

---

## 9. Risks & mitigations

1. **`surface-elevated` / `surface-sunken` have no shadcn equivalent.** Kept as
   supplementary tokens (registered Phase 0). Only the core names get renamed,
   avoiding churn of every elevated/hover style while still "adopting shadcn
   tokens." Leftover usages still compile.
2. **`shadcn add` needs network.** If unavailable in CI/box, vendor component
   source manually (CN-licensed). Token aliases make them render correctly.
3. **Tailwind v4 `:root` vs `.dark`.** shadcn generator may emit a `.dark`
   block; collapse to a single `:root` since only the dark palette exists.
4. **No RHF/zod UI.** Keep native forms + `useActionState`/`useTransition`. Do
   NOT add shadcn `Form` (depends on RHF) — would risk breaking server actions.
5. **Tests.** Rename must not break `data-testid` selectors; re-run the suite.
6. **Visual drift.** Lanes must preserve greyscale look exactly; review each
   lane's `git diff` for accidental color/radius changes. shadcn `Button`
   default radius is `--radius` (12px) — align with existing `rounded-xl` (12px),
   consistent.
7. **Clerk pages.** `sign-in`/`sign-up` are Clerk-owned; only ensure their
   container (`mx-auto`) survives the rename. No primitive swap.

---

## 10. Execution sequence

1. **Phase 0** (sequential, one pass): deps → `lib/utils.ts` → `components.json`
   → `globals.css` token rewrite → `shadcn add` → mount `Toaster`. Run
   typecheck/lint/build to confirm scaffold is green before lanes start.
2. **Phase 1** (sequential, one pass): token rename across `src` + diff review.
3. **Phase 2**: run Lanes A–D as **parallel subagents** (independent file sets;
   no shared mutable files except `globals.css` already done). Each lane returns
   with typecheck+lint green.
4. **Phase 3** (can be folded into Lanes B/C since they touch the same files):
   wire sonner toasts.
5. **Phase 4** (sequential, small): skeletons + error/not-found.
6. **Phase 5** (optional): BorderGlow greyscale default.
7. **Final validation** (Phase 8 gates) + commit.

---

## 11. Files touched (summary)

New:
- `components.json`
- `src/lib/utils.ts`
- `src/components/ui/button.tsx`, `card.tsx`, `input.tsx`, `label.tsx`,
  `textarea.tsx`, `select.tsx`, `badge.tsx`, `avatar.tsx`, `alert.tsx`,
  `skeleton.tsx`, `sheet.tsx`, `dialog.tsx`, `sonner.tsx`, `separator.tsx`,
  `table.tsx` (and their `.css` where the new-york style emits them)

Modified:
- `src/app/globals.css` (token rename)
- `src/app/layout.tsx` (Toaster)
- `src/components/app/AppSidebar.tsx`
- `src/app/(app)/layout.tsx`, `src/app/(app)/admin/layout.tsx`
- `src/app/(app)/chat/page.tsx`, `chat/error.tsx`
- `src/components/ChatInterface.tsx`
- `src/components/admin/StatCard.tsx`, `Pagination.tsx`, `AuditEventList.tsx`
- `src/app/(app)/admin/page.tsx`, `analytics/page.tsx`, `audit/page.tsx`,
  `documents/page.tsx`, `users/page.tsx`, `upload/page.tsx`, `tickets/page.tsx`
- `src/app/(app)/admin/documents/recount-all-button.tsx`,
  `document-row-actions.tsx`, `preview/page.tsx`
- `src/app/(app)/admin/users/user-row-actions.tsx`
- `src/app/(app)/admin/tickets/ticket-overlay.tsx`, `ticket-drawer.tsx`
- `src/app/(app)/admin/loading.tsx`, `documents/loading.tsx`,
  `users/loading.tsx`, `audit/loading.tsx`, `tickets/loading.tsx`
- `src/app/(app)/admin/error.tsx`, `not-found.tsx`
- `src/components/marketing/*` (token rename only — no visual change)
- `src/components/react-bits/BorderGlow.tsx` (optional greyscale default)

Untouched:
- `src/app/sign-in/[[...sign-in]]/page.tsx`,
  `src/app/sign-up/[[...sign-up]]/page.tsx` (Clerk-owned)
- `src/components/ferrofluid/Ferrofluid.tsx` (white default, fine)
- `src/components/react-bits/LogoLoop.tsx` (brand logos, fine)
