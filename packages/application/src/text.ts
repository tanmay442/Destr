/** Keep the head of `value` up to `max` Unicode code points, never splitting surrogate pairs. */
export function capCodePoints(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join('') : value;
}
