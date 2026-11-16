// Markdown in: what a paste of Markdown text becomes (ARCHITECTURE.md, Clipboard: our format,
// then HTML through the schema, then Markdown, then plain text), and what an import reads
// (Phase 8: a Markdown folder, a Notion export). Covers what `toMarkdown` writes: headings, lists
// and to-dos with nesting, quotes, code fences, dividers, tables, bookmarks (`<url>` alone on a
// line), and the marks bold, italic, strike, code, underline and links; hard breaks (two spaces
// or `\` at a line's end) and `===` headings. Links go through the scheme allow-list.
//
// An import passes `MarkdownInOptions`: links and images are resolved by it (pages, files and
// images of the import), a line that is only a link may become a child page, an inline database
// or a file, and the HTML Notion writes is read (`<aside>` as a callout, `<details>` as a toggle,
// `<br>` and the inline tags); front matter, other HTML and `$$` equations are taken out and noted.
import type { DocJSON } from './binding';
import { newBlockId } from './ids';
import { safeHref } from './schema';

type Mark = { type: string; attrs?: Record<string, unknown> };

/** What an import's link resolver answers for a link (`MarkdownInOptions.link`). */
export type LinkAnswer =
  /** A mention of the page (it draws the page's title). */
  | { mention: string; blockId?: string | null }
  /** The link mark to a page of the workspace (`#/p/…`), its text kept. */
  | { page: string; blockId?: string | null }
  /** Alone on a line: a child page block; in a line, a mention. */
  | { childPage: string }
  /** Alone on a line: an inline database (a database view block); in a line, a mention. */
  | { databaseView: string }
  /** An attachment: a file block (alone, or after the line that links it, its text kept). */
  | { file: string }
  /** A link mark to this address, if the allow-list takes it. */
  | { href: string }
  /** Not a link: its text only. */
  | null;

/** Something an import reads and does not keep, or keeps only in part. */
export type MarkdownNote =
  | 'html'
  | 'frontMatter'
  | 'equation'
  | 'externalImage'
  | 'missingImage'
  | 'tooDeep'
  /** Lines past `maxBlocks` blocks were left out. */
  | 'tooManyBlocks';

export interface MarkdownInOptions {
  /** A link's target, as written (URL-decoded once), its text, and whether it is alone on a line. */
  link?(href: string, text: string, alone: boolean): LinkAnswer | undefined;
  /** An image's source as written (URL-decoded once): an asset id, or null when there is none. */
  image?(src: string, alt: string): string | null;
  /** `[[Page]]`, `[[Page|text]]` and `![[image.png]]` (Obsidian): resolved by `link` and `image`. */
  wikiLinks?: boolean;
  /** Blocks a page is made of at most; the lines after them are left out (`tooManyBlocks`). */
  maxBlocks?: number;
  note?(what: MarkdownNote, detail?: string): void;
}

/** Blocks an imported page is made of at most (Markdown and Word alike): a page an editor draws. */
export const MAX_PAGE_BLOCKS = 20_000;

/** Blocks made so far in one document, against its cap. */
interface BlockBudget {
  made: number;
  max: number;
}

/** List items nest at most this deep; deeper ones stay at the deepest level. */
export const MAX_NESTING = 32;

interface Context {
  options: MarkdownInOptions | null;
  /** Blocks a line's images and files become, put after the line. */
  trailing: DocJSON[];
  /** How deep inline parsing is (marks inside marks, links inside links). */
  depth?: number;
}

/** Inline Markdown is read this deep; deeper, a span is its text as written. */
const MAX_INLINE_DEPTH = 24;

const block = (body: DocJSON, children: DocJSON[] = []): DocJSON => ({
  type: 'block',
  attrs: { id: newBlockId() },
  content: [body, ...children],
});

/** ASCII punctuation, which a backslash escapes (CommonMark). */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

const INLINE_TAGS: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
};

/** A link's target as written: `<…>` and a `"title"` taken off, decoded once. */
function linkTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  else target = target.replace(/\s+("[^"]*"|'[^']*')$/, '');
  return decodeURIComponentSafe(target.trim());
}

