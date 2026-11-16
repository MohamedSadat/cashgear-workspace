// Word in (Phase 8): a `.docx` file's parts, already unzipped, read into a document's JSON by a
// reader of our own over their XML (xml.ts): `word/document.xml`, `styles.xml`, `numbering.xml`
// and `_rels/document.xml.rels`. Headings (by style name or outline level), paragraphs, lists
// (bullets and numbers from the numbering, nested by level, Word's check boxes), quotes, code (a
// code style, or every run in a monospace font), tables (merged cells), images (the caller makes
// each one an asset), links (external ones; a HYPERLINK field too), and the marks bold, italic,
// underline, strike, code (by font) and highlight; right to left from `w:bidi`.
//
// What has no counterpart is counted, never dropped silently: tracked changes (the text is read
// as if they were accepted), comments, footnotes, text boxes, equations, charts, shapes,
// embedded objects, page breaks, tables inside tables (their text kept), linked images, headers
// and footers. Empty paragraphs are left out. Blocks get fresh ids: an import is a local creation.
// Pure: runs in a worker and in Node.
import type { DocJSON } from './binding';
import { newBlockId } from './ids';
import { safeHref } from './schema';
import { MAX_PAGE_BLOCKS } from './markdown';
import {
  XmlError,
  attr,
  descendant,
  element,
  elements,
  local,
  parseXml,
  type XmlElement,
} from './xml';

/** A `.docx` file's parts, as text; only the document is needed. */
export interface DocxParts {
  /** `word/document.xml`. */
  document: string;
  /** `word/styles.xml`. */
  styles?: string;
  /** `word/numbering.xml`. */
  numbering?: string;
  /** `word/_rels/document.xml.rels`. */
  relationships?: string;
  /** How many header and footer parts the package has (they are not read). */
  headersAndFooters?: number;
}

export type DocxSkip =
  | 'trackedChanges'
  | 'comments'
  | 'footnotes'
  | 'textBoxes'
  | 'equations'
  | 'charts'
  | 'shapes'
  | 'embeddedObjects'
  | 'pageBreaks'
  | 'nestedTables'
  | 'linkedImages'
  | 'missingImages'
  | 'headersAndFooters'
  /** Blocks past `maxBlocks`, left out. */
  | 'blocksLeftOut';

export interface DocxOptions {
  /**
   * An image part (its path in the package, `word/media/image1.png`) as an asset id, or null when
   * it cannot be one (missing, too large, not an image): counted as `missingImages` then.
   */
  image?(path: string, alt: string | null): string | null;
  /** Blocks a page is made of at most (default `MAX_PAGE_BLOCKS`); the rest are counted. */
  maxBlocks?: number;
}

export interface DocxResult {
  /** The first paragraph's text when it has the Title style (taken out of the body). */
  title: string | null;
  doc: DocJSON;
  /** What was not kept, and how often. */
  skipped: Partial<Record<DocxSkip, number>>;
}

export class DocxError extends Error {
  constructor(
    message: string,
    /** `tooMany`: a part holds more elements than are read (`MAX_ELEMENTS`). */
    readonly code: 'tooMany' | 'other' = 'other',
  ) {
    super(message);
    this.name = 'DocxError';
  }
}

type Mark = { type: string; attrs?: Record<string, unknown> };

interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  highlight?: string | null;
}

interface StyleInfo {
  type: string;
  name: string;
  basedOn: string | null;
  outline: number | null;
  numId: string | null;
  ilvl: number | null;
  bidi: boolean | null;
  run: RunFormat;
}

interface Resolved {
  name: string;
  /** Every name in the chain, nearest first (a style based on "Heading 1" is a heading). */
  names: string[];
  outline: number | null;
  numId: string | null;
  ilvl: number | null;
  bidi: boolean | null;
  run: RunFormat;
}

