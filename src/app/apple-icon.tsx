// Apple touch icon (180x180): brand mark; larger radius reads better on iOS home screens.
import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          borderRadius: 36,
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="120"
          height="120"
          fill="none"
          stroke="#e5e5e5"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 4h16v12H7l-3 4V4z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