/** Where the `)` that closes a link target opened at `from` is (targets may hold balanced parens). */
function closeParen(source: string, from: number): number {
  for (let j = from, depth = 0; j < source.length; j++) {
    if (source[j] === '\\') j++;
    else if (source[j] === '(') depth++;
    else if (source[j] === ')' && depth-- === 0) return j;
  }
  return -1;
}

/** Inline Markdown to text nodes with marks. */
export function parseInline(source: string, marks: Mark[] = []): DocJSON[] {
  return inline(source, marks, { options: null, trailing: [] }, false);
}

function inline(source: string, marks: Mark[], ctx: Context, alone: boolean): DocJSON[] {
  const depth = ctx.depth ?? 0;
  if (depth >= MAX_INLINE_DEPTH) {
    ctx.options?.note?.('tooDeep');
    return source ? [{ type: 'text', text: source, ...(marks.length ? { marks } : {}) }] : [];
  }
  ctx.depth = depth + 1;
  try {
    return inlineAt(source, marks, ctx, alone);
  } finally {
    ctx.depth = depth;
  }
}

function inlineAt(source: string, marks: Mark[], ctx: Context, alone: boolean): DocJSON[] {
  const out: DocJSON[] = [];
  const options = ctx.options;
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
  /** A link's answer turned into inline nodes (and blocks after the line). */
  const linked = (answer: LinkAnswer, label: string) => {
    if (answer === null) {
      out.push(...inline(label, marks, ctx, false));
      return;
    }
    if ('mention' in answer || 'childPage' in answer || 'databaseView' in answer) {
      const pageId =
        'mention' in answer
          ? answer.mention
          : 'childPage' in answer
            ? answer.childPage
            : answer.databaseView;
      out.push({
        type: 'pageMention',
        attrs: { pageId, blockId: 'mention' in answer ? (answer.blockId ?? null) : null },
      });
      return;
    }
    if ('page' in answer) {
      const href = `#/p/${answer.page}${answer.blockId ? `/${answer.blockId}` : ''}`;
      out.push(...inline(label, [...marks, { type: 'link', attrs: { href } }], ctx, false));
      return;
    }
    if ('file' in answer) {
      out.push(...inline(label, marks, ctx, false));
      ctx.trailing.push(block({ type: 'file', attrs: { assetId: answer.file } }));
      return;
    }
    const href = safeHref(answer.href);
    out.push(
      ...inline(label, href ? [...marks, { type: 'link', attrs: { href } }] : marks, ctx, false),
    );
  };
  /** An image: a block after the line when the import has it, else its text (or a link). */
  const image = (src: string, alt: string) => {
    const assetId = options?.image?.(src, alt) ?? null;
    if (assetId) {
      ctx.trailing.push(block({ type: 'image', attrs: { assetId, alt: alt || null } }));
      return;
    }
    const href = safeHref(src);
    options?.note?.(href ? 'externalImage' : 'missingImage', src);
    if (href)
      out.push(...inline(alt || src, [...marks, { type: 'link', attrs: { href } }], ctx, false));
    else if (alt) out.push(...inline(alt, marks, ctx, false));
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      flush();
      out.push({ type: 'hardBreak' });
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < source.length && ESCAPABLE.test(source[i + 1])) {
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
    // An autolink: `<https://…>`, `<mailto:…>`.
    if (ch === '<' && /^<(https?:\/\/|mailto:)[^\s<>]+>/i.test(source.slice(i, i + 2048))) {
      const end = source.indexOf('>', i);
      const href = safeHref(source.slice(i + 1, end));
      if (href) {
        flush();
        out.push({
          type: 'text',
          text: href,
          marks: [...marks, { type: 'link', attrs: { href } }],
        });
        i = end + 1;
        continue;
      }
    }
    if (options?.wikiLinks && (source.startsWith('[[', i) || source.startsWith('![[', i))) {
      const embed = ch === '!';
      const open = i + (embed ? 3 : 2);
      const end = source.indexOf(']]', open);
      if (end > open && !source.slice(open, end).includes('\n')) {
        flush();
        const [target, label] = source.slice(open, end).split('|');
        if (embed) image(target.trim(), (label ?? '').trim());
        else {
          const answer = options.link?.(`[[${target.trim()}]]`, (label ?? target).trim(), alone);
          linked(answer === undefined ? null : answer, (label ?? target).trim());
        }
        i = end + 2;
        continue;
      }
    }
    if (ch === '!' && source[i + 1] === '[' && options) {
      const close = source.indexOf('](', i + 2);
      const end = close > i ? closeParen(source, close + 2) : -1;
      if (end > close) {
        flush();
        image(linkTarget(source.slice(close + 2, end)), source.slice(i + 2, close));
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = source.indexOf('](', i);
      // The target may hold balanced parentheses: [a](https://x.y/a_(b)).
      const end = close > i ? closeParen(source, close + 2) : -1;
      if (close > i && end > close) {
        const label = source.slice(i + 1, close);
        const target = linkTarget(source.slice(close + 2, end));
        flush();
        const answer = options?.link?.(target, label, alone);
        linked(answer === undefined ? { href: target } : answer, label);
        i = end + 1;
        continue;
      }
    }
    if (ch === '<' && options) {
      // The inline HTML an export writes: line breaks and a few marks; any other tag is dropped.
      const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*?(\/?)>/.exec(source.slice(i, i + 512));
      if (tag) {
        const name = tag[2].toLowerCase();
        if (name === 'br') {
          flush();
          out.push({ type: 'hardBreak' });
          i += tag[0].length;
          continue;
        }
        const type =
          INLINE_TAGS[name] ?? (name === 'code' ? 'code' : name === 'u' ? 'underline' : null);
        if (type && !tag[1]) {
          const closing = source.toLowerCase().indexOf(`</${name}>`, i + tag[0].length);
          if (closing > 0) {
            flush();
            out.push(
              ...inline(source.slice(i + tag[0].length, closing), [...marks, { type }], ctx, false),
            );
            i = closing + name.length + 3;
            continue;
          }
        }
        if (name !== 'u') {
          options.note?.('html', name);
          i += tag[0].length;
          continue;
        }
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
      out.push(...inline(found.inner, [...marks, { type }], ctx, false));
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

const indentOf = (line: string) => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
};

/** A line that ends in a hard break: two spaces or more, or a backslash. */
const hardEnd = (line: string) => / {2,}$/.test(line) || /(^|[^\\])\\$/.test(line);
const withoutHardEnd = (line: string) => line.replace(/ {2,}$/, '').replace(/\\$/, '');

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

/** The joiner and the emoji presentation selector inside an emoji sequence. */
const ZWJ = String.fromCharCode(0x200d);
const VS16 = String.fromCharCode(0xfe0f);
const EMOJI = `\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|${VS16}|${ZWJ}\\p{Extended_Pictographic})*`;
/** A leading emoji and the space after it (a callout's icon). */
const EMOJI_START = new RegExp(`^(${EMOJI})\\s+`, 'u');
/** A text that is only an emoji. */
const EMOJI_ONLY = new RegExp(`^(${EMOJI})$`, 'u');

/** Markdown text to a document's JSON. Blocks get fresh ids: this is a local creation. */
export function parseMarkdown(markdown: string, options?: MarkdownInOptions): DocJSON {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (options) skipFrontMatter(lines, options);
  const budget: BlockBudget = { made: 0, max: options?.maxBlocks ?? Number.POSITIVE_INFINITY };
  return { type: 'doc', content: parseLines(lines, options ?? null, 0, budget) };
}

/** YAML front matter (`---` … `---` at the very top) is not the page's content. */
function skipFrontMatter(lines: string[], options: MarkdownInOptions) {
  if (lines[0]?.trim() !== '---') return;
  for (let j = 1; j < Math.min(lines.length, 200); j++) {
    if (lines[j].trim() === '---' || lines[j].trim() === '...') {
      if (j === 1) return;
      if (!lines.slice(1, j).every((l) => !l.trim() || /^[\w-]+\s*:|^\s+|^-\s/.test(l))) return;
      lines.splice(0, j + 1);
      options.note?.('frontMatter');
      return;
    }
  }
}

/** `<aside>` and `<details>` inside each other are read this deep; deeper ones are their text. */
const MAX_HTML_NESTING = 8;

function parseLines(
  lines: string[],
  options: MarkdownInOptions | null,
  depth: number,
  budget: BlockBudget,
): DocJSON[] {
  const root: DocJSON[] = [];
  const ctx: Context = { options, trailing: [] };
  let numberedRun = false;
  // Open list items, by indent, so deeper items become their children.
  const stack: { indent: number; children: DocJSON[]; item: DocJSON; source: string }[] = [];
  const target = (indent: number): DocJSON[] => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack.length ? stack[stack.length - 1].children : root;
  };
  /** Blocks a line's images and files became, after it (an item's go under it). */
  const placeTrailing = (into: DocJSON[], made: DocJSON | null) => {
    if (!ctx.trailing.length) return;
    const extra = ctx.trailing.splice(0);
    const body = made?.content?.[0];
    // A line that held only images or files becomes them.
    const empty = !!body && body.type === 'textBody' && !body.content?.length;
    if (made && empty && made.content!.length === 1) {
      into.splice(into.indexOf(made), 1, ...extra);
      return;
    }
    if (made && body?.type === 'textBody' && /Item$/.test(String(body.attrs?.kind)))
      made.content!.push(...extra);
    else into.push(...extra);
  };
  const textBody = (kind: string, source: string, attrs: Record<string, unknown> = {}) => {
    const content = inline(source, [], ctx, false);
    return { type: 'textBody', attrs: { kind, ...attrs }, ...(content.length ? { content } : {}) };
  };
  const push = (into: DocJSON[], body: DocJSON, children: DocJSON[] = []) => {
    // Any other block ends a run of numbered items (a blank line between items does not).
    if (body.attrs?.kind !== 'numberedItem') numberedRun = false;
    budget.made++;
    const made = block(body, children);
    into.push(made);
    placeTrailing(into, made);
    return made;
  };

  let paragraph: string[] = [];
  let paragraphIndent = 0;
  let paragraphHard = false;
  const endParagraph = () => {
    if (!paragraph.length) return;
    const into = target(paragraphIndent);
    const source = paragraph.join('');
    paragraph = [];
    paragraphHard = false;
    if (aloneLine(source, into)) return;
    push(into, textBody('paragraph', source));
  };
  /** A line that is only a link or an autolink: a bookmark, a child page, a database, a file. */
  const aloneLine = (source: string, into: DocJSON[]): boolean => {
    const trimmed = source.trim();
    const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>$/i.exec(trimmed);
    if (auto && safeHref(auto[1])) {
      push(into, { type: 'bookmark', attrs: { url: safeHref(auto[1]) } });
      return true;
    }
    if (!options?.link) return false;
    const link = /^\[([^\]]*)\]\((.*)\)$/.exec(trimmed);
    if (!link || closeParen(trimmed, link[1].length + 3) !== trimmed.length - 1) return false;
    const answer = options.link(linkTarget(link[2]), link[1], true);
    if (!answer) return false;
    if ('childPage' in answer)
      push(into, { type: 'childPage', attrs: { pageId: answer.childPage } });
    else if ('databaseView' in answer)
      push(into, {
        type: 'databaseView',
        attrs: { databaseId: answer.databaseView, viewId: null },
      });
    else if ('file' in answer) push(into, { type: 'file', attrs: { assetId: answer.file } });
    else if ('href' in answer && safeHref(answer.href) && linkTarget(link[2]) === link[1].trim())
      push(into, { type: 'bookmark', attrs: { url: safeHref(answer.href) } });
    else return false;
    return true;
  };
  const pushItem = (indent: number, body: DocJSON, source: string) => {
    endParagraph();
    const into = target(indent);
    if (stack.length >= MAX_NESTING) options?.note?.('tooDeep');
    const item = push(into, body);
    // Deeper lines become this item's children, after its body.
    if (stack.length < MAX_NESTING) stack.push({ indent, children: item.content!, item, source });
    else stack.push({ indent, children: into, item, source });
  };
  /** The open item whose text ended in a hard break, if the next line continues it. */
  const continued = (indent: number) => {
    const top = stack[stack.length - 1];
    return top && indent > top.indent && hardEnd(top.source) ? top : null;
  };

  for (let i = 0; i < lines.length; i++) {
    // Past the page's cap the rest is left out (and said once).
    if (budget.made >= budget.max) {
      if (budget.made !== Number.POSITIVE_INFINITY) options?.note?.('tooManyBlocks');
      budget.made = Number.POSITIVE_INFINITY;
      break;
    }
    const line = lines[i];
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (!trimmed) {
      endParagraph();
      continue;
    }
    const fence = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(trimmed);
    if (fence) {
      endParagraph();
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trim().startsWith(fence[1]); j++)
        code.push(lines[j].slice(Math.min(indent, indentOf(lines[j]))));
      const source = code.join('\n');
      push(target(indent), {
        type: 'codeBlock',
        attrs: { language: fence[2] || null },
        ...(source ? { content: [{ type: 'text', text: source }] } : {}),
      });
      i = j;
      continue;
    }
    if (options && trimmed.startsWith('$$')) {
      // An equation (Notion writes `$$` … `$$`): kept as its source in a code block.
      endParagraph();
      const code: string[] = [];
      let j = i;
      const first = trimmed.slice(2);
      if (first.endsWith('$$') && first.length >= 2) code.push(first.slice(0, -2));
      else {
        if (first.trim()) code.push(first);
        for (j = i + 1; j < lines.length && !lines[j].trim().endsWith('$$'); j++)
          code.push(lines[j]);
        if (j < lines.length) code.push(lines[j].trim().slice(0, -2));
      }
      const source = code.join('\n').trim();
      options.note?.('equation');
      push(target(indent), {
        type: 'codeBlock',
        attrs: { language: 'latex' },
        ...(source ? { content: [{ type: 'text', text: source }] } : {}),
      });
      i = j;
      continue;
    }
    if (options && /^<!--/.test(trimmed)) {
      // A comment, over as many lines as it takes.
      endParagraph();
      let j = i;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      i = j;
      continue;
    }
    if (
      options &&
      depth >= MAX_HTML_NESTING &&
      /^<\/?(aside|details|summary)\b[^>]*>/i.test(trimmed)
    ) {
      endParagraph();
      options.note?.('tooDeep');
      continue;
    }
    if (options && /^<(aside|details)\b[^>]*>/i.test(trimmed)) {
      endParagraph();
      const tag = /^<(aside|details)/i.exec(trimmed)![1].toLowerCase();
      const inner: string[] = [];
      let j = i;
      let nest = 0;
      for (; j < lines.length; j++) {
        let current = j === i ? trimmed.replace(/^<(aside|details)\b[^>]*>/i, '') : lines[j];
        nest += (current.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length;
        const closing = current.toLowerCase().indexOf(`</${tag}>`);
        if (closing >= 0 && nest === 0) {
          current = current.slice(0, closing);
          if (current.trim()) inner.push(current);
          break;
        }
        if (closing >= 0) nest--;
        inner.push(current);
      }
      i = j;
      push(target(indent), ...htmlBlock(tag, inner, options, depth, budget));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      endParagraph();
      push(
        target(indent),
        textBody('heading', heading[2], { level: Math.min(3, heading[1].length) }),
      );
      continue;
    }
    if (paragraph.length && /^=+$/.test(trimmed) && indent < 4) {
      // `Title` over `===`: a first-level heading.
      const source = paragraph.join('');
      const into = target(paragraphIndent);
      paragraph = [];
      paragraphHard = false;
      push(into, textBody('heading', source, { level: 1 }));
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      endParagraph();
      push(target(indent), { type: 'divider' });
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      endParagraph();
      const rows = [splitRow(trimmed)];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++)
        rows.push(splitRow(lines[j]));
      const width = Math.max(...rows.map((r) => r.length));
      push(target(indent), {
        type: 'table',
        attrs: { headerRow: rows[0].some((cell) => cell !== '') },
        content: rows.map((cells) => ({
          type: 'tableRow',
          content: Array.from({ length: width }, (_, c) => {
            const content = inline(cells[c] ?? '', [], ctx, false);
            return { type: 'tableCell', ...(content.length ? { content } : {}) };
          }),
        })),
      });
      i = j - 1;
      continue;
    }
    const check = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (check) {
      pushItem(
        indent,
        textBody('checkItem', withoutHardEnd(check[2]), {
          checked: check[1].toLowerCase() === 'x',
        }),
        line,
      );
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      pushItem(indent, textBody('bulletItem', withoutHardEnd(bullet[1])), line);
      continue;
    }
    const numbered = /^(\d{1,9})[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      // The first item of a run keeps its number when it is not 1.
      const start = Number(numbered[1]);
      const attrs = !numberedRun && start !== 1 ? { start } : {};
      numberedRun = true;
      pushItem(indent, textBody('numberedItem', withoutHardEnd(numbered[2]), attrs), line);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      endParagraph();
      const parts = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]))
        parts.push(lines[++i].trim().replace(/^>\s?/, ''));
      let icon: string | null = null;
      if (options) {
        // `> 💡 Note` is how a callout is written (toMarkdown): an emoji first.
        const emoji = EMOJI_START.exec(parts[0]);
        if (emoji) {
          icon = emoji[1];
          parts[0] = parts[0].slice(emoji[0].length);
        }
      }
      const content: DocJSON[] = [];
      parts.forEach((part, n) => {
        if (n) content.push({ type: 'hardBreak' });
        content.push(...inline(withoutHardEnd(part), [], ctx, false));
      });
      push(target(indent), {
        type: 'textBody',
        attrs: icon ? { kind: 'callout', icon, tone: 'info' } : { kind: 'quote' },
        ...(content.length ? { content } : {}),
      });
      continue;
    }
    // A plain line: part of a paragraph; under a list item when indented beneath it, or the rest
    // of the item's text when the item's line ended in a hard break.
    const open = !paragraph.length ? continued(indent) : null;
    if (open) {
      const body = open.item.content![0];
      const more = inline(withoutHardEnd(trimmed), [], ctx, false);
      body.content = [...(body.content ?? []), { type: 'hardBreak' }, ...more];
      open.source = line;
      // An item's images and files go under it.
      placeTrailing(root, open.item);
      continue;
    }
    if (!paragraph.length) {
      paragraphIndent = indent;
      // `\1.` at a line's start is how toMarkdown keeps a number from reading as a list (a digit
      // is not something a backslash escapes, so it is taken off here).
      paragraph.push(trimmed.replace(/^\\(\d+[.)]\s)/, '$1'));
    } else paragraph.push((paragraphHard ? '\n' : ' ') + trimmed);
    paragraphHard = hardEnd(line);
    if (paragraphHard)
      paragraph[paragraph.length - 1] = withoutHardEnd(paragraph[paragraph.length - 1]);
  }
  endParagraph();
  return root;
}

