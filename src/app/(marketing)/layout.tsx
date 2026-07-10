import Ferrofluid from '@/components/react-bits/Ferrofluid';

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
          <Ferrofluid
            colors={['#ffffff', '#ffffff', '#ffffff']}
            speed={0.33}
            scale={1.6}
            turbulence={1}
            fluidity={0.1}
            rimWidth={0.175}
            sharpness={2.5}
            shimmer={1.15}
            glow={2}
            flowDirection="down"
            opacity={1}
            mouseInteraction={true}
            mouseStrength={1}
            mouseRadius={0.3}
          />
        </div>
      </div>
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
