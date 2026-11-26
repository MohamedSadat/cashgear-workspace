// Phase 19: a page as it leaves the workspace (ARCHITECTURE.md, "Word, PDF and print"). The Word
// writer (docx.ts) and the print view (print.ts) read the same input: the page's JSON and its
// sub-pages', each with what the shell resolved for its blocks that are not text (a database's
// rows, a chart, a sheet's picture, a plugin's line, a placeholder), the files it could read, the
// pages a mention or a child page names, people's names and the words. Both are pure: they run in
// a worker and in Node, and never reach the network or a store.
//
// The blocks are read flat: each body with its depth (how far it is nested), and for a list item
// its list (a run of siblings of one kind), its level among list items and its number. A block's
// direction is its own, else its first strong character's (the editor's `dir="auto"`), else the
// page's.
import type { PageLayout } from '@cgw/workspace/layout';
import type { DocJSON } from '../binding';
import { formatDateMention, isDateValue } from '../dates';

export type Direction = 'ltr' | 'rtl';

/** A database block's rows as the view shows them (its filter, sort and shown properties). */
export interface OutTable {
  kind: 'table';
  /** The database's (or the view's) name, written above it. */
  title: string;
  columns: string[];
  /** Each row's cells as text, `columns.length` each. */
  rows: string[][];
  /** A board or a list grouped: where each group starts in `rows`, and its name. */
  groups?: { name: string; at: number; count: number }[];
  /** Rows past the limit, said in a line after the table (`moreText`, in the interface's words). */
  more: number;
  moreText?: string;
}

export type OutBlock =
  | OutTable
  /** A chart view or a chart block: its drawing (SVG for print, a PNG asset for Word). */
  | { kind: 'chart'; title: string; svg: string | null; image: string | null }
  /** A sheet embed's picture, an asset of `assets`. */
  | { kind: 'picture'; title: string; image: string }
  /** A plugin block's line. */
  | { kind: 'text'; text: string }
  /** What is not written, said in its place (an ERP block, a database not on the device). */
  | { kind: 'placeholder'; text: string };

export interface OutAsset {
  fileName: string;
  contentType: string;
  /** Its size in pixels, where known (an image's natural size). */
  width: number | null;
  height: number | null;
  /** The bytes, for Word (png, jpeg or gif). */
  bytes?: Uint8Array;
  /** An address the print view draws it from (a blob URL). */
  url?: string;
}

export interface OutPage {
  id: string;
  title: string;
  icon: string | null;
  content: DocJSON;
  /** A row's properties, written as a table under its title. */
  properties?: { name: string; text: string }[];
  /** What the shell resolved for a block that is not text, by its block's id. */
  blocks: Record<string, OutBlock>;
}

/** The interface's words the writers need, as plain text (a worker takes no function). */
export interface OutWords {
  untitled: string;
  /** A mention of a page the export cannot name. */
  aPage: string;
  /** A person the export cannot name. */
  someone: string;
  /** A file the export knows nothing of. */
  missingFile: string;
  /** An image the device does not hold. */
  missingImage: string;
  /** A table of contents with no heading to list. */
  noHeadings: string;
  /** A block this build does not know. */
  unknownBlock: string;
  /** The table of contents' title (Word's field asks for none; the print view's list has one). */
  contents: string;
}

export interface OutInput {
  /** The interface language: the direction of what has none of its own, and the words. */
  language: 'en' | 'ar';
  /** The locale dates are written in (the editor's). */
  locale: string;
  /** `{date}` in the header and footer: the day it is made, as the interface writes it. */
  date: string;
  /** When it was made (Word's core properties), ISO 8601. */
  madeAt: string;
  layout: PageLayout;
  /** The page, then its sub-pages (each after a page break). */
  pages: OutPage[];
  assets: Record<string, OutAsset>;
  /** Pages a mention or a child page names: its title, icon and address in the app. */
  links: Record<string, { title: string; icon: string | null; href: string | null }>;
  people: Record<string, string>;
  words: OutWords;
}

/** Scripts written right to left. */
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;

/** The direction of text's first strong character, or null when it has none. */
export function textDirection(text: string): Direction | null {
  for (const char of text) if (LETTER.test(char)) return RTL.test(char) ? 'rtl' : 'ltr';
  return null;
}