/** Fonts whose text is code. */
const MONOSPACE =
  /^(courier( new)?|consolas|menlo|monaco|lucida (console|sans typewriter)|source code pro|fira (code|mono)|jetbrains mono|cascadia (code|mono)|dejavu sans mono|liberation mono|roboto mono|ubuntu mono|sf mono|andale mono|inconsolata|noto (sans )?mono|ibm plex mono|pt mono|monospace)$/i;

/** Word's highlight colours as the theme's tokens. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: 'yellow',
  green: 'green',
  cyan: 'blue',
  magenta: 'pink',
  blue: 'blue',
  red: 'red',
  darkBlue: 'blue',
  darkCyan: 'blue',
  darkGreen: 'green',
  darkMagenta: 'purple',
  darkRed: 'red',
  darkYellow: 'brown',
  darkGray: 'gray',
  lightGray: 'gray',
};

/** An on/off property (`<w:b/>`, `<w:b w:val="0"/>`), or undefined when absent. */
function toggle(parent: XmlElement | undefined, name: string): boolean | undefined {
  const el = element(parent, name);
  if (!el) return undefined;
  const value = attr(el, 'val');
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value.toLowerCase());
}

function runFormat(rPr: XmlElement | undefined): RunFormat {
  if (!rPr) return {};
  const format: RunFormat = {};
  const bold = toggle(rPr, 'b') ?? toggle(rPr, 'bCs');
  if (bold !== undefined) format.bold = bold;
  const italic = toggle(rPr, 'i') ?? toggle(rPr, 'iCs');
  if (italic !== undefined) format.italic = italic;
  const underline = element(rPr, 'u');
  if (underline) format.underline = (attr(underline, 'val') ?? 'single') !== 'none';
  const strike = toggle(rPr, 'strike') ?? toggle(rPr, 'dstrike');
  if (strike !== undefined) format.strike = strike;
  const fonts = element(rPr, 'rFonts');
  if (fonts) {
    const font = attr(fonts, 'ascii') ?? attr(fonts, 'hAnsi') ?? attr(fonts, 'cs');
    if (font) format.code = MONOSPACE.test(font.trim());
  }
  const highlight = element(rPr, 'highlight');
  if (highlight) format.highlight = HIGHLIGHTS[attr(highlight, 'val') ?? ''] ?? null;
  return format;
}

const merge = (base: RunFormat, over: RunFormat): RunFormat => ({ ...base, ...over });

function readStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  const root = parseXml(xml);
  for (const style of elements(root, 'style')) {
    const id = attr(style, 'styleId');
    if (!id) continue;
    const pPr = element(style, 'pPr');
    const outline = attr(element(pPr, 'outlineLvl'), 'val');
    const numPr = element(pPr, 'numPr');
    const ilvl = attr(element(numPr, 'ilvl'), 'val');
    styles.set(id, {
      type: attr(style, 'type') ?? 'paragraph',
      name: (attr(element(style, 'name'), 'val') ?? id).toLowerCase(),
      basedOn: attr(element(style, 'basedOn'), 'val') ?? null,
      outline: outline === undefined ? null : Number(outline),
      numId: attr(element(numPr, 'numId'), 'val') ?? null,
      ilvl: ilvl === undefined ? null : Number(ilvl),
      bidi: toggle(pPr, 'bidi') ?? null,
      run: runFormat(element(style, 'rPr')),
    });
  }
  return styles;
}

/** A style with what it inherits (`basedOn`, at most 16 deep; a loop stops there). */
function resolveStyle(styles: Map<string, StyleInfo>, id: string | undefined): Resolved {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  for (let next = id; next && !seen.has(next) && chain.length < 16;) {
    seen.add(next);
    const style = styles.get(next);
    if (!style) break;
    chain.push(style);
    next = style.basedOn ?? undefined;
  }
  const out: Resolved = {
    name: chain[0]?.name ?? '',
    names: chain.map((s) => s.name),
    outline: null,
    numId: null,
    ilvl: null,
    bidi: null,
    run: {},
  };
  for (const style of [...chain].reverse()) {
    if (style.outline !== null) out.outline = style.outline;
    if (style.numId !== null) out.numId = style.numId;
    if (style.ilvl !== null) out.ilvl = style.ilvl;
    if (style.bidi !== null) out.bidi = style.bidi;
    out.run = merge(out.run, style.run);
  }
  return out;
}

