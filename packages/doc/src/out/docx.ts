// Phase 19: Word out (M19.2). A page, and its sub-pages each after a page break, written as a
// `.docx` package's parts: WordprocessingML of our own, no library, pure (the shell zips the parts
// in a worker). Held to Phase 8's reader (docx.ts) by a round trip, and to OOXML by
// DocumentFormat.OpenXml's validator over the writer's vectors in the server's tests.
//
// Every block of schema version 6: a page's title in Word's Title style (its icon before it);
// headings 1 to 3; paragraphs; bulleted and numbered lists by `numbering.xml` (each numbered run
// its own list, counting from its first item's start), check items as Word's check boxes (in a list
// of no marker, so they nest); quotes; callouts shaded by tone, their icon first; toggles open, as
// paragraphs with their children; code in a Code style, a paragraph a line; tables with their
// column widths, merged cells and header row; images at their width, at most the page's; files and
// bookmarks as their name and a link; a child page and a page mention as a link to the page's
// address in the app; a table of contents as Word's field with its lines filled in; a divider as a
// rule. A database block is a table of its view's rows, a chart and a sheet a picture, a plugin
// block its line, and what is not written a placeholder, as the shell resolved them. Marks: bold,
// italic, underline, strike, code (Consolas), text colour, highlight (Word's palette) and links.
// Each paragraph's direction is its block's (`w:bidi`), and each run of right-to-left letters is
// marked `w:rtl`. The layout is the section: paper, orientation, margins, and the header and the
// footer in three places each, with PAGE, NUMPAGES and STYLEREF fields.
//
// Fonts are Word's theme fonts (a theme part of our own names Calibri, and Arial for Arabic), with
// Consolas for code. Headings are larger and coloured, never bold, so the reader reads no mark the
// page did not have.
import { BAND_PLACES, bandParts, pageBox, type LayoutBand } from '@cgw/workspace/layout';
import type { DocJSON } from '../binding';
import {
  CALLOUT_TONES,
  TEXT_COLOURS,
  bodyDirection,
  dateText,
  flatten,
  headings,
  isRtlLetter,
  linkHref,
  mentionHref,
  mentionText,
  pageDirection,
  personText,
  resolved,
  type Direction,
  type FlatItem,
  type OutInput,
  type OutPage,
  type OutTable,
} from './model';

export interface DocxPart {
  /** Its path in the package, `word/document.xml`. */
  path: string;
  data: string | Uint8Array;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Word's highlight palette for the theme's tokens (the reader maps them back). */
const HIGHLIGHT: Record<string, string> = {
  yellow: 'yellow',
  green: 'green',
  blue: 'cyan',
  pink: 'magenta',
  red: 'red',
  purple: 'darkMagenta',
  brown: 'darkYellow',
  gray: 'lightGray',
  orange: 'yellow',
};

/** Image types Word draws; the shell turns others into PNG first. */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
};

const TWIPS_PER_MM = 1440 / 25.4;
const EMU_PER_MM = 36000;
const EMU_PER_PX = 9525;

/** Text as XML holds it: characters XML 1.0 refuses taken out, the five escaped. */
const UNWRITABLE = /[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
export const xml = (text: string): string =>
  text
    .replace(UNWRITABLE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  colour?: string | null;
  highlight?: string | null;
  style?: string;
}

/** A run's properties, in the order the schema sets (CT_RPr). */
function rPr(format: RunFormat, rtl: boolean): string {
  let out = '';
  if (format.style) out += `<w:rStyle w:val="${format.style}"/>`;
  if (format.code)
    out +=
      '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/>';
  if (format.bold) out += '<w:b/><w:bCs/>';
  if (format.italic) out += '<w:i/><w:iCs/>';
  if (format.strike) out += '<w:strike/>';
  if (format.colour) out += `<w:color w:val="${format.colour}"/>`;
  if (format.highlight) out += `<w:highlight w:val="${format.highlight}"/>`;
  if (format.underline) out += '<w:u w:val="single"/>';
  if (format.code) out += '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>';
  if (rtl) out += '<w:rtl/>';
  return out ? `<w:rPr>${out}</w:rPr>` : '';
}

/**
 * Text cut where its strong direction changes: a run of right-to-left letters (and the neutral
 * characters after it) is marked `w:rtl`, so Word draws it in its complex-script font and order.
 */
function scriptRuns(text: string): { text: string; rtl: boolean }[] {
  const out: { text: string; rtl: boolean }[] = [];
  let current = '';
  let rtl: boolean | null = null;
  for (const char of text) {
    const strong = /\p{L}/u.test(char) ? isRtlLetter(char) : null;
    if (strong !== null && rtl !== null && strong !== rtl) {
      out.push({ text: current, rtl });
      current = '';
    }
    if (strong !== null) rtl = strong;
    current += char;
  }
  if (current) out.push({ text: current, rtl: rtl ?? false });
  return out;
}

/** One run of text: tabs and line breaks as Word's own elements. */
function textRun(text: string, format: RunFormat, rtl: boolean): string {
  const props = rPr(format, rtl);
  const inner = text
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((part) => (part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : ''))
        .join('<w:tab/>'),
    )
    .join('<w:br/>');
  return `<w:r>${props}${inner}</w:r>`;
}

