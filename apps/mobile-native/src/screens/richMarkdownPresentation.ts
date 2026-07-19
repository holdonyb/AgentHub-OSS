export type MarkdownSpan =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; spans: MarkdownSpan[] }
  | { kind: 'unordered_list'; items: MarkdownSpan[][] }
  | { kind: 'ordered_list'; items: MarkdownSpan[][] }
  | { kind: 'code_block'; language: string; text: string };

function appendText(spans: MarkdownSpan[], text: string) {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous?.kind === 'text') {
    previous.text += text;
    return;
  }
  spans.push({ kind: 'text', text });
}

function isSafeLink(value: string) {
  return /^https?:\/\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
}

function readBalancedLink(value: string, start: number): { end: number; label: string; url: string } | null {
  const labelEnd = value.indexOf('](', start + 1);
  if (labelEnd < 0) return null;
  let depth = 1;
  let cursor = labelEnd + 2;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0) {
      return {
        end: cursor + 1,
        label: value.slice(start + 1, labelEnd),
        url: value.slice(labelEnd + 2, cursor).trim(),
      };
    }
    cursor += 1;
  }
  return null;
}

export function parseMarkdownSpans(value: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value.startsWith('**', cursor)) {
      const end = value.indexOf('**', cursor + 2);
      if (end > cursor + 2) {
        spans.push({ kind: 'strong', text: value.slice(cursor + 2, end) });
        cursor = end + 2;
        continue;
      }
    }
    if (value[cursor] === '`') {
      const end = value.indexOf('`', cursor + 1);
      if (end > cursor + 1) {
        spans.push({ kind: 'code', text: value.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }
    if (value[cursor] === '[') {
      const link = readBalancedLink(value, cursor);
      if (link) {
        if (isSafeLink(link.url)) spans.push({ kind: 'link', text: link.label, url: link.url });
        else appendText(spans, link.label);
        cursor = link.end;
        continue;
      }
    }
    const specialIndex = [value.indexOf('**', cursor + 1), value.indexOf('`', cursor + 1), value.indexOf('[', cursor + 1)]
      .filter((index) => index >= 0)
      .reduce((nearest, index) => Math.min(nearest, index), value.length);
    appendText(spans, value.slice(cursor, specialIndex));
    cursor = specialIndex;
  }
  return spans;
}

function isBlockStart(line: string) {
  return /^(#{1,6})\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^```/.test(line);
}

export function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const codeMatch = line.match(/^```([^\s]*)\s*$/);
    if (codeMatch) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code_block', language: codeMatch[1] ?? '', text: codeLines.join('\n') });
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ kind: 'heading', level: headingMatch[1]?.length ?? 1, text: headingMatch[2] ?? '' });
      index += 1;
      continue;
    }
    const unorderedMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      const items: MarkdownSpan[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^\s*[-*+]\s+(.*)$/);
        if (!match) break;
        items.push(parseMarkdownSpans(match[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'unordered_list', items });
      continue;
    }
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (orderedMatch) {
      const items: MarkdownSpan[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^\s*\d+[.)]\s+(.*)$/);
        if (!match) break;
        items.push(parseMarkdownSpans(match[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'ordered_list', items });
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !isBlockStart(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseMarkdownSpans(paragraphLines.join('\n')) });
  }
  return blocks;
}
