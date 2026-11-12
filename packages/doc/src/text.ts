// A page's content as plain text (for search) and as Markdown (for export and copy), read from
// ProseMirror JSON, so it runs without an editor: in a worker, in Node, in the exporter.
import type { DocJSON } from './binding';
import { dateMentionText } from './dates';

/** Names for what the document stores only by id (D6): titles and file names, resolved now. */
export interface TextContext {
  pageTitle?: (pageId: string) => string | undefined;
  /** A link target for a page, in an export: a relative path. */
  pageHref?: (pageId: string, blockId?: string | null) => string | undefined;
  assetName?: (assetId: string) => string | undefined;
  assetHref?: (assetId: string) => string | undefined;
  /** What an image or file with no name says. */
  untitled?: string;
}

const isBlock = (node: DocJSON) => node.type === 'block';
const bodiesOf = (block: DocJSON) => (block.content ?? []).filter((c) => !isBlock(c));
const childrenOf = (block: DocJSON) => (block.content ?? []).filter(isBlock);

function inlineText(nodes: DocJSON[] | undefined, context: TextContext): string {
  let out = '';
  for (const node of nodes ?? []) {
    if (node.type === 'text') out += node.text ?? '';
    else if (node.type === 'hardBreak') out += '\n';
    else if (node.type === 'pageMention')
      out += context.pageTitle?.(String(node.attrs?.pageId ?? '')) ?? '';
    else if (node.type === 'dateMention') out += dateMentionText(node.attrs);
  }
  return out;
}

function bodyText(body: DocJSON, context: TextContext): string {
  switch (body.type) {
    case 'textBody':
    case 'codeBlock':
      return inlineText(body.content, context);
    case 'table':
      return (body.content ?? [])
        .map((row) =>
          (row.content ?? []).map((cell) => inlineText(cell.content, context)).join('\t'),
        )
        .join('\n');
    case 'image':
      return [body.attrs?.alt, body.attrs?.caption].filter(Boolean).join(' ');
    case 'file':
      return context.assetName?.(String(body.attrs?.assetId ?? '')) ?? '';
    case 'bookmark':
      return String(body.attrs?.url ?? '');
    case 'childPage':
      return context.pageTitle?.(String(body.attrs?.pageId ?? '')) ?? '';
    // A table of contents and a database view hold no text of this page (a database's rows are
    // pages of their own, searched and exported as such).
    default:
      return '';
  }
}

/** Every block's text, one per line, in document order. */
export function plainText(doc: DocJSON, context: TextContext = {}): string {
  const lines: string[] = [];
  const walk = (blocks: DocJSON[]) => {
    for (const block of blocks) {
      for (const body of bodiesOf(block)) {
        const text = bodyText(body, context);
        if (text) lines.push(text);
      }
      walk(childrenOf(block));
    }
  };
  walk(doc.content ?? []);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown

const escapeInline = (text: string) => text.replace(/([\\`*_[\]~<>|])/g, '\\$1');
const escapeLineStart = (text: string) =>
  text.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|---|```)/, '$1\\$2');

type MarkJSON = NonNullable<DocJSON['marks']>[number];

function wrap(text: string, mark: MarkJSON): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'underline':
      return `<u>${text}</u>`;
    case 'link': {
      const href = String(mark.attrs?.href ?? '');
      return href ? `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})` : text;
    }
    default:
      // Colours are theme tokens with no Markdown form; the text stays.
      return text;
  }
}

function inlineMarkdown(
  nodes: DocJSON[] | undefined,
  context: TextContext,
  indent: string,
): string {
  let out = '';
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      out += `  \n${indent}`;
      continue;
    }
    if (node.type === 'pageMention') {
      const id = String(node.attrs?.pageId ?? '');
      const title = context.pageTitle?.(id) ?? id;
      const href = context.pageHref?.(id, node.attrs?.blockId as string | null);
      out += href ? `[${escapeInline(title)}](${href})` : escapeInline(title);
      continue;
    }
    if (node.type === 'dateMention') {
      // Digits, `-`, `T`, `:`, `Z`, a space and an arrow: nothing Markdown reads as syntax.
      out += dateMentionText(node.attrs);
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = node.marks ?? [];
    if (marks.some((m) => m.type === 'code')) {
      const text = node.text ?? '';
      const fence = text.includes('`') ? '``' : '`';
      let coded = `${fence}${text}${fence}`;
      for (const mark of marks) if (mark.type === 'link') coded = wrap(coded, mark);
      out += coded;
      continue;
    }
    let text = escapeInline(node.text ?? '');
    // Keep spaces outside the markers, which Markdown needs to see them.
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text.slice(lead.length))![0];
    let core = text.slice(lead.length, text.length - trail.length);
    if (core) for (const mark of marks) core = wrap(core, mark);
    text = lead + core + trail;
    out += text;
  }
  return out;
}