const runs = (text: string, format: RunFormat, paragraphRtl: boolean): string =>
  scriptRuns(text)
    .map((run) => textRun(run.text, format, run.rtl || (paragraphRtl && !/\p{L}/u.test(run.text))))
    .join('');

interface Context {
  input: OutInput;
  page: OutPage;
  /** Relationships of the document part, by id. */
  rels: { id: string; type: string; target: string; external?: boolean }[];
  /** Images written to the package, by asset id: their relationship and file. */
  images: Map<string, string>;
  media: DocxPart[];
  /** Bookmarks of headings (a table of contents' targets), by block id. */
  bookmarks: Map<string, { id: number; name: string }>;
  /** The next drawing's id (each `wp:docPr` has its own). */
  drawing: number;
  /** The numbered runs of the page being written: their `w:num` ids. */
  numbers: Map<number, number>;
  /** Every numbered run written: its `w:num` id, level and first number. */
  numbered: { numId: number; level: number; start: number }[];
  /** Content box, for images and tables: its width and height in EMU and in twips. */
  box: { widthEmu: number; heightEmu: number; widthTwips: number };
}

function relationship(ctx: Context, type: string, target: string, external = false): string {
  const known = ctx.rels.find(
    (r) => r.type === type && r.target === target && !!r.external === external,
  );
  if (known) return known.id;
  const id = `rId${ctx.rels.length + 1}`;
  ctx.rels.push({ id, type, target, ...(external ? { external } : {}) });
  return id;
}

/** A hyperlink to an outside address around its runs. */
function hyperlink(ctx: Context, href: string, inner: string): string {
  const id = relationship(ctx, `${REL}/hyperlink`, href, true);
  return `<w:hyperlink r:id="${id}" w:history="1">${inner}</w:hyperlink>`;
}

/** A body's inline content as runs, links and mentions. */
function inline(
  ctx: Context,
  nodes: readonly DocJSON[] | undefined,
  rtl: boolean,
  base: RunFormat = {},
): string {
  let out = '';
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text': {
        const format: RunFormat = { ...base };
        let href: string | null = null;
        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case 'bold':
              format.bold = true;
              break;
            case 'italic':
              format.italic = true;
              break;
            case 'underline':
              format.underline = true;
              break;
            case 'strike':
              format.strike = true;
              break;
            case 'code':
              format.code = true;
              break;
            case 'textColour':
              format.colour = TEXT_COLOURS[String(mark.attrs?.token)] ?? format.colour;
              break;
            case 'highlight':
              format.highlight = HIGHLIGHT[String(mark.attrs?.token)] ?? null;
              break;
            case 'link':
              href = linkHref(mark.attrs?.href, ctx.input);
              break;
          }
        }
        if (href) {
          const linked = { ...format, style: 'Hyperlink', underline: false };
          out += hyperlink(ctx, href, runs(node.text ?? '', linked, rtl));
        } else out += runs(node.text ?? '', format, rtl);
        break;
      }
      case 'hardBreak':
        out += '<w:r><w:br/></w:r>';
        break;
      case 'pageMention': {
        const text = mentionText(node, ctx.input);
        const href = mentionHref(node, ctx.input);
        out += href
          ? hyperlink(ctx, href, runs(text, { ...base, style: 'Hyperlink' }, rtl))
          : runs(text, base, rtl);
        break;
      }
      case 'dateMention':
        out += runs(dateText(node, ctx.input), base, rtl);
        break;
      case 'userMention':
        out += runs(personText(node, ctx.input), base, rtl);
        break;
      default:
        // An inline node this build does not know: the text it holds, if any.
        out += inline(ctx, node.content, rtl, base);
    }
  }
  return out;
}

interface ParagraphOptions {
  style?: string;
  numbering?: { numId: number; level: number };
  bidi: boolean;
  /** Start indent, in twips (a nested block that is not a list item). */
  indent?: number;
  justify?: 'left' | 'center' | 'right';
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  border?: { side: 'left' | 'bottom'; colour: string };
  fill?: string;
}

/** A paragraph's properties, in the order the schema sets (CT_PPr). */
function pPr(options: ParagraphOptions): string {
  let out = '';
  if (options.style) out += `<w:pStyle w:val="${options.style}"/>`;
  if (options.keepNext) out += '<w:keepNext/>';
  if (options.pageBreakBefore) out += '<w:pageBreakBefore/>';
  if (options.numbering)
    out += `<w:numPr><w:ilvl w:val="${options.numbering.level}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>`;
  if (options.border)
    out += `<w:pBdr><w:${options.border.side} w:val="single" w:sz="${options.border.side === 'left' ? 18 : 6}" w:space="${options.border.side === 'left' ? 8 : 1}" w:color="${options.border.colour}"/></w:pBdr>`;
  if (options.fill) out += `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>`;
  if (options.bidi) out += '<w:bidi/>';
  if (options.indent) out += `<w:ind w:left="${Math.round(options.indent)}"/>`;
  if (options.justify) out += `<w:jc w:val="${options.justify}"/>`;
  return out ? `<w:pPr>${out}</w:pPr>` : '';
}