/** Whether a character is a letter of a right-to-left script. */
export const isRtlLetter = (char: string): boolean => RTL.test(char);

const attr = (node: DocJSON | undefined, key: string): unknown => node?.attrs?.[key];

/** The text of a node's inline content, as a reader sees it (mentions by their names). */
export function inlineText(nodes: readonly DocJSON[] | undefined, input: OutInput): string {
  let out = '';
  for (const node of nodes ?? []) out += inlineOne(node, input);
  return out;
}

function inlineOne(node: DocJSON, input: OutInput): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'pageMention':
      return mentionText(node, input);
    case 'dateMention':
      return dateText(node, input);
    case 'userMention':
      return personText(node, input);
    default:
      return inlineText(node.content, input);
  }
}

export function mentionText(node: DocJSON, input: OutInput): string {
  const target = input.links[String(attr(node, 'pageId') ?? '')];
  if (!target) return input.words.aPage;
  return `${target.icon ? `${target.icon} ` : ''}${target.title || input.words.untitled}`;
}

export const mentionHref = (node: DocJSON, input: OutInput): string | null =>
  input.links[String(attr(node, 'pageId') ?? '')]?.href ?? null;

export function dateText(node: DocJSON, input: OutInput): string {
  if (!isDateValue(attr(node, 'date'))) return '';
  return formatDateMention(node.attrs ?? {}, input.locale) ?? String(attr(node, 'date'));
}

export const personText = (node: DocJSON, input: OutInput): string =>
  `@${input.people[String(attr(node, 'userId') ?? '')] ?? input.words.someone}`;

/** A body's direction: its own, else its text's first strong character, else `fallback`. */
export function bodyDirection(body: DocJSON, input: OutInput, fallback: Direction): Direction {
  const dir = attr(body, 'dir');
  if (dir === 'ltr' || dir === 'rtl') return dir;
  if (body.type === 'codeBlock') return 'ltr';
  return textDirection(inlineText(body.content, input)) ?? fallback;
}

/** A page's direction: its title's, else its first block's with text, else the interface's. */
export function pageDirection(page: OutPage, input: OutInput): Direction {
  const own = textDirection(page.title);
  if (own) return own;
  const interfaceDir: Direction = input.language === 'ar' ? 'rtl' : 'ltr';
  for (const item of flatten(page.content)) {
    if (item.body.type !== 'textBody') continue;
    const dir = attr(item.body, 'dir');
    if (dir === 'ltr' || dir === 'rtl') return dir;
    const text = textDirection(inlineText(item.body.content, input));
    if (text) return text;
  }
  return interfaceDir;
}

export type ListKind = 'bullet' | 'number' | 'check';

export interface FlatItem {
  /** The block the body is in (the first body of a block carries its id). */
  block: DocJSON;
  body: DocJSON;
  /** How far the block is nested (0 at the top). */
  depth: number;
  /** For a list item: its kind, its run of siblings, its level among list items, its number. */
  list?: { kind: ListKind; run: number; level: number; number: number };
  /** The first body of its block (the one that carries the block's id). */
  first: boolean;
}

const LIST_KINDS: Record<string, ListKind> = {
  bulletItem: 'bullet',
  numberedItem: 'number',
  checkItem: 'check',
};

/** How deep blocks are read: deeper ones are drawn at this depth. */
export const MAX_DEPTH = 40;

/**
 * A page's blocks read flat, in order. Consecutive siblings that are list items of one kind are a
 * run: numbered items count from the first one's `start` (else 1); a list item's level is how many
 * list items it is nested under.
 */