interface Level {
  format: string;
  start: number;
}

/** Each list (`numId`) and level: whether it is bulleted or numbered, and where it starts. */
function readNumbering(xml: string | undefined): (numId: string, ilvl: number) => Level | null {
  if (!xml) return () => null;
  const root = parseXml(xml);
  const levelsOf = (el: XmlElement | undefined) => {
    const out = new Map<number, Level>();
    for (const lvl of elements(el, 'lvl')) {
      out.set(Number(attr(lvl, 'ilvl') ?? 0), {
        format: attr(element(lvl, 'numFmt'), 'val') ?? 'decimal',
        start: Number(attr(element(lvl, 'start'), 'val') ?? 1) || 1,
      });
    }
    return out;
  };
  const abstract = new Map<string, Map<number, Level>>();
  for (const el of elements(root, 'abstractNum'))
    abstract.set(attr(el, 'abstractNumId') ?? '', levelsOf(el));
  const nums = new Map<string, { abstract: string; overrides: Map<number, Partial<Level>> }>();
  for (const num of elements(root, 'num')) {
    const overrides = new Map<number, Partial<Level>>();
    for (const override of elements(num, 'lvlOverride')) {
      const ilvl = Number(attr(override, 'ilvl') ?? 0);
      const startOverride = attr(element(override, 'startOverride'), 'val');
      const level = levelsOf(override).get(ilvl);
      overrides.set(ilvl, {
        ...level,
        ...(startOverride !== undefined ? { start: Number(startOverride) || 1 } : {}),
      });
    }
    nums.set(attr(num, 'numId') ?? '', {
      abstract: attr(element(num, 'abstractNumId'), 'val') ?? '',
      overrides,
    });
  }
  return (numId, ilvl) => {
    const num = nums.get(numId);
    if (!num) return null;
    const base = abstract.get(num.abstract)?.get(ilvl);
    const override = num.overrides.get(ilvl);
    if (!base && !override?.format) return null;
    return { format: 'decimal', start: 1, ...base, ...override } as Level;
  };
}

interface Relationship {
  target: string;
  external: boolean;
}

function readRelationships(xml: string | undefined): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  if (!xml) return out;
  for (const rel of elements(parseXml(xml), 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || target === undefined) continue;
    out.set(id, { target, external: attr(rel, 'TargetMode') === 'External' });
  }
  return out;
}

