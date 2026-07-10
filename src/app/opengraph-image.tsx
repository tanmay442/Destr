// Open Graph share image (1200x630); used by social link previews.
import { ImageResponse } from 'next/og';

export const alt = 'RAG Support';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          gap: 32,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 120,
            height: 120,
            borderRadius: 28,
            background: '#141414',
            border: '2px solid #e5e5e5',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="72"
            height="72"
            fill="none"
            stroke="#e5e5e5"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 4h16v12H7l-3 4V4z" />
          </svg>
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 96,
            fontWeight: 600,
            color: '#f3f4f8',
            letterSpacing: '-0.02em',
          }}
        >
          RAG Support
        </div>
      </div>
    ),
    { ...size },
  );
}
