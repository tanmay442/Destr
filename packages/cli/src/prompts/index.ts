import { createInterface, type Interface } from 'node:readline';

export function makeRl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export function ask(
  rl: Interface,
  question: string,
  defaultValue: string,
): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() === '' ? defaultValue : answer.trim());
    });
  });
}

export interface PromptOption<T extends string> {
  value: T;
  label: string;
  blurb?: string;
}

export function pickFromList<T extends string>(
  rl: Interface,
  question: string,
  options: ReadonlyArray<PromptOption<T>>,
  defaultValue: T,
): Promise<T> {
  return new Promise((resolve) => {
    console.log(question);
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!;
      const marker = o.value === defaultValue ? '*' : ' ';
      const blurb = o.blurb ? ` — ${o.blurb}` : '';
      console.log(`  ${marker} ${i + 1}) ${o.label}${blurb}`);
    }
    rl.question(`Choose [1-${options.length}] (default: ${defaultValue}): `, (answer) => {
      const trimmed = answer.trim();
      if (trimmed === '') {
        resolve(defaultValue);
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      if (Number.isFinite(n) && n >= 1 && n <= options.length) {
        resolve(options[n - 1]!.value);
        return;
      }
      const match = options.find((o) => o.value === trimmed.toLowerCase());
      if (match) {
        resolve(match.value);
        return;
      }
      console.log(`  (unrecognised choice; keeping "${defaultValue}")`);
      resolve(defaultValue);
    });
  });
}

export async function askYesNo(
  rl: Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${question} (${hint}): `, (answer) => {
      const v = answer.trim().toLowerCase();
      if (v === '') resolve(defaultYes);
      else if (v === 'y' || v === 'yes') resolve(true);
      else if (v === 'n' || v === 'no') resolve(false);
      else {
        console.log(`  (unrecognised answer; using default: ${defaultYes ? 'yes' : 'no'})`);
        resolve(defaultYes);
      }
    });
  });
}

export async function askMultiLine(
  rl: Interface,
  prompt: string,
  defaultValue: string,
): Promise<string> {
  console.log(`${prompt}`);
  console.log('  (Enter a line with two dots ".." on its own to finish)');
  if (defaultValue) {
    console.log(`  (Leave empty to keep current value)`);
  }
  const lines: string[] = [];
  return new Promise((resolve) => {
    const promptLine = '  > ';
    rl.setPrompt(promptLine);
    rl.prompt();
    rl.on('line', (line) => {
      if (line.trim() === '..') {
        rl.removeAllListeners('line');
        resolve(lines.join('\n'));
        return;
      }
      lines.push(line);
      rl.prompt();
    });
  });
}