const paragraph = (options: ParagraphOptions, content: string): string =>
  `<w:p>${pPr(options)}${content}</w:p>`;

/** A nested block's start indent: half an inch a level. */
const indentOf = (depth: number) => depth * 360;

function imageDrawing(
  ctx: Context,
  assetId: string,
  widthPx: number | null,
  alt: string,
): string | null {
  const asset = ctx.input.assets[assetId];
  const ext = asset?.bytes ? IMAGE_TYPES[asset.contentType.toLowerCase()] : undefined;
  if (!asset?.bytes || !ext) return null;
  let target = ctx.images.get(assetId);
  if (!target) {
    target = `media/image${ctx.images.size + 1}.${ext}`;
    ctx.images.set(assetId, target);
    ctx.media.push({ path: `word/${target}`, data: asset.bytes });
  }
  const rel = relationship(ctx, `${REL}/image`, target);
  const natural =
    asset.width && asset.height ? { w: asset.width, h: asset.height } : { w: 640, h: 480 };
  let cx = Math.round((widthPx && widthPx > 0 ? widthPx : natural.w) * EMU_PER_PX);
  cx = Math.min(cx, ctx.box.widthEmu);
  let cy = Math.round((cx * natural.h) / natural.w);
  if (cy > ctx.box.heightEmu) {
    cx = Math.round((cx * ctx.box.heightEmu) / cy);
    cy = ctx.box.heightEmu;
  }
  const id = ++ctx.drawing;
  const name = xml(asset.fileName || `image${id}.${ext}`);
  const descr = xml(alt);
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

const placeholder = (text: string, bidi: boolean, indent = 0): string =>
  paragraph({ style: 'Placeholder', bidi, indent }, runs(text, {}, bidi));

/** A table of cells' text (a database's rows, a row's properties). */
function textTable(
  ctx: Context,
  columns: string[] | null,
  rows: string[][],
  bidi: boolean,
  groups?: OutTable['groups'],
): string {
  const count = Math.max(1, columns?.length ?? rows[0]?.length ?? 1);
  const width = Math.floor(ctx.box.widthTwips / count);
  const cell = (text: string, span = 1) => {
    const rtl = bidi || textDirectionOf(text) === 'rtl';
    return (
      `<w:tc><w:tcPr><w:tcW w:w="${width * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>` +
      `${paragraph({ bidi: rtl }, runs(text, {}, rtl))}</w:tc>`
    );
  };
  const groupAt = new Map((groups ?? []).map((g) => [g.at, g]));
  let body = '';
  if (columns)
    body += `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map((c) => cell(c)).join('')}</w:tr>`;
  rows.forEach((row, i) => {
    const group = groupAt.get(i);
    if (group)
      body += `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(`${group.name} (${group.count})`, count)}</w:tr>`;
    body += `<w:tr><w:trPr><w:cantSplit/></w:trPr>${Array.from({ length: count }, (_, c) => cell(row[c] ?? '')).join('')}</w:tr>`;
  });
  const grid = Array.from({ length: count }, () => `<w:gridCol w:w="${width}"/>`).join('');
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="CgwTable"/>${bidi ? '<w:bidiVisual/>' : ''}` +
    `<w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="${columns ? 1 : 0}" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
    // A table is never a body's last element.
    '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
  );
}

const textDirectionOf = (text: string): Direction | null => {
  for (const char of text) if (/\p{L}/u.test(char)) return isRtlLetter(char) ? 'rtl' : 'ltr';
  return null;
};