/**
 * Notion's HTML blocks: `<aside>` is a callout (an emoji first is its icon), `<details>` with its
 * `<summary>` a toggle; what is inside them is Markdown, read as their children.
 */
function htmlBlock(
  tag: string,
  inner: string[],
  options: MarkdownInOptions,
  depth: number,
  budget: BlockBudget,
): [DocJSON, DocJSON[]] {
  if (tag === 'details') {
    const joined = inner.join('\n');
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(joined);
    const rest = summary ? joined.replace(summary[0], '') : joined;
    const children = parseLines(rest.split('\n'), options, depth + 1, budget);
    const content = parseInline(stripTags(summary?.[1] ?? '').trim());
    return [
      { type: 'textBody', attrs: { kind: 'toggle' }, ...(content.length ? { content } : {}) },
      children,
    ];
  }
  const blocks = parseLines(inner, options, depth + 1, budget);
  const first = blocks[0]?.content?.[0];
  let lead: DocJSON[] = [];
  let icon: string | null = null;
  if (first?.type === 'textBody' && first.attrs?.kind === 'paragraph') {
    lead = first.content ?? [];
    // The first paragraph's other blocks (an image after its line) stay, in their order.
    blocks.splice(0, 1, ...(blocks[0].content ?? []).slice(1));
    const head = lead[0];
    if (head?.type === 'text' && head.text) {
      const emoji = EMOJI_START.exec(head.text) ?? EMOJI_ONLY.exec(head.text);
      if (emoji) {
        icon = emoji[1];
        const after = head.text.slice(emoji[0].length);
        lead = after ? [{ ...head, text: after }, ...lead.slice(1)] : lead.slice(1);
        while (lead[0]?.type === 'hardBreak') lead = lead.slice(1);
      }
    }
  }
  return [
    {
      type: 'textBody',
      attrs: { kind: 'callout', icon, tone: 'info' },
      ...(lead.length ? { content: lead } : {}),
    },
    blocks,
  ];
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

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
