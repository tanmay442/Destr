import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LineChart } from './Charts';

describe('LineChart', () => {
  it('renders a tasteful empty state with no data', () => {
    const { container, getByText } = render(<LineChart data={[]} />);
    expect(getByText(/no data yet/i)).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a horizontal line for a single point without NaN', () => {
    const { container } = render(<LineChart data={[{ label: 'W1', value: 0.42 }]} />);
    const paths = Array.from(container.querySelectorAll('path'));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.getAttribute('d') ?? '').not.toContain('NaN');
    }
  });

  it('handles an all-zero series without NaN in the path', () => {
    const data = [
      { label: 'W1', value: 0 },
      { label: 'W2', value: 0 },
      { label: 'W3', value: 0 },
    ];
    const { container } = render(<LineChart data={data} />);
    const paths = Array.from(container.querySelectorAll('path'));
    for (const p of paths) {
      expect(p.getAttribute('d') ?? '').not.toContain('NaN');
    }
  });

  it('draws a threshold marker and flags exceedance via destructive color', () => {
    const data = [
      { label: 'W1', value: 0.02 },
      { label: 'W2', value: 0.08 },
    ];
    const { container } = render(
      <LineChart data={data} percentage threshold={0.05} thresholdClassName="text-destructive" />,
    );
    const dashed = container.querySelector('line[stroke-dasharray]');
    expect(dashed).not.toBeNull();
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-destructive');
  });
});
