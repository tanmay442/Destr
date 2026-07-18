import { MarketingFerrofluid } from '@/components/react-bits/MarketingFerrofluid';

// Marketing route group. Passthrough layout; future pages pick up shared chrome here.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
      >
        <div className="h-full w-full">
          <MarketingFerrofluid />
        </div>
      </div>
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
