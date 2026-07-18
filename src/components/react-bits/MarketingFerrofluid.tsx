'use client';

import dynamic from 'next/dynamic';

const Ferrofluid = dynamic(() => import('@/components/react-bits/Ferrofluid'), {
  ssr: false,
  loading: () => null,
});

export function MarketingFerrofluid() {
  return (
    <Ferrofluid
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
  );
}
