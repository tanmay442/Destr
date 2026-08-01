import { MarketingHero } from '@/components/marketing/MarketingHero';
import { MarketingAuthCard } from '@/components/marketing/MarketingAuthCard';
import { MarketingTechMarquee } from '@/components/marketing/MarketingTechMarquee';
import { MarketingQuickStart } from '@/components/marketing/MarketingQuickStart';

export default function MarketingHome() {
  return (
    <>
      <main
        data-testid="landing-main"
        className="relative flex flex-1 flex-col items-center overflow-x-clip px-5 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-20"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-14 sm:gap-16">
          <section className="grid w-full items-center gap-10 md:grid-cols-[3fr_2fr] md:gap-12 lg:gap-16">
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
    </>
  );
}
