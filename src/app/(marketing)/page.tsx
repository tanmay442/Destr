import { MarketingHeader } from '@/components/marketing/MarketingHeader';
import { MarketingCard } from '@/components/marketing/MarketingCard';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { MarketingHero } from '@/components/marketing/MarketingHero';

export default function MarketingHome() {
  return (
    <>
      <MarketingHeader />

      <main
        className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-16 sm:py-24"
        data-testid="landing-main"
      >
        <div className="grid w-full max-w-6xl grid-cols-1 gap-12 md:grid-cols-[3fr_2fr] md:gap-14 lg:gap-20">
          <MarketingHero />

          <section
            className="flex items-center"
            data-testid="landing-right"
          >
            <MarketingCard />
          </section>
        </div>
      </main>

      <MarketingFooter />
    </>
  );
}
