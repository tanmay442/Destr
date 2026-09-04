const MAX_COLORS = 8;

let webglErrorLogged = false;

export function reportWebGLError(error: unknown): void {
  if (webglErrorLogged) return;
  webglErrorLogged = true;
  console.error(error);
}

const hexToRGB = (hex: string): [number, number, number] => {
  const c = hex.replace('#', '').padEnd(6, '0');
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  return [r, g, b];
};

export const prepColors = (input?: string[]) => {
  const base = (input && input.length ? input : ['#ffffff', '#ffffff', '#ffffff']).slice(0, MAX_COLORS);
  const count = base.length;
  const arr: [number, number, number][] = [];
  for (let i = 0; i < MAX_COLORS; i++) arr.push(hexToRGB(base[Math.min(i, base.length - 1)] ?? '#ffffff'));
  const avg: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    avg[0] += arr[i]![0];
    avg[1] += arr[i]![1];
    avg[2] += arr[i]![2];
  }
  avg[0] /= count;
  avg[1] /= count;
  avg[2] /= count;
  return { arr, count, avg };
};

export const flowVec = (d?: string): [number, number] => {
  switch (d) {
    case 'up':
      return [0, 1];
    case 'down':
      return [0, -1];
    case 'left':
      return [-1, 0];
    case 'right':
      return [1, 0];
    default:
      return [0, -1];
  }
};