/** A table block of the page: its grid, column widths, merged cells and header row and column. */
function pageTable(ctx: Context, table: DocJSON, fallback: Direction): string {
  const rows = (table.content ?? []).filter((r) => r.type === 'tableRow');
  const cellsOf = (row: DocJSON) => (row.content ?? []).filter((c) => c.type === 'tableCell');
  const span = (cell: DocJSON, key: 'colspan' | 'rowspan') =>
    Math.min(1000, Math.max(1, Math.floor(Number(cell.attrs?.[key]) || 1)));
  // The grid: as many columns as the widest row covers, merged cells counted.
  const carry = new Map<number, number>();
  let columns = 0;
  const placed: { cell: DocJSON | null; column: number; colspan: number; restart: boolean }[][] =
    [];
  for (const row of rows) {
    const line: (typeof placed)[number] = [];
    let column = 0;
    const queue = [...cellsOf(row)];
    while (queue.length || [...carry.keys()].some((c) => c >= column)) {
      const below = carry.get(column);
      if (below !== undefined && below > 0) {
        const colspan = placed.at(-1)?.find((p) => p.column === column)?.colspan ?? 1;
        line.push({ cell: null, column, colspan, restart: false });
        carry.set(column, below - 1);
        if (carry.get(column) === 0) carry.delete(column);
        column += colspan;
        continue;
      }
      const cell = queue.shift();
      if (!cell) {
        column++;
        continue;
      }
      const colspan = span(cell, 'colspan');
      const rowspan = span(cell, 'rowspan');
      line.push({ cell, column, colspan, restart: rowspan > 1 });
      if (rowspan > 1) carry.set(column, rowspan - 1);
      column += colspan;
    }
    columns = Math.max(columns, column);
    placed.push(line);
  }
  columns = Math.max(1, columns);
  // Widths: the first row's own (pixels), else equal; scaled to the page when wider.
  const widths: (number | null)[] = Array.from({ length: columns }, () => null);
  for (const p of placed[0] ?? []) {
    const own = p.cell?.attrs?.colwidth;
    if (Array.isArray(own))
      own.forEach((w, i) => {
        if (typeof w === 'number' && w > 0 && p.column + i < columns) widths[p.column + i] = w * 15;
      });
  }
  const known = widths.reduce<number>((n, w) => n + (w ?? 0), 0);
  const unknown = widths.filter((w) => w === null).length;
  const rest = unknown ? Math.max(720, (ctx.box.widthTwips - known) / unknown) : 0;
  let twips = widths.map((w) => w ?? rest);
  const total = twips.reduce((n, w) => n + w, 0);
  if (total > ctx.box.widthTwips) twips = twips.map((w) => (w * ctx.box.widthTwips) / total);
  twips = twips.map((w) => Math.max(1, Math.round(w)));
  const headerRow = !!table.attrs?.headerRow;
  const headerColumn = !!table.attrs?.headerColumn;
  let body = '';
  placed.forEach((line, r) => {
    let row = r === 0 && headerRow ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    for (const p of line) {
      const width = twips.slice(p.column, p.column + p.colspan).reduce((n, w) => n + w, 0);
      const props =
        `<w:tcW w:w="${width}" w:type="dxa"/>` +
        (p.colspan > 1 ? `<w:gridSpan w:val="${p.colspan}"/>` : '') +
        (p.cell === null ? '<w:vMerge/>' : p.restart ? '<w:vMerge w:val="restart"/>' : '');
      if (!p.cell) {
        row += `<w:tc><w:tcPr>${props}</w:tcPr><w:p/></w:tc>`;
        continue;
      }
      const dir = bodyDirection(p.cell, ctx.input, fallback);
      row += `<w:tc><w:tcPr>${props}</w:tcPr>${paragraph({ bidi: dir === 'rtl' }, inline(ctx, p.cell.content, dir === 'rtl'))}</w:tc>`;
    }
    body += `<w:tr>${row}</w:tr>`;
  });
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="CgwTable"/><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="${headerRow ? 1 : 0}" w:lastRow="0" w:firstColumn="${headerColumn ? 1 : 0}" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid>${twips.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${body}</w:tbl>` +
    '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
  );
}

/** The table of contents: Word's TOC field, its lines filled in as links to the headings. */
function contents(ctx: Context, bidi: boolean): string {
  const list = headings(ctx.page.content, ctx.input).filter((h) => h.id && ctx.bookmarks.has(h.id));
  if (!list.length) return placeholder(ctx.input.words.noHeadings, bidi);
  return list
    .map((h, i) => {
      const mark = ctx.bookmarks.get(h.id!)!;
      const rtl = textDirectionOf(h.text) === 'rtl' || (bidi && !textDirectionOf(h.text));
      const begin =
        i === 0
          ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
          : '';
      const end = i === list.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
      return paragraph(
        { style: `TOC${h.level}`, bidi: rtl },
        `${begin}<w:hyperlink w:anchor="${mark.name}" w:history="1">${runs(h.text, {}, rtl)}</w:hyperlink>${end}`,
      );
    })
    .join('');
}

/** A body of the page, at its place among the flat items. */
function body(ctx: Context, item: FlatItem, numId: (item: FlatItem) => number): string {
  const { input, page } = ctx;
  const { body: node, block, depth } = item;
  const fallback = pageDirection(page, input);
  const dir = bodyDirection(node, input, fallback);
  const rtl = dir === 'rtl';
  const indent = item.list ? undefined : indentOf(depth);
  const attrs = node.attrs ?? {};
  const shown = item.first ? resolved(page, block) : undefined;
  switch (node.type) {
    case 'textBody': {
      const kind = String(attrs.kind ?? 'paragraph');
      const colour = TEXT_COLOURS[String(attrs.colour)] ?? null;
      const base: RunFormat = colour ? { colour } : {};
      let content = inline(ctx, node.content, rtl, base);
      if (item.list) {
        const numbering = { numId: numId(item), level: item.list.level };
        if (item.list.kind === 'check') {
          const checked = attrs.checked === true;
          content =
            `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/>` +
            '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/>' +
            `</w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic" w:eastAsia="MS Gothic" w:hint="eastAsia"/></w:rPr><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt>` +
            `<w:r><w:t xml:space="preserve"> </w:t></w:r>${content}`;
        }
        return paragraph({ style: 'ListParagraph', numbering, bidi: rtl }, content);
      }
      switch (kind) {
        case 'heading': {
          const level = Math.min(3, Math.max(1, Number(attrs.level) || 1));
          const id = typeof block.attrs?.id === 'string' ? block.attrs.id : null;
          let marked = content;
          if (id && item.first) {
            const mark = {
              id: ctx.bookmarks.size + 1,
              name: `_Toc${String(ctx.bookmarks.size + 1).padStart(6, '0')}`,
            };
            ctx.bookmarks.set(id, mark);
            marked = `<w:bookmarkStart w:id="${mark.id}" w:name="${mark.name}"/>${content}<w:bookmarkEnd w:id="${mark.id}"/>`;
          }
          return paragraph({ style: `Heading${level}`, bidi: rtl, indent }, marked);
        }
        case 'quote':
          return paragraph({ style: 'Quote', bidi: rtl, indent }, content);
        case 'callout': {
          const tone = CALLOUT_TONES[String(attrs.tone)] ?? CALLOUT_TONES.neutral;
          const icon =
            typeof attrs.icon === 'string' && attrs.icon ? runs(`${attrs.icon} `, {}, rtl) : '';
          return paragraph(
            {
              style: 'Callout',
              bidi: rtl,
              indent,
              border: { side: 'left', colour: tone.edge },
              fill: tone.fill,
            },
            icon + content,
          );
        }
        default:
          // A paragraph, and a toggle (open: its children follow it).
          return paragraph({ bidi: rtl, indent }, content);
      }
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((n) => n.text ?? '').join('');
      return text
        .split('\n')
        .map((line) =>
          paragraph({ style: 'Code', bidi: false, indent }, line ? textRun(line, {}, false) : ''),
        )
        .join('');
    }
    case 'divider':
      return paragraph({ bidi: false, indent, border: { side: 'bottom', colour: 'BFBFBF' } }, '');
    case 'table':
      return pageTable(ctx, node, fallback);
    case 'image': {
      const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
      if (!assetId) return '';
      const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
      const drawing = imageDrawing(ctx, assetId, Number(attrs.width) || null, alt);
      const align = attrs.align === 'center' ? 'center' : attrs.align === 'end' ? 'right' : 'left';
      const caption = typeof attrs.caption === 'string' && attrs.caption ? attrs.caption : null;
      const captionDir = caption ? (textDirectionOf(caption) ?? fallback) === 'rtl' : false;
      const out = drawing
        ? paragraph({ bidi: fallback === 'rtl', indent, justify: align }, drawing)
        : placeholder(
            alt ? `${input.words.missingImage}: ${alt}` : input.words.missingImage,
            fallback === 'rtl',
            indent,
          );
      return (
        out +
        (caption
          ? paragraph(
              { style: 'Caption', bidi: captionDir, indent, justify: align },
              runs(caption, {}, captionDir),
            )
          : '')
      );
    }
    case 'file': {
      const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
      if (!assetId) return '';
      const asset = input.assets[assetId];
      const name = asset?.fileName || input.words.missingFile;
      const frtl = (textDirectionOf(name) ?? fallback) === 'rtl';
      return paragraph({ bidi: frtl, indent }, runs(`📎 ${name}`, {}, frtl));
    }
    case 'bookmark': {
      const href = linkHref(attrs.url, input);
      if (!href) return '';
      return paragraph(
        { bidi: false, indent },
        hyperlink(ctx, href, runs(href, { style: 'Hyperlink' }, false)),
      );
    }
    case 'childPage': {
      const target = input.links[String(attrs.pageId ?? '')];
      const text = target
        ? `${target.icon ? `${target.icon} ` : ''}${target.title || input.words.untitled}`
        : input.words.aPage;
      const crtl = (textDirectionOf(text) ?? fallback) === 'rtl';
      const content = target?.href
        ? hyperlink(ctx, target.href, runs(text, { style: 'Hyperlink' }, crtl))
        : runs(text, {}, crtl);
      return paragraph({ bidi: crtl, indent }, content);
    }
    case 'tableOfContents':
      // Written after the headings have their bookmarks: a mark the second pass fills.
      return `<!--toc-->`;
    default: {
      if (!shown) {
        // A block this build does not know, or one the shell resolved nothing for: its text.
        const text = (node.content ?? []).length ? inline(ctx, node.content, rtl) : '';
        return text
          ? paragraph({ bidi: rtl, indent }, text)
          : placeholder(input.words.unknownBlock, fallback === 'rtl', indent);
      }
      return outBlock(ctx, shown, fallback, indent ?? 0);
    }
  }
}

