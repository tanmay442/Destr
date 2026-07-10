# Plan: Ferrofluid Background + Tailwind-only Migration + Frontend Restructure

## Goal

1. Integrate the React Bits **Ferrofluid** component as the background of the **marketing landing page only**.
2. Migrate the entire frontend to **Tailwind-only** styling — discard custom CSS files and inline `var(--...)` usage.
3. **Aggressively restructure** the frontend folder layout into a cleaner, route-group-aligned structure.

Decisions confirmed with the user:
- **CSS scope:** app-wide Tailwind-only (move design tokens into `@theme`, convert all `var()` usages + `.chat-markdown` / `.reveal` / scrollbar / focus styles).
- **Ferrofluid theme:** white rim (as in the usage example).
- **Restructure:** more aggressive than minimal/additive.

---

## 1. Aggressive folder restructure — DO THIS FIRST

> Restructure the frontend layout **before** adding the component, so the new
> component lands in the already-clean folder structure.

- Rename + realign `src/components/landing/` → `src/components/marketing/`:
  - `LandingHeader.tsx` → `MarketingHeader.tsx`
  - `LandingCard.tsx` → `MarketingCard.tsx`
  - `LandingFooter.tsx` → `MarketingFooter.tsx`
- Extract the hero `<section>` (`landing-left`) into `src/components/marketing/MarketingHero.tsx`; slim `page.tsx` to compose `MarketingHero` + `MarketingCard`.
- Update the 3 imports in `src/app/(marketing)/page.tsx`.
- Leave `components/icons/`, `components/admin/`, `components/app/` and route groups as-is.

Resulting structure:
```
src/components/
  marketing/{MarketingHeader,MarketingCard,MarketingFooter,MarketingHero}.tsx
  app/{AppSidebar,ChatInterface}.tsx
  admin/*.tsx
  icons/{BrandMark,GithubIcon}.tsx
```

---

## 2. Add the Ferrofluid component via shadcn (react-bits)

- Install with the shadcn CLI (this also pulls `ogl` as a dependency):
  ```bash
  pnpm dlx shadcn@latest add @react-bits/Ferrofluid-JS-CSS
  ```
- The CLI scaffolds the component (and its `Ferrofluid.css`) into the shadcn
  components dir (typically `src/components/ui/ferrofluid` or similar — confirm
  the printed path). Locate the generated `Ferrofluid.tsx`.
- Make it Tailwind-only (no custom CSS file):
  - **Delete** the `import './Ferrofluid.css';` (and remove/port the `.ferrofluid-container` rule into Tailwind classes).
  - **Inline** the container style via Tailwind classes:
    ```tsx
    <div
      ref={containerRef}
      className={`ferrofluid-container relative h-full w-full overflow-hidden ${className ?? ''}`}
      style={mixBlendMode ? { mixBlendMode } : undefined}
    />
    ```
  - Mark the file `'use client'` if not already.
  - Keep `colors` defaulting to white (`['#ffffff', '#ffffff', '#ffffff']`) per decision.
  - Preserve every prop/uniform (speed, scale, turbulence, fluidity, rimWidth, sharpness, shimmer, glow, flowDirection, opacity, mouseInteraction, mouseStrength, mouseRadius, mouseDampening, mixBlendMode, paused, dpr, className).
- **Accessibility:** respect `prefers-reduced-motion`. If the user prefers reduced motion, render with `paused` so the canvas freezes:
  ```tsx
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
  }, []);
  // use paused={paused || reduced}
  ```

---

## 3. Mount the background on the marketing route only

- Edit `src/app/(marketing)/layout.tsx` to render Ferrofluid as a fixed, full-bleed, non-interactive backdrop. This covers the landing page and any future marketing pages, and nothing else (admin/chat are untouched).
  ```tsx
  import Ferrofluid from '@/components/ferrofluid/Ferrofluid';

  export default function MarketingLayout({ children }: { children: React.ReactNode }) {
    return (
      <div className="flex flex-1 flex-col">
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
          <div className="h-full w-full">
            <Ferrofluid
              colors={['#ffffff', '#ffffff', '#ffffff']}
              speed={0.5}
              scale={1.6}
              flowDirection="down"
              opacity={1}
            />
          </div>
        </div>
        {children}
      </div>
    );
  }
  ```
- Edit `src/app/(marketing)/page.tsx`:
  - Remove the redundant inline gradient/grid background `div` (currently lines 38–59) — Ferrofluid is now the backdrop.
  - Optionally keep a thin Tailwind `bg-[radial-gradient(...)]` scrim behind the text for legibility if contrast suffers.

---

## 4. App-wide Tailwind-only migration

Target: `globals.css` should contain only `@import "tailwindcss"` + the `@theme inline` token block + a minimal `@layer base` for pseudo-element/native-element styles that cannot be utilities.

### 4a. Tokens
- The existing `@theme inline` block (lines 49–70) already maps every semantic color (`--color-foreground`, `--color-surface`, `--color-accent`, etc.). Keep it. These now become first-class Tailwind utilities (`text-foreground`, `bg-surface`, `text-accent`, `ring-ring`, …).

