import {
  HERO,
  FEATURES,
} from '@/components/marketing/marketing-content';

export function MarketingHero() {
  return (
    <section className="flex flex-col gap-5" data-testid="landing-left">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {HERO.eyebrow}
      </p>

      <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl sm:leading-[1.05] md:text-5xl">
        {HERO.headline}
      </h1>

      <p className="max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
        {HERO.subcopy}
      </p>

      <ul className="flex flex-col gap-2.5">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className="flex items-start gap-2.5 text-[13px] leading-snug sm:text-sm"
          >
            <span
              aria-hidden
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-subtle"
            />
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">
                {feature.title}
              </span>
              <span className="mx-1.5 text-foreground-faint" aria-hidden>
                &mdash;
              </span>
              <span>{feature.description}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
