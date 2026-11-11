// Markdown in: what a paste of Markdown text becomes (ARCHITECTURE.md, Clipboard: our format,
// then HTML through the schema, then Markdown, then plain text). Covers what `toMarkdown` writes:
// headings, lists and to-dos with nesting, quotes, code fences, dividers, tables, and the marks
// bold, italic, strike, code, underline and links. Links go through the scheme allow-list.
import type { DocJSON } from './binding';
import { newBlockId } from './ids';
import { safeHref } from './schema';

type Mark = { type: string; attrs?: Record<string, unknown> };

/** Inline Markdown to text nodes with marks. */
export function parseInline(source: string, marks: Mark[] = []): DocJSON[] {
  const out: DocJSON[] = [];
  let text = '';
  const flush = () => {
    if (!text) return;
    out.push(marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });
    text = '';
  };
  const wrapped = (open: string, close: string, at: number) => {
    if (!source.startsWith(open, at)) return null;
    const end = source.indexOf(close, at + open.length);
    if (end <= at + open.length) return null;
    const inner = source.slice(at + open.length, end);
    if (/^\s|\s$/.test(inner)) return null;
    return { inner, next: end + close.length };
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length && /[\\`*_[\]~<>|#!-]/.test(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const fence = source.startsWith('``', i) ? '``' : '`';
      const end = source.indexOf(fence, i + fence.length);
      if (end > i) {
        flush();
        const code = source.slice(i + fence.length, end);
        if (code)
          out.push({
            type: 'text',
            text: code,
            marks: [...marks.filter((m) => m.type === 'link'), { type: 'code' }],
          });
        i = end + fence.length;
        continue;
      }
    }
    if (ch === '[') {
      const close = source.indexOf('](', i);
      // The target may hold balanced parentheses: [a](https://x.y/a_(b)).
      let end = -1;
      if (close > i)
        for (let j = close + 2, depth = 0; j < source.length; j++) {
          if (source[j] === '(') depth++;
          else if (source[j] === ')' && depth-- === 0) {
            end = j;
            break;
          }
        }
      if (close > i && end > close) {
        const label = source.slice(i + 1, close);
        const href = safeHref(decodeURIComponentSafe(source.slice(close + 2, end).trim()));
        flush();
        out.push(
          ...parseInline(label, href ? [...marks, { type: 'link', attrs: { href } }] : marks),
        );
        i = end + 1;
        continue;
      }
    }
    let matched = false;
    for (const [open, close, type] of [
      ['**', '**', 'bold'],
      ['__', '__', 'bold'],
      ['~~', '~~', 'strike'],
      ['<u>', '</u>', 'underline'],
      ['*', '*', 'italic'],
      ['_', '_', 'italic'],
    ] as const) {
      const found = wrapped(open, close, i);
      if (!found) continue;
      // `_` inside a word is not emphasis (snake_case).
      if (open === '_' && i > 0 && /\w/.test(source[i - 1])) continue;
      flush();
      out.push(...parseInline(found.inner, [...marks, { type }]));
      i = found.next;
      matched = true;
      break;
    }
    if (matched) continue;
    text += ch;
    i++;
  }
  flush();
  return out;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const block = (body: DocJSON, children: DocJSON[] = []): DocJSON => ({
  type: 'block',
  attrs: { id: newBlockId() },
  content: [body, ...children],
});

const textBody = (kind: string, inline: string, attrs: Record<string, unknown> = {}): DocJSON => {
  const content = parseInline(inline);
  return { type: 'textBody', attrs: { kind, ...attrs }, ...(content.length ? { content } : {}) };
};

const indentOf = (line: string) => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
};

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

/** Markdown text to a document's JSON. Blocks get fresh ids: this is a local creation. */
export function parseMarkdown(markdown: string): DocJSON {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const root: DocJSON[] = [];
  // Open list items, by indent, so deeper items become their children.
  const stack: { indent: number; children: DocJSON[] }[] = [];
  const target = (indent: number): DocJSON[] => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack.length ? stack[stack.length - 1].children : root;
  };
  let paragraph: string[] = [];
  let paragraphIndent = 0;
  const endParagraph = () => {
    if (!paragraph.length) return;
    target(paragraphIndent).push(block(textBody('paragraph', paragraph.join(' '))));
    paragraph = [];
  };
  const pushItem = (indent: number, body: DocJSON) => {
    endParagraph();
    const item = block(body);
    target(indent).push(item);
    // Deeper lines become this item's children, after its body.
    stack.push({ indent, children: item.content! });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (!trimmed) {
      endParagraph();
      continue;
    }
    const fence = /^(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(trimmed);
    if (fence) {
      endParagraph();
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trim().startsWith(fence[1]); j++)
        code.push(lines[j].slice(Math.min(indent, indentOf(lines[j]))));
      const source = code.join('\n');
      target(indent).push(
        block({
          type: 'codeBlock',
          attrs: { language: fence[2] || null },
          ...(source ? { content: [{ type: 'text', text: source }] } : {}),
        }),
      );
      i = j;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      endParagraph();
      target(indent).push(
        block(textBody('heading', heading[2], { level: Math.min(3, heading[1].length) })),
      );
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      endParagraph();
      target(indent).push(block({ type: 'divider' }));
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      endParagraph();
      const rows = [splitRow(trimmed)];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++)
        rows.push(splitRow(lines[j]));
      const width = Math.max(...rows.map((r) => r.length));
      target(indent).push(
        block({
          type: 'table',
          attrs: { headerRow: rows[0].some((cell) => cell !== '') },
          content: rows.map((cells) => ({
            type: 'tableRow',
            content: Array.from({ length: width }, (_, c) => {
              const content = parseInline(cells[c] ?? '');
              return { type: 'tableCell', ...(content.length ? { content } : {}) };
            }),
          })),
        }),
      );
      i = j - 1;
      continue;
    }
    const check = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (check) {
      pushItem(
        indent,
        textBody('checkItem', check[2], { checked: check[1].toLowerCase() === 'x' }),
      );
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      pushItem(indent, textBody('bulletItem', bullet[1]));
      continue;
    }
    const numbered = /^(\d{1,9})[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      pushItem(indent, textBody('numberedItem', numbered[2]));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      endParagraph();
      const parts = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]))
        parts.push(lines[++i].trim().replace(/^>\s?/, ''));
      const content: DocJSON[] = [];
      parts.forEach((part, n) => {
        if (n) content.push({ type: 'hardBreak' });
        content.push(...parseInline(part));
      });
      target(indent).push(
        block({
          type: 'textBody',
          attrs: { kind: 'quote' },
          ...(content.length ? { content } : {}),
        }),
      );
      continue;
    }
    // A plain line: part of a paragraph; under a list item when indented beneath it.
    if (!paragraph.length) paragraphIndent = indent;
    paragraph.push(trimmed);
  }
  endParagraph();
  return { type: 'doc', content: root };
}

/** Whether pasted plain text reads as Markdown, rather than prose with a stray asterisk. */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let hits = 0;
  for (const line of lines) {
    const t = line.trim();
    if (
      /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\|)/.test(t) ||
      /^([-*_])(\s*\1){2,}$/.test(t)
    )
      hits++;
    else if (/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|~~[^~]+~~)/.test(t)) hits++;
  }
  return hits > 0 && (lines.length === 1 ? hits === 1 : hits >= 1);
}