### 4b. Convert `var(--x)` usages
- Across all 34 files, replace arbitrary `var()` classes with semantic utilities:
  - `text-[var(--foreground)]` → `text-foreground`
  - `text-[var(--foreground-muted)]` → `text-foreground-muted`
  - `bg-[var(--surface)]` → `bg-surface`
  - `border-[var(--border-subtle)]` → `border-border-subtle`
  - `bg-[var(--surface-sunken)]` → `bg-surface-sunken`
  - `text-[var(--accent)]` → `text-accent`
  - `bg-[var(--accent)]` → `bg-accent`
  - `shadow-[var(--accent)]/25` → `shadow-accent/25` (Tailwind v4 supports `shadow-accent/25`)
  - `ring-[var(--ring)]` → `ring-ring`
  - duration/easing arbitrary values like `duration-[var(--dur-fast)]` → `duration-150` (or keep a token), `ease-[var(--ease-out-quart)]` → `ease-out` (or define `--ease-*` in `@theme`).
  - Repeat for `--foreground-subtle`, `--foreground-faint`, `--border`, `--border-strong`, `--accent-hover`, `--accent-pressed`, `--accent-foreground`, `--success`, `--danger`, `--warning`.

### 4c. `.chat-markdown`
- Rewrite the `.chat-markdown` block (lines 148–237) using `@apply` under `@layer components`, keeping the `.chat-markdown` class name so `ChatInterface.tsx` needs no change:
  ```css
  @layer components {
    .chat-markdown p { @apply mb-2; }
    .chat-markdown p:last-child { @apply mb-0; }
    .chat-markdown strong { @apply font-semibold text-foreground; }
    .chat-markdown em { @apply italic; }
    .chat-markdown ul, .chat-markdown ol { @apply my-2 pl-6; }
    .chat-markdown li { @apply my-0.5; }
    .chat-markdown blockquote { @apply my-2 border-l-2 border-accent rounded-r-lg bg-surface-sunken px-3 py-1.5 text-foreground-muted; }
    .chat-markdown code { @apply rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[0.88em] text-accent; }
    .chat-markdown pre { @apply my-2 overflow-x-auto rounded-lg border border-border-subtle bg-surface-sunken p-3; }
    .chat-markdown pre code { @apply bg-none p-0 text-foreground; }
    .chat-markdown a { @apply text-accent underline underline-offset-2 hover:text-accent-hover; }
    .chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { @apply font-semibold; }
    .chat-markdown h1 { @apply text-[1.15em]; }
    .chat-markdown h2 { @apply text-[1.05em]; }
    .chat-markdown h3 { @apply text-[1em]; }
    .chat-markdown hr { @apply my-2 border-t border-border-subtle; }
    .chat-markdown table { @apply my-2 border-collapse text-[0.9em]; }
    .chat-markdown th, .chat-markdown td { @apply border border-border-subtle px-2 py-1 text-left; }
    .chat-markdown th { @apply bg-surface-sunken font-semibold; }
  }
  ```
- No new dependency (avoids `@tailwindcss/typography`).

### 4d. `.reveal` animation
- Move keyframes + animation into `@theme` so it becomes a utility:
  ```css
  @theme {
    --animate-reveal: impex-fade-up var(--dur-slow) var(--ease-out-quart) both;
    @keyframes impex-fade-up {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  }
  ```
- Replace `className="reveal"` usages with `animate-reveal`. Keep the `prefers-reduced-motion` guard (lines 138–146) minimal.

### 4e. Scrollbar + focus ring (minimal unavoidable base)
- Keep a small `@layer base` block for things utilities can't express:
  - `::-webkit-scrollbar` styling (Tailwind has no scrollbar pseudo-element utilities).
  - `:where(button, a, input, textarea, [role="button"], [tabindex]):focus-visible` two-layer ring — or convert to a reusable utility class via `@apply`:
    ```css
    @layer components {
      .focus-ring { @apply outline-none ring-2 ring-ring ring-offset-2 ring-offset-background rounded-md; }
    }
    ```
    (Apply `.focus-ring` where needed, or keep the `:where(...)` global rule — your call; global rule is less churn.)

### 4f. Inline `style={{ backgroundImage: ... }}`
- `src/app/(marketing)/page.tsx` (lines 47–57 grid) and `src/components/marketing/MarketingCard.tsx` (accent glow): replace with Tailwind arbitrary utilities, e.g. `bg-[radial-gradient(circle_at_center,var(--accent)_0%,transparent_65%)]` / `bg-[linear-gradient(...)]`. These are Tailwind arbitrary values (not custom CSS files) and are acceptable.

---

## 5. Verify

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build` (or `pnpm dev`) to visually confirm the WebGL Ferrofluid background on `/` and confirm admin/chat are unchanged.
- Optional: `pnpm arch` (dependency-cruiser) for structure sanity.

---

## Risks / notes

- WebGL canvas is client-only (created in `useEffect`), so there is no SSR/hydration problem.
- White rim on the dark `#03010A` Ferrofluid base fits the existing graphite theme; a Tailwind scrim guards text contrast if needed.
- The `@layer base` scrollbar + focus block is the only remaining raw CSS — pseudo-elements and native focus rings have no Tailwind utility equivalent. Everything else becomes Tailwind.
- `ogl` adds bundle weight to the marketing route only (component is dynamically rendered there).
