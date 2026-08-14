import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { ask, askMultiLine, askYesNo, pickFromList } from '../prompts/index';

function makeRl() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on('data', () => {});
  return { rl: createInterface({ input, output }), input };
}

describe('ask', () => {
  it('resolves with the typed answer', async () => {
    const { rl, input } = makeRl();
    const p = ask(rl, 'Name', 'default');
    input.write('typed\n');
    await expect(p).resolves.toBe('typed');
    rl.close();
  });

  it('resolves with the default value on EOF', async () => {
    const { rl, input } = makeRl();
    const p = ask(rl, 'Name', 'default');
    input.end();
    await expect(p).resolves.toBe('default');
    rl.close();
  });
});

describe('pickFromList', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];

  it('resolves with the chosen option', async () => {
    const { rl, input } = makeRl();
    const p = pickFromList(rl, 'Pick', options, 'a');
    input.write('2\n');
    await expect(p).resolves.toBe('b');
    rl.close();
  });

  it('resolves with the default selection on EOF', async () => {
    const { rl, input } = makeRl();
    const p = pickFromList(rl, 'Pick', options, 'b');
    input.end();
    await expect(p).resolves.toBe('b');
    rl.close();
  });
});

describe('askYesNo', () => {
  it('resolves with the default on EOF', async () => {
    const { rl, input } = makeRl();
    const p = askYesNo(rl, 'Sure?', true);
    input.end();
    await expect(p).resolves.toBe(true);
    rl.close();
  });
});

describe('askMultiLine', () => {
  it('collects lines until the ".." terminator', async () => {
    const { rl, input } = makeRl();
    const p = askMultiLine(rl, 'Custom', '');
    input.write('first\n');
    input.write('second\n');
    input.write('..\n');
    await expect(p).resolves.toBe('first\nsecond');
    rl.close();
  });

  it('resolves with the collected lines on EOF', async () => {
    const { rl, input } = makeRl();
    const p = askMultiLine(rl, 'Custom', '');
    input.write('first\n');
    input.write('second\n');
    input.end();
    await expect(p).resolves.toBe('first\nsecond');
    rl.close();
  });

  it('resolves with an empty string on immediate EOF', async () => {
    const { rl, input } = makeRl();
    const p = askMultiLine(rl, 'Custom', '');
    input.end();
    await expect(p).resolves.toBe('');
    rl.close();
  });
});