/** A block the shell resolved: a table, a drawing, a line or a placeholder. */
function outBlock(
  ctx: Context,
  shown: NonNullable<ReturnType<typeof resolved>>,
  fallback: Direction,
  indent: number,
): string {
  const bidi = fallback === 'rtl';
  switch (shown.kind) {
    case 'table': {
      const title = shown.title
        ? paragraph(
            {
              style: 'TableTitle',
              bidi: (textDirectionOf(shown.title) ?? fallback) === 'rtl',
              indent,
              keepNext: true,
            },
            runs(shown.title, {}, (textDirectionOf(shown.title) ?? fallback) === 'rtl'),
          )
        : '';
      const more =
        shown.more > 0 && shown.moreText ? placeholder(shown.moreText, bidi, indent) : '';
      return title + textTable(ctx, shown.columns, shown.rows, bidi, shown.groups) + more;
    }
    case 'chart':
    case 'picture': {
      const drawing = shown.image ? imageDrawing(ctx, shown.image, null, shown.title) : null;
      const caption = shown.title
        ? paragraph(
            {
              style: 'Caption',
              bidi: (textDirectionOf(shown.title) ?? fallback) === 'rtl',
              indent,
            },
            runs(shown.title, {}, (textDirectionOf(shown.title) ?? fallback) === 'rtl'),
          )
        : '';
      return (
        (drawing
          ? paragraph({ bidi, indent }, drawing)
          : placeholder(shown.title || ctx.input.words.missingImage, bidi, indent)) + caption
      );
    }
    case 'text': {
      const rtl = (textDirectionOf(shown.text) ?? fallback) === 'rtl';
      return paragraph({ bidi: rtl, indent }, runs(shown.text, {}, rtl));
    }
    case 'placeholder':
      // The interface's words: the page's direction, whatever they start with.
      return placeholder(shown.text, bidi, indent);
  }
}