export function flatten(content: DocJSON): FlatItem[] {
  const out: FlatItem[] = [];
  let runs = 0;
  const walk = (blocks: readonly DocJSON[], depth: number, level: number) => {
    let run: { kind: ListKind; id: number; next: number } | null = null;
    for (const block of blocks) {
      if (block.type !== 'block') {
        // A body where a block belongs: read as a block of its own.
        if (block.type)
          out.push({ block, body: block, depth: Math.min(depth, MAX_DEPTH), first: true });
        run = null;
        continue;
      }
      const bodies = (block.content ?? []).filter((c) => c.type !== 'block');
      const children = (block.content ?? []).filter((c) => c.type === 'block');
      const head = bodies[0];
      const kind =
        head?.type === 'textBody'
          ? LIST_KINDS[String(attr(head, 'kind') ?? 'paragraph')]
          : undefined;
      if (kind) {
        if (!run || run.kind !== kind) {
          const start = Number(attr(head, 'start'));
          run = {
            kind,
            id: ++runs,
            next:
              kind === 'number' && Number.isInteger(start) && start >= 1 && start <= 1e9
                ? start
                : 1,
          };
        }
        bodies.forEach((body, i) =>
          out.push({
            block,
            body,
            depth: Math.min(depth, MAX_DEPTH),
            first: i === 0,
            ...(i === 0
              ? { list: { kind, run: run!.id, level: Math.min(level, 8), number: run!.next } }
              : {}),
          }),
        );
        run.next++;
        walk(children, depth + 1, level + 1);
        continue;
      }
      run = null;
      bodies.forEach((body, i) =>
        out.push({ block, body, depth: Math.min(depth, MAX_DEPTH), first: i === 0 }),
      );
      if (!bodies.length && children.length)
        out.push({
          block,
          body: { type: 'textBody', content: [] },
          depth: Math.min(depth, MAX_DEPTH),
          first: true,
        });
      walk(children, depth + 1, level);
    }
  };
  walk(content.content ?? [], 0, 0);
  return out;
}

/** The page's headings, for a table of contents: each with its block's id, level and text. */
export function headings(
  content: DocJSON,
  input: OutInput,
): { id: string | null; level: number; text: string }[] {
  return flatten(content)
    .filter(
      (item) =>
        item.first && item.body.type === 'textBody' && attr(item.body, 'kind') === 'heading',
    )
    .map((item) => ({
      id: typeof attr(item.block, 'id') === 'string' ? (attr(item.block, 'id') as string) : null,
      level: Math.min(3, Math.max(1, Number(attr(item.body, 'level')) || 1)),
      text: inlineText(item.body.content, input).replace(/\s+/g, ' ').trim(),
    }));
}

/** What the shell resolved for a block, by its id. */
export const resolved = (page: OutPage, block: DocJSON): OutBlock | undefined => {
  const id = attr(block, 'id');
  return typeof id === 'string' ? page.blocks[id] : undefined;
};

/** The named colours (schema `COLOUR_TOKENS`) as the print view and Word write them. */
export const TEXT_COLOURS: Record<string, string> = {
  gray: '787774',
  brown: '9F6B53',
  orange: 'D9730D',
  yellow: 'CB912F',
  green: '448361',
  blue: '337EA9',
  purple: '9065B0',
  pink: 'C14C8A',
  red: 'D44C47',
};

/** Highlights in print (Word has a palette of its own). */
export const HIGHLIGHT_COLOURS: Record<string, string> = {
  gray: 'EBECED',
  brown: 'E9E5E3',
  orange: 'FAEBDD',
  yellow: 'FBF3DB',
  green: 'DDEDEA',
  blue: 'DDEBF1',
  purple: 'EAE4F2',
  pink: 'F4DFEB',
  red: 'FBE4E4',
};

/** A callout's tone's shade and edge. */
export const CALLOUT_TONES: Record<string, { fill: string; edge: string }> = {
  info: { fill: 'E7F0FB', edge: '337EA9' },
  success: { fill: 'E6F4EA', edge: '448361' },
  warning: { fill: 'FDF3E1', edge: 'CB912F' },
  danger: { fill: 'FCE9E8', edge: 'D44C47' },
  neutral: { fill: 'F1F1EF', edge: '9B9A97' },
};

/** A safe link: the schemes the editor allows, or an address of a page in the app. */
export function linkHref(href: unknown, input: OutInput): string | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  const page = /^#\/p\/([0-9a-f-]{36})/i.exec(value);
  if (page) return input.links[page[1].toLowerCase()]?.href ?? null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return /^(https?:\/\/|mailto:|tel:)/i.test(value) ? value : null;
}
