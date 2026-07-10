import { MarketingHero } from '@/components/marketing/MarketingHero';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { MarketingAuthCard } from '@/components/marketing/MarketingAuthCard';
import { MarketingTechMarquee } from '@/components/marketing/MarketingTechMarquee';
import { MarketingQuickStart } from '@/components/marketing/MarketingQuickStart';

export default function MarketingHome() {
  return (
    <>
      <main
        data-testid="landing-main"
        className="relative flex flex-1 flex-col items-center overflow-hidden px-6 pb-32 pt-16 sm:pt-24"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-16">
          <section className="grid w-full gap-12 items-center md:grid-cols-[3fr_2fr] md:gap-14 lg:gap-20">
            <MarketingHero />

            <div
              className="flex items-center justify-center"
              data-testid="landing-right"
            >
              <MarketingAuthCard floating />
            </div>
          </section>

          <MarketingQuickStart />

          <MarketingTechMarquee />
        </div>
      </main>

      <MarketingFooter />
    </>
  );
}