function tableMarkdown(table: DocJSON, context: TextContext, indent: string): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map(
      (cell) =>
        inlineMarkdown(cell.content, context, '').replace(/\n/g, ' ').replace(/\|/g, '\\|') || ' ',
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill(' ')];
  const header = table.attrs?.headerRow ? pad(rows.shift()!) : Array(width).fill(' ');
  const line = (cells: string[]) => `${indent}| ${cells.join(' | ')} |`;
  return [line(header), line(Array(width).fill('---')), ...rows.map((r) => line(pad(r)))].join(
    '\n',
  );
}

/** The page as Markdown: one block per paragraph, children indented by two spaces. */
export function toMarkdown(doc: DocJSON, context: TextContext = {}): string {
  const out: string[] = [];
  const walk = (blocks: DocJSON[], indent: string) => {
    let number = 0;
    for (const block of blocks) {
      const bodies = bodiesOf(block);
      const first = bodies[0];
      const kind =
        first?.type === 'textBody' ? String(first.attrs?.kind ?? 'paragraph') : first?.type;
      number = kind === 'numberedItem' ? number + 1 : 0;
      for (const body of bodies) out.push(bodyMarkdown(body, context, indent, number || 1));
      walk(childrenOf(block), indent + '  ');
    }
  };
  walk(doc.content ?? [], '');
  return out.filter((chunk) => chunk !== '').join('\n\n') + '\n';
}

function bodyMarkdown(body: DocJSON, context: TextContext, indent: string, number: number): string {
  const attrs = body.attrs ?? {};
  switch (body.type) {
    case 'textBody': {
      const text = inlineMarkdown(body.content, context, indent + '  ');
      const safe = escapeLineStart(text);
      switch (attrs.kind) {
        case 'heading':
          return `${indent}${'#'.repeat(Math.min(3, Number(attrs.level) || 1))} ${text}`;
        case 'bulletItem':
        case 'toggle':
          return `${indent}- ${text}`;
        case 'numberedItem':
          return `${indent}${number}. ${text}`;
        case 'checkItem':
          return `${indent}- [${attrs.checked ? 'x' : ' '}] ${text}`;
        case 'quote':
          return `${indent}> ${text.replace(/\n/g, `\n${indent}> `)}`;
        case 'callout':
          return `${indent}> ${attrs.icon ? `${attrs.icon} ` : ''}${text.replace(/\n/g, `\n${indent}> `)}`;
        default:
          return `${indent}${safe}`;
      }
    }
    case 'codeBlock': {
      const code = inlineText(body.content, context);
      const fence = code.includes('```') ? '````' : '```';
      return [
        `${indent}${fence}${attrs.language ?? ''}`,
        ...code.split('\n').map((l) => indent + l),
        `${indent}${fence}`,
      ].join('\n');
    }
    case 'divider':
      return `${indent}---`;
    case 'image': {
      const id = String(attrs.assetId ?? '');
      const alt = escapeInline(String(attrs.alt ?? ''));
      const href = context.assetHref?.(id) ?? `asset:${id}`;
      const caption = attrs.caption ? `\n${indent}*${escapeInline(String(attrs.caption))}*` : '';
      return `${indent}![${alt}](${href})${caption}`;
    }
    case 'file': {
      const id = String(attrs.assetId ?? '');
      const name = context.assetName?.(id) ?? context.untitled ?? id;
      return `${indent}[${escapeInline(name)}](${context.assetHref?.(id) ?? `asset:${id}`})`;
    }
    case 'bookmark':
      return attrs.url ? `${indent}<${String(attrs.url)}>` : '';
    case 'childPage': {
      const id = String(attrs.pageId ?? '');
      const title = context.pageTitle?.(id) ?? context.untitled ?? id;
      const href = context.pageHref?.(id);
      return href
        ? `${indent}[${escapeInline(title)}](${href})`
        : `${indent}${escapeInline(title)}`;
    }
    case 'table':
      return tableMarkdown(body, context, indent);
    // A table of contents and a database view write nothing (contracts, section 5).
    default:
      return '';
  }
}
