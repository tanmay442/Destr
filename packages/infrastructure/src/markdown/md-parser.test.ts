import { describe, it, expect } from 'vitest';
import { markdownParser, DEFAULT_MD_CHUNK_DELIMITER } from './md-parser';

const SAMPLE = `---chunk---
title: Getting Started
page: 1

Welcome to our product. Set up your account in under 5 minutes.
---chunk---
title: Authentication
page: 2

We support OAuth 2.0, SAML SSO, and API key auth.
`;

describe('markdownParser', () => {
  it('parses delimiter-separated chunks with metadata', () => {
    const chunks = markdownParser.parseChunkedMarkdown(SAMPLE);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      sectionTitle: 'Getting Started',
      page: 1,
      content: 'Welcome to our product. Set up your account in under 5 minutes.',
    });
    expect(chunks[1]).toMatchObject({
      sectionTitle: 'Authentication',
      page: 2,
      content: 'We support OAuth 2.0, SAML SSO, and API key auth.',
    });
  });

  it('treats content before the first delimiter as chunk 0', () => {
    const md = `Intro text without a delimiter.
---chunk---
title: Second
page: 2

Body.`;
    const chunks = markdownParser.parseChunkedMarkdown(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content).toBe('Intro text without a delimiter.');
    expect(chunks[1]!.sectionTitle).toBe('Second');
  });

  it('skips whitespace-only and empty chunks', () => {
    const md = `---chunk---
title: A
page: 1

Body A
---chunk---

---chunk---

---chunk---
title: B
page: 2

Body B
`;
    const chunks = markdownParser.parseChunkedMarkdown(md);
    expect(chunks.map((c) => c.sectionTitle)).toEqual(['A', 'B']);
  });

  it('maps source: to source and ignores unknown keys', () => {
    const md = `---chunk---
title: Doc
page: 3
source: manual.pdf
author: Jane

Content here.`;
    const chunks = markdownParser.parseChunkedMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sectionTitle: 'Doc',
      page: 3,
      source: 'manual.pdf',
      content: 'Content here.',
    });
  });

  it('drops an unparseable page value', () => {
    const md = `---chunk---
title: X
page: not-a-number

Body.`;
    const chunks = markdownParser.parseChunkedMarkdown(md);
    expect(chunks[0]!.page).toBeNull();
    expect(chunks[0]!.sectionTitle).toBe('X');
  });

  it('honors a custom delimiter', () => {
    const md = `===SEP===
title: One

A
===SEP===
title: Two

B`;
    const chunks = markdownParser.parseChunkedMarkdown(md, '===SEP===');
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.sectionTitle).toBe('Two');
  });

  it('escapes regex-special characters in the delimiter', () => {
    const chunks = markdownParser.parseChunkedMarkdown('a\n---.chunk.---\nb', '---.chunk.---');
    expect(chunks).toHaveLength(2);
  });

  it('uses the default delimiter constant', () => {
    expect(DEFAULT_MD_CHUNK_DELIMITER).toBe('---chunk---');
  });

  it('does not split on a delimiter line inside a fenced code block', () => {
    const md = `---chunk---
title: A
page: 1

\`\`\`
---chunk---
code inside fence
\`\`\`

Body A
---chunk---
title: B
page: 2

Body B`;
    const chunks = markdownParser.parseChunkedMarkdown(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionTitle).toBe('A');
    expect(chunks[0]!.content).toContain('---chunk---');
    expect(chunks[0]!.content).toContain('code inside fence');
    expect(chunks[1]!.sectionTitle).toBe('B');
  });
});