/** A part's path in the package from a relationship's target (relative to `word/`). */
function partPath(target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `word/${target}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Fields open inside each other that are kept (a document's own nest two or three). */
const MAX_FIELDS = 32;

const block = (body: DocJSON, children: DocJSON[] = []): DocJSON => ({
  type: 'block',
  attrs: { id: newBlockId() },
  content: [body, ...children],
});

/** A HYPERLINK field's target: `HYPERLINK "https://…" \o "tip"`, else null (`\l` is an anchor). */
function fieldLink(instruction: string): string | null {
  const match = /^\s*HYPERLINK\s+(?:\\[a-z]\s+"[^"]*"\s+)*"([^"]+)"/i.exec(instruction);
  if (!match || /^\s*HYPERLINK\s+\\l\b/i.test(instruction)) return null;
  return safeHref(match[1]);
}

interface Field {
  instruction: string;
  separated: boolean;
  link: string | null;
}

/** What one paragraph was read as. */
interface Paragraph {
  inline: DocJSON[];
  /** Images that were in it, as blocks after it (or instead of it, when it holds no text). */
  images: DocJSON[];
  style: Resolved;
  pPr: XmlElement | undefined;
  /** A Word check box (a content control) at its start, and whether it was ticked. */
  checkbox: boolean | null;
  /** Whether every run with text had a monospace font. */
  allCode: boolean;
  /** Whether every run with text was bold (a header row). */
  allBold: boolean;
}

export function readDocx(parts: DocxParts, options: DocxOptions = {}): DocxResult {
  let root: XmlElement;
  let styles: Map<string, StyleInfo>;
  let numbering: ReturnType<typeof readNumbering>;
  let rels: Map<string, Relationship>;
  try {
    root = parseXml(parts.document);
    styles = readStyles(parts.styles);
    numbering = readNumbering(parts.numbering);
    rels = readRelationships(parts.relationships);
  } catch (error) {
    const tooMany = error instanceof XmlError && error.code === 'tooMany';
    throw new DocxError(
      error instanceof Error ? error.message : String(error),
      tooMany ? 'tooMany' : 'other',
    );
  }
  const skipped: Partial<Record<DocxSkip, number>> = {};
  const skip = (what: DocxSkip, count = 1) => (skipped[what] = (skipped[what] ?? 0) + count);
  if (parts.headersAndFooters) skip('headersAndFooters', parts.headersAndFooters);
  const body = element(root, 'body');
  if (local(root.name) !== 'document' || !body) throw new DocxError('Not a Word document');

  const defaultStyle = [...styles.entries()].find(
    ([, s]) => s.type === 'paragraph' && s.name === 'normal',
  )?.[0];
  /**
   * Fields open across runs (and paragraphs): a HYPERLINK's result is a link. At most
   * `MAX_FIELDS` are kept open; deeper ones are counted, so their ends still match (the review:
   * fields opened and never closed, scanned on every run, cost runs × fields).
   */
  const fields: Field[] = [];
  let overflow = 0;
  const openLink = () => {
    for (let i = fields.length - 1; i >= 0; i--)
      if (fields[i].separated && fields[i].link) return fields[i].link;
    return null;
  };
  const inInstruction = () => {
    for (const field of fields) if (!field.separated) return true;
    return false;
  };
  /** Blocks made so far, and how many a page may hold. */
  let made = 0;
  const maxBlocks = options.maxBlocks ?? MAX_PAGE_BLOCKS;
  const blockOf = (body: DocJSON, children: DocJSON[] = []) => {
    made++;
    return block(body, children);
  };

  // ---- Runs ----------------------------------------------------------------------------------
  const marksOf = (format: RunFormat, link: string | null): Mark[] => {
    const marks: Mark[] = [];
    if (format.bold) marks.push({ type: 'bold' });
    if (format.italic) marks.push({ type: 'italic' });
    if (format.underline && !link) marks.push({ type: 'underline' });
    if (format.strike) marks.push({ type: 'strike' });
    if (format.code) marks.push({ type: 'code' });
    if (format.highlight) marks.push({ type: 'highlight', attrs: { token: format.highlight } });
    if (link) marks.push({ type: 'link', attrs: { href: link } });
    return marks;
  };

  /** A drawing or a picture: an image block, or what it is counted as. */
  const drawing = (el: XmlElement, out: Paragraph) => {
    const blip = descendant(el, 'blip') ?? descendant(el, 'imagedata');
    if (blip) {
      const embed = attr(blip, 'embed') ?? attr(blip, 'id');
      const linked = attr(blip, 'link');
      const rel = embed ? rels.get(embed) : undefined;
      if (!embed && linked) return void skip('linkedImages');
      if (!rel || rel.external) return void skip(rel?.external ? 'linkedImages' : 'missingImages');
      const docPr = descendant(el, 'docPr');
      const alt = (
        attr(docPr, 'descr') ||
        attr(docPr, 'title') ||
        attr(blip, 'title') ||
        ''
      ).trim();
      const assetId = options.image?.(partPath(rel.target), alt || null) ?? null;
      if (!assetId) return void skip('missingImages');
      out.images.push(blockOf({ type: 'image', attrs: { assetId, alt: alt || null } }));
      return;
    }
    if (descendant(el, 'chart')) skip('charts');
    else if (descendant(el, 'txbxContent') || descendant(el, 'textbox')) skip('textBoxes');
    else skip('shapes');
  };

  const run = (r: XmlElement, out: Paragraph, base: RunFormat, link: string | null) => {
    const rPr = element(r, 'rPr');
    const charStyle = attr(element(rPr, 'rStyle'), 'val');
    const format = merge(
      merge(base, charStyle ? resolveStyle(styles, charStyle).run : {}),
      runFormat(rPr),
    );
    const href = link ?? openLink();
    // Text inside a field's instruction (before its `separate`) is not shown.
    const hidden = inInstruction();
    const add = (text: string) => {
      if (!text || hidden) return;
      if (/\S/.test(text)) {
        if (!format.code) out.allCode = false;
        if (!format.bold) out.allBold = false;
      }
      const marks = marksOf(format, href);
      const last = out.inline[out.inline.length - 1];
      if (
        last?.type === 'text' &&
        JSON.stringify(last.marks ?? []) === JSON.stringify(marks.length ? marks : [])
      )
        last.text += text;
      else out.inline.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    };
    for (const child of r.children) {
      if (typeof child === 'string') continue;
      switch (local(child.name)) {
        case 't':
          add(child.children.filter((c): c is string => typeof c === 'string').join(''));
          break;
        case 'tab':
          add('\t');
          break;
        case 'noBreakHyphen':
          add('-');
          break;
        case 'br': {
          const type = attr(child, 'type');
          if (type === 'page' || type === 'column') {
            skip('pageBreaks');
            break;
          }
          if (!hidden) out.inline.push({ type: 'hardBreak' });
          break;
        }
        case 'cr':
          if (!hidden) out.inline.push({ type: 'hardBreak' });
          break;
        case 'fldChar': {
          const kind = attr(child, 'fldCharType');
          if (kind === 'begin') {
            if (fields.length < MAX_FIELDS)
              fields.push({ instruction: '', separated: false, link: null });
            else overflow++;
          } else if (kind === 'separate' && fields.length && !overflow) {
            const top = fields[fields.length - 1];
            top.separated = true;
            top.link = fieldLink(top.instruction);
          } else if (kind === 'end') {
            if (overflow) overflow--;
            else fields.pop();
          }
          break;
        }
        case 'instrText':
          if (fields.length && !overflow && fields[fields.length - 1].instruction.length < 2048)
            fields[fields.length - 1].instruction += child.children
              .filter((c): c is string => typeof c === 'string')
              .join('');
          break;
        case 'drawing':
        case 'pict':
          if (!hidden) drawing(child, out);
          break;
        case 'object':
          skip('embeddedObjects');
          break;
        case 'AlternateContent': {
          // The choice Word itself would draw; the fallback is the same thing again.
          const choice = element(child, 'Choice') ?? element(child, 'Fallback');
          if (choice) run({ ...r, children: choice.children }, out, base, link);
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference':
          skip('footnotes');
          break;
        case 'commentReference':
          skip('comments');
          break;
        case 'delText':
          break;
      }
    }
  };

  /** A paragraph's children: runs, links, changes, controls. */
  const content = (
    parent: XmlElement,
    out: Paragraph,
    base: RunFormat,
    link: string | null,
    depth = 0,
  ) => {
    if (depth > 32) return;
    for (const child of parent.children) {
      if (typeof child === 'string') continue;
      switch (local(child.name)) {
        case 'r':
          run(child, out, base, link);
          break;
        case 'hyperlink': {
          const rel = rels.get(attr(child, 'id') ?? '');
          const href = rel?.external ? safeHref(rel.target) : null;
          content(child, out, base, href ?? link, depth + 1);
          break;
        }
        case 'ins':
        case 'moveTo':
          skip('trackedChanges');
          content(child, out, base, link, depth + 1);
          break;
        case 'del':
        case 'moveFrom':
          skip('trackedChanges');
          break;
        case 'smartTag':
        case 'customXml':
        case 'fldSimple': {
          const instruction = child.name.endsWith('fldSimple') ? (attr(child, 'instr') ?? '') : '';
          content(child, out, base, fieldLink(instruction) ?? link, depth + 1);
          break;
        }
        case 'sdt': {
          const pr = element(child, 'sdtPr');
          const box = element(pr, 'checkbox');
          if (box) {
            // A check box: the paragraph is a to-do; the box's glyph is not its text.
            const checked = attr(element(box, 'checked'), 'val');
            if (out.checkbox === null && !out.inline.length)
              out.checkbox = checked === '1' || checked === 'true';
            break;
          }
          const inner = element(child, 'sdtContent');
          if (inner) content(inner, out, base, link, depth + 1);
          break;
        }
        case 'oMath':
        case 'oMathPara':
          skip('equations');
          break;
        case 'commentRangeStart':
          break;
      }
    }
  };

  const readParagraph = (p: XmlElement): Paragraph => {
    const pPr = element(p, 'pPr');
    const style = resolveStyle(styles, attr(element(pPr, 'pStyle'), 'val') ?? defaultStyle);
    if (element(pPr, 'pPrChange') || element(element(pPr, 'rPr'), 'ins')) skip('trackedChanges');
    const out: Paragraph = {
      inline: [],
      images: [],
      style,
      pPr,
      checkbox: null,
      allCode: true,
      allBold: true,
    };
    content(p, out, style.run, null);
    // Spaces at either end of a line are not its text.
    trimInline(out.inline);
    return out;
  };

  // ---- Blocks --------------------------------------------------------------------------------
  const out: DocJSON[] = [];
  let title: string | null = null;
  let first = true;
  /** Open list items by level, so deeper items become their children. */
  let lists: { level: number; item: DocJSON }[] = [];
  const started = new Set<string>();
  /** The code block consecutive code paragraphs are gathered into. */
  let code: DocJSON | null = null;

  const kindOf = (para: Paragraph): { kind: string; attrs: Record<string, unknown> } | 'code' => {
    const { style, pPr } = para;
    const names = style.names;
    const heading = names.map((n) => /^heading ([1-9])$/.exec(n)).find(Boolean);
    const outline = attr(element(pPr, 'outlineLvl'), 'val');
    const level = heading
      ? Number(heading[1])
      : outline !== undefined && Number(outline) < 9
        ? Number(outline) + 1
        : style.outline !== null && style.outline < 9
          ? style.outline + 1
          : null;
    if (names.includes('title')) return { kind: 'heading', attrs: { level: 1 } };
    if (level) return { kind: 'heading', attrs: { level: Math.min(3, level) } };
    if (names.some((n) => /^(intense )?quote$/.test(n))) return { kind: 'quote', attrs: {} };
    if (codeStyle(style)) return 'code';
    if (para.allCode && para.inline.some((n) => n.type === 'text')) return 'code';
    return { kind: 'paragraph', attrs: {} };
  };
  const codeStyle = (style: Resolved) =>
    style.names.some((n) => /code|preformatted|verbatim|macro text|source/.test(n));

  const plainOf = (nodes: DocJSON[]) =>
    nodes.map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : '')).join('');

  const paragraphBlock = (para: Paragraph) => {
    const { pPr, style } = para;
    const hasText = para.inline.some((n) => n.type === 'text' && n.text);
    const bidi = toggle(pPr, 'bidi') ?? style.bidi;
    const dir = bidi === true ? { dir: 'rtl' } : {};
    if (!hasText) {
      // An empty line in code is the code's; a line that holds only images is those images; an
      // empty one is spacing, left out.
      if (code && !para.images.length && codeStyle(style)) {
        code.content = [{ type: 'text', text: `${code.content?.[0]?.text ?? ''}\n` }];
        return;
      }
      lists = [];
      code = null;
      out.push(...para.images);
      return;
    }
    const kind = kindOf(para);
    if (first && kind !== 'code' && style.names.includes('title') && !para.images.length) {
      first = false;
      title = plainOf(para.inline).replace(/\s+/g, ' ').trim();
      return;
    }
    first = false;
    if (kind === 'code') {
      lists = [];
      const text = plainOf(para.inline);
      if (code)
        code.content = [{ type: 'text', text: `${code.content?.[0]?.text ?? ''}\n${text}` }];
      else {
        const body: DocJSON = {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text }],
        };
        out.push(blockOf(body));
        code = body;
      }
      out.push(...para.images);
      return;
    }
    code = null;
    // A list item: by its own numbering, or its style's.
    const numPr = element(pPr, 'numPr');
    const numId = attr(element(numPr, 'numId'), 'val') ?? style.numId;
    const ilvlText = attr(element(numPr, 'ilvl'), 'val');
    const ilvl = Math.min(8, Math.max(0, Number(ilvlText ?? style.ilvl ?? 0) || 0));
    const list = numId && numId !== '0' ? numbering(numId, ilvl) : null;
    const textBody = (kind: string, extra: Record<string, unknown> = {}): DocJSON => ({
      type: 'textBody',
      attrs: { kind, ...extra, ...dir },
      content: para.inline,
    });
    if (list && list.format !== 'none' && kind.kind === 'paragraph') {
      const key = `${numId}/${ilvl}`;
      const numberAttrs = !started.has(key) && list.start !== 1 ? { start: list.start } : {};
      const body =
        para.checkbox !== null
          ? textBody('checkItem', { checked: para.checkbox })
          : list.format === 'bullet'
            ? textBody('bulletItem')
            : textBody('numberedItem', numberAttrs);
      started.add(key);
      const item = blockOf(body, para.images);
      while (lists.length && lists[lists.length - 1].level >= ilvl) lists.pop();
      const parent = lists[lists.length - 1];
      if (parent) parent.item.content!.push(item);
      else out.push(item);
      lists.push({ level: ilvl, item });
      return;
    }
    lists = [];
    const body =
      para.checkbox !== null
        ? textBody('checkItem', { checked: para.checkbox })
        : textBody(kind.kind, kind.attrs);
    out.push(blockOf(body), ...para.images);
  };

  /** A table's cell: its paragraphs' text joined by line breaks (images go after the table). */
  const cellOf = (tc: XmlElement, images: DocJSON[], depth: number): DocJSON[] => {
    const inline: DocJSON[] = [];
    const take = (parent: XmlElement) => {
      for (const child of elements(parent)) {
        const name = local(child.name);
        if (name === 'p') {
          const para = readParagraph(child);
          if (para.inline.length && inline.length) inline.push({ type: 'hardBreak' });
          inline.push(...para.inline);
          images.push(...para.images);
        } else if (name === 'tbl') {
          // A table in a cell: its text, row by row.
          skip('nestedTables');
          if (depth > 4) continue;
          for (const tr of elements(child, 'tr'))
            for (const inner of elements(tr, 'tc')) {
              const text = cellOf(inner, images, depth + 1);
              if (text.length && inline.length) inline.push({ type: 'hardBreak' });
              inline.push(...text);
            }
        } else if (name === 'sdt') {
          const inner = element(child, 'sdtContent');
          if (inner) take(inner);
        }
      }
    };
    take(tc);
    return inline;
  };

  const table = (tbl: XmlElement) => {
    lists = [];
    code = null;
    first = false;
    const images: DocJSON[] = [];
    type Cell = { node: DocJSON; column: number; span: number; merge: string | null };
    const grid: Cell[][] = [];
    let headerRow = false;
    let firstRowBold = true;
    elements(tbl, 'tr').forEach((tr, rowIndex) => {
      const trPr = element(tr, 'trPr');
      if (rowIndex === 0 && element(trPr, 'tblHeader')) headerRow = true;
      const cells: Cell[] = [];
      let column = 0;
      for (const tc of elements(tr, 'tc')) {
        const tcPr = element(tc, 'tcPr');
        const span = Math.max(1, Number(attr(element(tcPr, 'gridSpan'), 'val') ?? 1) || 1);
        const vMerge = element(tcPr, 'vMerge');
        const merge = vMerge ? (attr(vMerge, 'val') ?? 'continue') : null;
        const inline = cellOf(tc, images, 0);
        const bold = (n: DocJSON) =>
          n.type !== 'text' ||
          !/\S/.test(n.text ?? '') ||
          !!n.marks?.some((m) => m.type === 'bold');
        if (rowIndex === 0 && !inline.every(bold)) firstRowBold = false;
        const node: DocJSON = {
          type: 'tableCell',
          attrs: { colspan: span, rowspan: 1 },
          ...(inline.length ? { content: inline } : {}),
        };
        cells.push({ node, column, span, merge });
        column += span;
      }
      grid.push(cells);
    });
    // Cells merged down: the first one spans the rows, the others are left out.
    for (let r = 0; r < grid.length; r++)
      for (const cell of grid[r]) {
        if (cell.merge !== 'restart') continue;
        let rows = 1;
        for (let below = r + 1; below < grid.length; below++) {
          const under = grid[below].find((c) => c.column === cell.column);
          if (!under || under.merge !== 'continue') break;
          rows++;
        }
        cell.node.attrs!.rowspan = rows;
      }
    const rows = grid.map((cells) => ({
      type: 'tableRow',
      content: cells.filter((c) => c.merge !== 'continue').map((c) => c.node),
    }));
    if (!rows.length) return;
    const hasFirstRowText = grid[0]?.some((c) => c.node.content?.length);
    out.push(
      blockOf({
        type: 'table',
        attrs: { headerRow: headerRow || (firstRowBold && !!hasFirstRowText && grid.length > 1) },
        content: rows,
      }),
      ...images,
    );
  };

  const walk = (parent: XmlElement, depth = 0) => {
    if (depth > 32) return;
    for (const child of elements(parent)) {
      // A page holds at most so many blocks; what is past them is counted, not read.
      if (made >= maxBlocks && /^(p|tbl)$/.test(local(child.name))) {
        skip('blocksLeftOut');
        continue;
      }
      switch (local(child.name)) {
        case 'p':
          paragraphBlock(readParagraph(child));
          break;
        case 'tbl':
          table(child);
          break;
        case 'sdt': {
          const inner = element(child, 'sdtContent');
          if (inner) walk(inner, depth + 1);
          break;
        }
        case 'customXml':
          walk(child, depth + 1);
          break;
        case 'ins':
        case 'moveTo':
          skip('trackedChanges');
          walk(child, depth + 1);
          break;
        case 'del':
        case 'moveFrom':
          skip('trackedChanges');
          break;
        case 'altChunk':
          skip('embeddedObjects');
          break;
      }
    }
  };
  walk(body);
  return { title, doc: { type: 'doc', content: out }, skipped };
}

/** Spaces at the start of a paragraph's first text and the end of its last are taken off. */
function trimInline(nodes: DocJSON[]) {
  while (nodes[0]?.type === 'hardBreak') nodes.shift();
  while (nodes[nodes.length - 1]?.type === 'hardBreak') nodes.pop();
  const head = nodes[0];
  if (head?.type === 'text') {
    head.text = head.text!.replace(/^[ \t]+/, '');
    if (!head.text) nodes.shift();
  }
  const tail = nodes[nodes.length - 1];
  if (tail?.type === 'text') {
    tail.text = tail.text!.replace(/[ \t]+$/, '');
    if (!tail.text) nodes.pop();
  }
}
