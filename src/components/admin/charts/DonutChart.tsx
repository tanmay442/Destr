import * as React from "react";

type Segment = { label: string; value: number; stroke: string };

export function DonutChart({
  segments,
  size = 168,
  thickness = 16,
  children,
}: {
  segments: Segment[];
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const label =
    `Donut chart: ` +
    segments
      .map((s) => `${s.label} ${total > 0 ? Math.round((s.value / total) * 100) : 0}%`)
      .join(", ");
  let offset = 0;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
        role="img"
        aria-label={label}
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            className="stroke-border-subtle"
            strokeWidth={thickness}
          />
          {total > 0 &&
            segments.map((seg, i) => {
              const length = (seg.value / total) * circumference;
              const node = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  className={seg.stroke}
                  strokeWidth={thickness}
                  strokeLinecap="round"
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return node;
            })}
        </g>
      </svg>
      <ul className="sr-only">
        {segments.map((seg) => (
          <li key={seg.label}>
            {seg.label}: {seg.value}
          </li>
        ))}
      </ul>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}
