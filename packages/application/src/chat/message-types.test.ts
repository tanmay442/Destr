import { describe, expect, it } from 'vitest';
import { compactModelHistory, toChatUIMessages, type ChatInputMessage } from './message-types';

function inputMessage(id: string, role: 'user' | 'assistant', text: string): ChatInputMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

describe('compactModelHistory', () => {
  it('keeps only the newest configured number of messages', () => {
    const messages = toChatUIMessages(
      Array.from({ length: 30 }, (_, index) =>
        inputMessage(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `text-${index}`),
      ),
    );

    const compacted = compactModelHistory(messages, 4, 10_000);

    expect(compacted.map((message) => message.id)).toEqual(['m26', 'm27', 'm28', 'm29']);
  });

  it('keeps the newest message even when it alone exceeds the text budget', () => {
    const messages = toChatUIMessages([
      inputMessage('old', 'assistant', 'old'),
      inputMessage('latest', 'user', 'x'.repeat(100)),
    ]);

    expect(compactModelHistory(messages, 24, 10).map((message) => message.id)).toEqual(['latest']);
  });

  it('stops before adding an older message that exceeds the text budget', () => {
    const messages = toChatUIMessages([
      inputMessage('old', 'user', '12345'),
      inputMessage('middle', 'assistant', '67890'),
      inputMessage('latest', 'user', 'abc'),
    ]);

    expect(compactModelHistory(messages, 24, 8).map((message) => message.id)).toEqual([
      'middle',
      'latest',
    ]);
  });
});