/** A page's body: its title, a row's properties, its blocks; a sub-page starts a page. */
function pageXml(ctx: Context, first: boolean, numId: (item: FlatItem) => number): string {
  const { page, input } = ctx;
  const dir = pageDirection(page, input);
  const rtl = dir === 'rtl';
  const title = `${page.icon ? `${page.icon} ` : ''}${page.title || input.words.untitled}`;
  let out = paragraph({ style: 'Title', bidi: rtl, pageBreakBefore: !first }, runs(title, {}, rtl));
  if (page.properties?.length)
    out += textTable(
      ctx,
      null,
      page.properties.map((p) => [p.name, p.text]),
      rtl,
    );
  const items = flatten(page.content);
  const parts = items.map((item) => body(ctx, item, numId));
  // The table of contents goes in once the headings have their bookmarks.
  return out + parts.join('').replace(/<!--toc-->/g, () => contents(ctx, rtl));
}

/** A header's or a footer's three places, as a table of three cells of no border. */
function band(
  band: LayoutBand,
  input: OutInput,
  widthTwips: number,
  rtl: boolean,
  kind: 'hdr' | 'ftr',
): string {
  const third = Math.floor(widthTwips / 3);
  const title = input.pages[0]?.title || input.words.untitled;
  const cells = BAND_PLACES.map((place, i) => {
    const parts = bandParts(band[place]);
    let content = '';
    for (const part of parts) {
      if ('text' in part) content += runs(part.text, {}, rtl);
      else if (part.field === 'date') content += runs(input.date, {}, rtl);
      else if (part.field === 'title')
        content += `<w:fldSimple w:instr=" STYLEREF Title \\* MERGEFORMAT ">${runs(title, {}, rtl)}</w:fldSimple>`;
      else
        content += `<w:fldSimple w:instr=" ${part.field === 'page' ? 'PAGE' : 'NUMPAGES'} \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
    }
    const justify = i === 0 ? 'left' : i === 1 ? 'center' : 'right';
    return `<w:tc><w:tcPr><w:tcW w:w="${third}" w:type="dxa"/></w:tcPr>${paragraph({ style: kind === 'hdr' ? 'Header' : 'Footer', bidi: rtl, justify }, content)}</w:tc>`;
  }).join('');
  return (
    `<w:${kind} xmlns:w="${W}" xmlns:r="${R}">` +
    `<w:tbl><w:tblPr>${rtl ? '<w:bidiVisual/>' : ''}<w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
    '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
    `<w:tblGrid><w:gridCol w:w="${third}"/><w:gridCol w:w="${third}"/><w:gridCol w:w="${third}"/></w:tblGrid>` +
    `<w:tr>${cells}</w:tr></w:tbl>` +
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>` +
    `</w:${kind}>`
  );
}

/** Writes the page (and its sub-pages) as a Word package's parts. */
export function writeDocx(input: OutInput): DocxPart[] {
  const box = pageBox(input.layout);
  const widthTwips = Math.round((box.width - 2 * box.inline) * TWIPS_PER_MM);
  const ctx: Omit<Context, 'page'> = {
    input,
    rels: [
      { id: 'rId1', type: `${REL}/styles`, target: 'styles.xml' },
      { id: 'rId2', type: `${REL}/numbering`, target: 'numbering.xml' },
      { id: 'rId3', type: `${REL}/settings`, target: 'settings.xml' },
      { id: 'rId4', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    ],
    images: new Map(),
    media: [],
    bookmarks: new Map(),
    drawing: 0,
    numbers: new Map(),
    numbered: [],
    box: {
      widthEmu: Math.round((box.width - 2 * box.inline) * EMU_PER_MM),
      // A picture is never taller than the page's content, less a line for its caption.
      heightEmu: Math.round((box.height - 2 * box.block - 12) * EMU_PER_MM),
      widthTwips,
    },
  };
  const rtl = input.pages[0]
    ? pageDirection(input.pages[0], input) === 'rtl'
    : input.language === 'ar';
  // Numbering: 1 the bullets, 2 the check items, then one list for each numbered run.
  const numId = (item: FlatItem) => {
    const list = item.list!;
    if (list.kind === 'bullet') return 1;
    if (list.kind === 'check') return 2;
    const known = ctx.numbers.get(list.run);
    if (known) return known;
    const id = 3 + ctx.numbered.length;
    ctx.numbers.set(list.run, id);
    ctx.numbered.push({ numId: id, level: list.level, start: list.number });
    return id;
  };
  let bodyXml = '';
  input.pages.forEach((page, i) => {
    // Each page's numbered runs are its own: their keys hold the page's index.
    ctx.numbers.clear();
    bodyXml += pageXml({ ...ctx, page } as Context, i === 0, numId);
  });
  const header = input.layout.header;
  const footer = input.layout.footer;
  const headerRel = relationship(ctx as Context, `${REL}/header`, 'header1.xml');
  const footerRel = relationship(ctx as Context, `${REL}/footer`, 'footer1.xml');
  const [paperW, paperH] = [box.width, box.height].map((mm) => Math.round(mm * TWIPS_PER_MM));
  const marginBlock = Math.round(box.block * TWIPS_PER_MM);
  const marginInline = Math.round(box.inline * TWIPS_PER_MM);
  const edge = Math.min(720, Math.round(marginBlock / 2));
  const sectPr =
    `<w:sectPr><w:headerReference w:type="default" r:id="${headerRel}"/><w:footerReference w:type="default" r:id="${footerRel}"/>` +
    `<w:pgSz w:w="${paperW}" w:h="${paperH}"${input.layout.orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${marginBlock}" w:right="${marginInline}" w:bottom="${marginBlock}" w:left="${marginInline}" w:header="${edge}" w:footer="${edge}" w:gutter="0"/>` +
    `<w:cols w:space="720"/>${rtl ? '<w:bidi/>' : ''}<w:docGrid w:linePitch="360"/></w:sectPr>`;
  const document =
    `${HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:w14="${W14}" xmlns:mc="${MC}" mc:Ignorable="w14">` +
    `<w:body>${bodyXml}${sectPr}</w:body></w:document>`;
  const relsXml =
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    ctx.rels
      .map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${r.type}" Target="${xml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
      )
      .join('') +
    '</Relationships>';
  const types = new Set(ctx.media.map((m) => m.path.split('.').pop()!));
  const contentTypes =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    [...types]
      .sort()
      .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`)
      .join('') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const when = new Date(input.madeAt);
  const stamp = Number.isNaN(when.getTime())
    ? '2026-01-01T00:00:00Z'
    : when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = input.pages[0]?.title || input.words.untitled;
  return [
    { path: '[Content_Types].xml', data: contentTypes },
    {
      path: '_rels/.rels',
      data:
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>',
    },
    {
      path: 'docProps/core.xml',
      data:
        `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${xml(title)}</dc:title><dc:language>${input.language === 'ar' ? 'ar' : 'en'}</dc:language>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
        '</cp:coreProperties>',
    },
    {
      path: 'docProps/app.xml',
      data: `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Cash Gear Workspace</Application></Properties>`,
    },
    { path: 'word/document.xml', data: document },
    { path: 'word/_rels/document.xml.rels', data: relsXml },
    { path: 'word/styles.xml', data: STYLES },
    { path: 'word/numbering.xml', data: numbering(ctx.numbered) },
    { path: 'word/settings.xml', data: SETTINGS },
    { path: 'word/theme/theme1.xml', data: THEME },
    { path: 'word/header1.xml', data: HEAD + band(header, input, widthTwips, rtl, 'hdr') },
    { path: 'word/footer1.xml', data: HEAD + band(footer, input, widthTwips, rtl, 'ftr') },
    ...ctx.media,
  ];
}

const BULLETS = ['•', '◦', '▪'];

/** The lists: bullets (1), check items with no marker (2), and each numbered run of its own. */
function numbering(numbered: { numId: number; level: number; start: number }[]): string {
  const levels = (text: (i: number) => string, format: (i: number) => string) =>
    Array.from(
      { length: 9 },
      (_, i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${format(i)}"/><w:lvlText w:val="${text(i)}"/>` +
        `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`,
    ).join('');
  const abstract = (id: number, name: string, body: string) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/><w:name w:val="${name}"/>${body}</w:abstractNum>`;
  return (
    `${HEAD}<w:numbering xmlns:w="${W}">` +
    abstract(
      0,
      'Bullets',
      levels(
        (i) => BULLETS[i % 3],
        () => 'bullet',
      ),
    ) +
    abstract(
      1,
      'Numbers',
      levels(
        (i) => `%${i + 1}.`,
        () => 'decimal',
      ),
    ) +
    abstract(
      2,
      'Checks',
      levels(
        () => '',
        () => 'bullet',
      ),
    ) +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
    numbered
      .map(
        (n) =>
          `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="1"/>` +
          Array.from(
            { length: 9 },
            (_, i) =>
              `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="${i === n.level ? n.start : 1}"/></w:lvlOverride>`,
          ).join('') +
          '</w:num>',
      )
      .join('') +
    '</w:numbering>'
  );
}

const paragraphStyle = (
  id: string,
  name: string,
  { pPr = '', rPr = '', next = 'Normal', basedOn = 'Normal', extra = '' } = {},
) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/>` +
  `<w:next w:val="${next}"/>${extra}<w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;

const heading = (level: number, size: number, colour: string) =>
  paragraphStyle(`Heading${level}`, `heading ${level}`, {
    pPr: `<w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/>`,
    rPr: `<w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="${colour}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
  });

const STYLES =
  `${HEAD}<w:styles xmlns:w="${W}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  paragraphStyle('Title', 'Title', {
    pPr: '<w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>',
    rPr: '<w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/>',
  }) +
  heading(1, 32, '2F5496') +
  heading(2, 26, '2F5496') +
  heading(3, 24, '1F3763') +
  paragraphStyle('Quote', 'Quote', {
    pPr: '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="360"/>',
    rPr: '<w:color w:val="404040"/>',
  }) +
  paragraphStyle('Callout', 'Callout', {
    pPr: '<w:spacing w:before="120" w:after="120"/><w:ind w:left="240" w:right="240"/>',
  }) +
  paragraphStyle('Code', 'Code', {
    next: 'Code',
    pPr: '<w:shd w:val="clear" w:color="auto" w:fill="F6F6F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>',
    rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/>',
  }) +
  paragraphStyle('ListParagraph', 'List Paragraph', {
    pPr: '<w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/>',
  }) +
  paragraphStyle('Caption', 'caption', {
    pPr: '<w:spacing w:after="200"/>',
    rPr: '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
  }) +
  paragraphStyle('Placeholder', 'Placeholder', {
    pPr: '<w:pBdr><w:top w:val="dashed" w:sz="4" w:space="4" w:color="A6A6A6"/><w:left w:val="dashed" w:sz="4" w:space="4" w:color="A6A6A6"/><w:bottom w:val="dashed" w:sz="4" w:space="4" w:color="A6A6A6"/><w:right w:val="dashed" w:sz="4" w:space="4" w:color="A6A6A6"/></w:pBdr>',
    rPr: '<w:color w:val="595959"/>',
  }) +
  paragraphStyle('TableTitle', 'Table Title', {
    pPr: '<w:keepNext/><w:spacing w:before="120" w:after="60"/>',
    rPr: '<w:color w:val="404040"/>',
  }) +
  paragraphStyle('Header', 'header', {
    pPr: '<w:spacing w:after="0"/>',
    rPr: '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
  }) +
  paragraphStyle('Footer', 'footer', {
    pPr: '<w:spacing w:after="0"/>',
    rPr: '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
  }) +
  [1, 2, 3]
    .map((level) =>
      paragraphStyle(`TOC${level}`, `toc ${level}`, {
        pPr: `<w:spacing w:after="60"/><w:ind w:left="${(level - 1) * 240}"/>`,
      }),
    )
    .join('') +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="CgwTable"><w:name w:val="Cash Gear Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
  '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders>' +
  '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
  '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr></w:tblStylePr>' +
  '<w:tblStylePr w:type="firstCol"><w:rPr><w:b/><w:bCs/></w:rPr></w:tblStylePr>' +
  '</w:style>' +
  '</w:styles>';

const SETTINGS =
  `${HEAD}<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const THEME =
  `${HEAD}<a:theme xmlns:a="${A}" name="Cash Gear">` +
  '<a:themeElements><a:clrScheme name="Cash Gear">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
    .map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`)
    .join('') +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Cash Gear">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Arab" typeface="Arial"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Arab" typeface="Arial"/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="Cash Gear">' +
  `<a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
  `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${solid}</a:ln>`).join('')}</a:lnStyleLst>` +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst>` +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
