export interface Section {
  title: string | null;
  text: string;
}

/** Heuristic heading detection used to split a page into titled sections. */
function looksLikeTitlePhrase(value: string): boolean {
  if (/[“”"()[\]{}]/.test(value)) return false;
  const words = value.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (words.length === 0) return false;
  const structuralSingleWords = new Set([
    'appendix',
    'conclusion',
    'introduction',
    'overview',
    'references',
    'summary',
  ]);
  if (words.length === 1) return structuralSingleWords.has(words[0]!.toLowerCase());
  const minorWords = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
  let capitalized = 0;
  for (const word of words) {
    if (minorWords.has(word.toLowerCase())) continue;
    if (word[0] !== word[0]!.toUpperCase()) return false;
    capitalized++;
  }
  return capitalized >= 2;
}

export function isHeadingLine(line: string, prevBlank = true): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/[.!?]$/.test(t)) return false;
  const numbered = t.match(/^\d+(?:\.\d+)*\.?(?=\s+[A-Z])/);
  if (numbered) {
    const components = numbered[0].replace(/\.$/, '').split('.');
    if (components.length > 1) return components.every((c) => c.length <= 2);
    const title = t.slice(numbered[0].length).trim();
    return Number(components[0]) < 20 && looksLikeTitlePhrase(title);
  }
  if (/^[A-Z][A-Za-z0-9' ]{2,}:\s*$/.test(t) && prevBlank) {
    return looksLikeTitlePhrase(t.replace(/:\s*$/, ''));
  }
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3 || t !== t.toUpperCase() || /[a-z]/.test(t)) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (!prevBlank) {
    if (/\s/.test(t)) return false;
    if (!t.includes('_')) return false;
  }
  return true;
}

/** Drop orphaned bullet/number artifact lines; keep any line with a letter.
 *  A line of only digits/punctuation is kept when it is a multi-value numeric
 *  row (e.g. whitespace-column tables like `19.99  29.99`) so legitimate data
 *  tables survive; lone artifacts (`•`, `-`, `1.`) are stripped. */
export function cleanTextArtifacts(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/[a-zA-Z]/.test(trimmed)) return true;
      const isArtifactOnly = /^[0-9\s.\-◦▪•\*]+$/.test(trimmed);
      if (!isArtifactOnly) return true;
      return trimmed.split(/\s+/).filter(Boolean).length >= 2;
    })
    .join('\n')
    .trim();
}

/** Split a single page's text into titled sections at heading boundaries. */
export function buildSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (body.length > 0) sections.push({ title: currentTitle, text: body });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.length === 0) {
      currentLines.push('');
      continue;
    }
    const prevBlank = i === 0 || lines[i - 1]!.trim().length === 0;
    if (isHeadingLine(line, prevBlank)) {
      flush();
      currentTitle = t.replace(/^#+\s+/, '').replace(/:\s*$/, '').trim() || null;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

/** Merge consecutive sections shorter than `minLen` into the previous one. */
export function mergeShortSections(sections: Section[], minLen: number): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (s.text.length < minLen && last) {
      last.text = (last.text + '\n\n' + (s.title ? s.title + '\n' : '') + s.text).trim();
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Merge paragraphs shorter than `minLen` into the preceding paragraph. */
export function mergeShortParagraphs(
  paragraphs: Array<{ text: string; start: number }>,
  minLen: number,
): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  for (const p of paragraphs) {
    const last = out[out.length - 1];
    if (p.text.length < minLen && last) {
      last.text = (last.text + '\n\n' + p.text).trim();
    } else {
      out.push({ ...p });
    }
  }
  return out;
}
