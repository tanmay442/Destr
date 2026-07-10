import {
  HERO,
  FEATURES,
} from '@/components/marketing/marketing-content';

export function MarketingHero() {
  return (
    <section className="flex flex-col gap-4" data-testid="landing-left">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground-subtle">
        {HERO.eyebrow}
      </p>

      <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl sm:leading-[1.05]">
        {HERO.headline}
      </h1>

      <p className="max-w-xl text-pretty text-sm leading-relaxed text-foreground-muted">
        {HERO.subcopy}
      </p>

      <ul className="flex flex-col gap-2">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className="flex items-start gap-2 text-[13px] leading-snug"
          >
            <span
              aria-hidden
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-subtle"
            />
            <p className="text-foreground-muted">
              <span className="font-semibold text-foreground">
                {feature.title}
              </span>
              <span className="mx-1 text-foreground-faint">&mdash;</span>
              <span>{feature.description}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
