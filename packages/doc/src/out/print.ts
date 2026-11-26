// Phase 19: the print view (M19.3), a renderer of its own over the page's JSON, never the editor:
// every block drawn, nothing lazy or virtualised, as HTML and CSS the shell puts in the app's own
// document under print media (the spike, DECISIONS.md 2026-11-26: WebView2 saves only its top
// document to a PDF, and WKWebView prints only its main frame). The same input as the Word writer.
//
// Two modes. `css`, for Chromium (Chrome, Edge, the Windows app): the layout is `@page`'s size and
// margins, the header and the footer are its margin boxes (`counter(page)` and `counter(pages)`),
// and the engine breaks the flow into pages. `paged`, for WebKit (the Mac app), which draws no
// margin boxes and takes no `@page` margin: the same flow, which the shell cuts into page boxes of
// the paper's size by script (shell/src/print/paginate.ts), each with its header and footer drawn
// from `bands`; `@page`'s margin is 0, and the Mac's print info's too.
//
// Each page and sub-page is a section (each after a page break), its direction its own: its title
// (icon first), a row's properties as a table, then each body as a unit (`.pv-u`), nested blocks
// indented, list items with their marker drawn (a number counted as the editor counts, a check box
// as a box). An image is never taller than the page's content, so none is cut over two pages, and
// table rows are kept whole. A chart's SVG is drawn as an image (no script can run in it). The
// fonts write Arabic's own letters into a PDF's text: Segoe UI on Windows, Tahoma on the Mac.
import {
  BAND_PLACES,
  bandParts,
  pageBox,
  type BandPlace,
  type LayoutBand,
} from '@cgw/workspace/layout';
import type { DocJSON } from '../binding';
import {
  CALLOUT_TONES,
  HIGHLIGHT_COLOURS,
  TEXT_COLOURS,
  bodyDirection,
  dateText,
  flatten,
  headings,
  linkHref,
  mentionHref,
  mentionText,
  pageDirection,
  personText,
  resolved,
  textDirection,
  type Direction,
  type FlatItem,
  type OutBlock,
  type OutInput,
  type OutPage,
} from './model';

export type PrintMode = 'css' | 'paged';

/**
 * The fonts the print view names: Segoe UI (Windows) and Tahoma (the Mac) write Arabic's own
 * letters into a PDF's text, where the generic `sans-serif` (Arial) writes initial yeh as the
 * Farsi letter and the Mac's system font dotless letters with their dots apart.
 */
export const PRINT_FONTS = '"Segoe UI", Tahoma, "Geeza Pro", system-ui, sans-serif';
const CODE_FONTS = 'Consolas, Menlo, "Cascadia Mono", monospace';

export interface PrintBand {
  /** Each place's HTML, `{page}` and `{pages}` left as `<span data-field="page">` to fill. */
  places: Record<BandPlace, string>;
}

export interface PrintView {
  /** The stylesheet: the view's own rules, then `@page` (put under print media by the shell). */
  css: string;
  /** `@page` and the margin boxes, apart (the shell puts them under print media). */
  pageCss: string;
  html: string;
  /** The document's title while it prints (the PDF's name): the page's. */
  title: string;
  /** The paper and margins in millimetres, as the page lies. */
  box: { width: number; height: number; block: number; inline: number };
  /** Paged mode: each section's header and footer, by section, and its direction. */
  bands: {
    header: PrintBand;
    footer: PrintBand;
    dir: Direction;
    shown: { header: boolean; footer: boolean };
  }[];
}

const esc = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu, (c) =>
      c === '\n' || c === '\t' ? c : '',
    )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Text as a CSS string holds it. */
const cssString = (text: string): string =>
  `"${text
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;

interface Ctx {
  input: OutInput;
  page: OutPage;
  dir: Direction;
}

function inline(ctx: Ctx, nodes: readonly DocJSON[] | undefined, links = true): string {
  let out = '';
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text': {
        let open = '';
        let close = '';
        const wrap = (start: string, end: string) => {
          open += start;
          close = end + close;
        };
        for (const mark of node.marks ?? []) {
          const token = String(mark.attrs?.token ?? '');
          switch (mark.type) {
            case 'bold':
              wrap('<strong>', '</strong>');
              break;
            case 'italic':
              wrap('<em>', '</em>');
              break;
            case 'underline':
              wrap('<u>', '</u>');
              break;
            case 'strike':
              wrap('<s>', '</s>');
              break;
            case 'code':
              wrap('<code>', '</code>');
              break;
            case 'textColour':
              if (TEXT_COLOURS[token]) wrap(`<span class="pv-c-${token}">`, '</span>');
              break;
            case 'highlight':
              if (HIGHLIGHT_COLOURS[token]) wrap(`<mark class="pv-h-${token}">`, '</mark>');
              break;
            case 'link': {
              const href = links ? linkHref(mark.attrs?.href, ctx.input) : null;
              if (href) wrap(`<a href="${esc(href)}">`, '</a>');
              break;
            }
          }
        }
        out += open + esc(node.text ?? '').replace(/\n/g, '<br>') + close;
        break;
      }
      case 'hardBreak':
        out += '<br>';
        break;
      case 'pageMention': {
        const href = links ? mentionHref(node, ctx.input) : null;
        const text = esc(mentionText(node, ctx.input));
        out += href
          ? `<a class="pv-mention" href="${esc(href)}">${text}</a>`
          : `<span class="pv-mention">${text}</span>`;
        break;
      }
      case 'dateMention':
        out += `<time>${esc(dateText(node, ctx.input))}</time>`;
        break;
      case 'userMention':
        out += `<span class="pv-mention">${esc(personText(node, ctx.input))}</span>`;
        break;
      default:
        out += inline(ctx, node.content, links);
    }
  }
  return out;
}

const dirAttr = (dir: Direction) => ` dir="${dir}"`;

/** A unit's indent and its block's id (a table of contents' target). */
function unit(item: FlatItem, classes: string, dir: Direction, inner: string, tag = 'div'): string {
  const id =
    item.first && typeof item.block.attrs?.id === 'string'
      ? ` id="pv-${esc(item.block.attrs.id)}"`
      : '';
  const indent = item.depth ? ` style="margin-inline-start:${item.depth * 20}pt"` : '';
  return `<${tag} class="pv-u ${classes}"${id}${dirAttr(dir)}${indent}>${inner}</${tag}>`;
}

/** A number as the editor's lists count: decimal at every level. */
const marker = (item: FlatItem, checked: boolean): string => {
  const list = item.list!;
  if (list.kind === 'check')
    return `<span class="pv-box${checked ? ' pv-done' : ''}" aria-hidden="true">${checked ? '☑' : '☐'}</span>`;
  if (list.kind === 'number') return `<span class="pv-mark">${list.number}.</span>`;
  return `<span class="pv-mark">${['•', '◦', '▪'][list.level % 3]}</span>`;
};

function textTable(
  columns: string[] | null,
  rows: string[][],
  groups?: { name: string; at: number; count: number }[],
): string {
  const count = Math.max(1, columns?.length ?? rows[0]?.length ?? 1);
  const cell = (text: string, tag = 'td', span = 1) => {
    const own = textDirection(text);
    return `<${tag}${span > 1 ? ` colspan="${span}"` : ''}${own ? dirAttr(own) : ''}><div>${esc(text).replace(/\n/g, '<br>')}</div></${tag}>`;
  };
  const at = new Map((groups ?? []).map((g) => [g.at, g]));
  let body = '';
  rows.forEach((row, i) => {
    const group = at.get(i);
    if (group)
      body += `<tr class="pv-group">${cell(`${group.name} (${group.count})`, 'th', count)}</tr>`;
    body += `<tr>${Array.from({ length: count }, (_, c) => cell(row[c] ?? '')).join('')}</tr>`;
  });
  const head = columns
    ? `<thead><tr>${columns.map((c) => cell(c, 'th')).join('')}</tr></thead>`
    : '';
  return `<table class="pv-table${columns ? '' : ' pv-props'}">${head}<tbody>${body}</tbody></table>`;
}

function pageTable(ctx: Ctx, table: DocJSON): string {
  const rows = (table.content ?? []).filter((r) => r.type === 'tableRow');
  const headerRow = !!table.attrs?.headerRow;
  const headerColumn = !!table.attrs?.headerColumn;
  // Fixed columns from the first row's widths, so a table cut over pages lines up.
  const first = (rows[0]?.content ?? []).filter((c) => c.type === 'tableCell');
  const widths: (number | null)[] = [];
  for (const cell of first) {
    const span = Math.max(1, Math.floor(Number(cell.attrs?.colspan) || 1));
    const own = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : [];
    for (let i = 0; i < span; i++)
      widths.push(typeof own[i] === 'number' && (own[i] as number) > 0 ? (own[i] as number) : null);
  }
  const cols = widths.length
    ? `<colgroup>${widths.map((w) => (w ? `<col style="width:${w}px">` : '<col>')).join('')}</colgroup>`
    : '';
  let head = '';
  let body = '';
  rows.forEach((row, r) => {
    const cells = (row.content ?? []).filter((c) => c.type === 'tableCell');
    const line = cells
      .map((cell, c) => {
        const tag = (r === 0 && headerRow) || (c === 0 && headerColumn) ? 'th' : 'td';
        const colspan = Math.min(1000, Math.max(1, Math.floor(Number(cell.attrs?.colspan) || 1)));
        const rowspan = Math.min(1000, Math.max(1, Math.floor(Number(cell.attrs?.rowspan) || 1)));
        const dir = bodyDirection(cell, ctx.input, ctx.dir);
        return `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${dirAttr(dir)}><div>${inline(ctx, cell.content)}</div></${tag}>`;
      })
      .join('');
    if (r === 0 && headerRow) head = `<thead><tr>${line}</tr></thead>`;
    else body += `<tr>${line}</tr>`;
  });
  return `<table class="pv-table">${cols}${head}<tbody>${body}</tbody></table>`;
}

function contents(ctx: Ctx): string {
  const list = headings(ctx.page.content, ctx.input);
  if (!list.length) return `<p class="pv-placeholder">${esc(ctx.input.words.noHeadings)}</p>`;
  return (
    `<nav class="pv-toc" aria-label="${esc(ctx.input.words.contents)}"><ol>` +
    list
      .map((h) => {
        const dir = textDirection(h.text) ?? ctx.dir;
        const text = esc(h.text);
        return `<li class="pv-l${h.level}"${dirAttr(dir)}>${h.id ? `<a href="#pv-${esc(h.id)}">${text}</a>` : text}</li>`;
      })
      .join('') +
    '</ol></nav>'
  );
}

const placeholder = (text: string) => `<p class="pv-placeholder">${esc(text)}</p>`;

function outBlock(ctx: Ctx, shown: OutBlock): string {
  switch (shown.kind) {
    case 'table':
      return (
        (shown.title
          ? `<p class="pv-table-title"${dirAttr(textDirection(shown.title) ?? ctx.dir)}>${esc(shown.title)}</p>`
          : '') +
        textTable(shown.columns, shown.rows, shown.groups) +
        (shown.more > 0 && shown.moreText ? placeholder(shown.moreText) : '')
      );
    case 'chart': {
      const src = shown.svg
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shown.svg)}`
        : shown.image
          ? ctx.input.assets[shown.image]?.url
          : undefined;
      return src
        ? `<figure class="pv-figure"><img src="${esc(src)}" alt="${esc(shown.title)}"><figcaption${dirAttr(textDirection(shown.title) ?? ctx.dir)}>${esc(shown.title)}</figcaption></figure>`
        : placeholder(shown.title);
    }
    case 'picture': {
      const url = ctx.input.assets[shown.image]?.url;
      return url
        ? `<figure class="pv-figure"><img src="${esc(url)}" alt="${esc(shown.title)}"><figcaption${dirAttr(textDirection(shown.title) ?? ctx.dir)}>${esc(shown.title)}</figcaption></figure>`
        : placeholder(shown.title || ctx.input.words.missingImage);
    }
    case 'text':
      return `<p${dirAttr(textDirection(shown.text) ?? ctx.dir)}>${esc(shown.text)}</p>`;
    case 'placeholder':
      return placeholder(shown.text);
  }
}

function body(ctx: Ctx, item: FlatItem): string {
  const { input } = ctx;
  const node = item.body;
  const attrs = node.attrs ?? {};
  const dir = bodyDirection(node, input, ctx.dir);
  switch (node.type) {
    case 'textBody': {
      const kind = String(attrs.kind ?? 'paragraph');
      const colour = TEXT_COLOURS[String(attrs.colour)] ? ` pv-c-${String(attrs.colour)}` : '';
      const content = inline(ctx, node.content) || '<br>';
      if (item.list)
        return unit(
          item,
          `pv-li pv-li-${item.list.kind}${colour}`,
          dir,
          `${marker(item, attrs.checked === true)}<div class="pv-li-text${attrs.checked === true && item.list.kind === 'check' ? ' pv-done' : ''}">${content}</div>`,
        );
      switch (kind) {
        case 'heading': {
          const level = Math.min(3, Math.max(1, Number(attrs.level) || 1));
          return unit(item, `pv-h pv-h${level}${colour}`, dir, content, `h${level + 1}`);
        }
        case 'quote':
          return unit(item, `pv-quote${colour}`, dir, content, 'blockquote');
        case 'callout': {
          const tone = CALLOUT_TONES[String(attrs.tone)] ? String(attrs.tone) : 'neutral';
          const icon =
            typeof attrs.icon === 'string' && attrs.icon
              ? `<span class="pv-callout-icon">${esc(attrs.icon)}</span>`
              : '';
          return unit(
            item,
            `pv-callout pv-tone-${tone}${colour}`,
            dir,
            `${icon}<div>${content}</div>`,
          );
        }
        case 'toggle':
          return unit(
            item,
            `pv-toggle${colour}`,
            dir,
            `<span class="pv-mark">▾</span><div>${content}</div>`,
          );
        default:
          return unit(item, `pv-p${colour}`, dir, content, 'p');
      }
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((n) => n.text ?? '').join('');
      const lines = text
        .split('\n')
        .map((line) => `<div class="pv-line">${esc(line) || '<br>'}</div>`)
        .join('');
      return unit(item, `pv-code${attrs.wrap ? ' pv-wrap' : ''}`, 'ltr', lines);
    }
    case 'divider':
      return unit(item, 'pv-hr', ctx.dir, '');
    case 'table':
      return unit(item, 'pv-table-wrap', ctx.dir, pageTable(ctx, node));
    case 'image': {
      const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
      if (!assetId) return '';
      const asset = input.assets[assetId];
      const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
      const caption = typeof attrs.caption === 'string' && attrs.caption ? attrs.caption : null;
      if (!asset?.url)
        return unit(
          item,
          'pv-placeholder',
          ctx.dir,
          esc(alt ? `${input.words.missingImage}: ${alt}` : input.words.missingImage),
          'p',
        );
      const width =
        Number(attrs.width) > 0 ? ` style="width:${Math.round(Number(attrs.width))}px"` : '';
      const align =
        attrs.align === 'center' || attrs.align === 'end' ? ` pv-align-${String(attrs.align)}` : '';
      const size =
        asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : '';
      return unit(
        item,
        `pv-figure${align}`,
        ctx.dir,
        `<img src="${esc(asset.url)}" alt="${esc(alt)}"${size}${width}>${caption ? `<figcaption${dirAttr(textDirection(caption) ?? ctx.dir)}>${esc(caption)}</figcaption>` : ''}`,
        'figure',
      );
    }
    case 'file': {
      const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
      if (!assetId) return '';
      const name = input.assets[assetId]?.fileName || input.words.missingFile;
      return unit(item, 'pv-p pv-file', textDirection(name) ?? ctx.dir, `📎 ${esc(name)}`, 'p');
    }
    case 'bookmark': {
      const href = linkHref(attrs.url, input);
      return href
        ? unit(item, 'pv-p pv-bookmark', 'ltr', `<a href="${esc(href)}">${esc(href)}</a>`, 'p')
        : '';
    }
    case 'childPage': {
      const target = input.links[String(attrs.pageId ?? '')];
      const text = target
        ? `${target.icon ? `${target.icon} ` : ''}${target.title || input.words.untitled}`
        : input.words.aPage;
      const inner = target?.href ? `<a href="${esc(target.href)}">${esc(text)}</a>` : esc(text);
      return unit(item, 'pv-p pv-child', textDirection(text) ?? ctx.dir, inner, 'p');
    }
    case 'tableOfContents':
      return unit(item, 'pv-contents', ctx.dir, contents(ctx));
    default: {
      const shown = item.first ? resolved(ctx.page, item.block) : undefined;
      if (shown) return unit(item, `pv-out pv-out-${shown.kind}`, ctx.dir, outBlock(ctx, shown));
      const text = inline(ctx, node.content);
      return text
        ? unit(item, 'pv-p', dir, text, 'p')
        : unit(item, 'pv-placeholder', ctx.dir, esc(input.words.unknownBlock), 'p');
    }
  }
}

/** A band's places as HTML for the paged mode, and as CSS content for the margin boxes. */
function bandOf(
  band: LayoutBand,
  input: OutInput,
  title: string,
): { html: Record<BandPlace, string>; css: Record<BandPlace, string> } {
  const html = {} as Record<BandPlace, string>;
  const css = {} as Record<BandPlace, string>;
  for (const place of BAND_PLACES) {
    const parts = bandParts(band[place]);
    html[place] = parts
      .map((part) =>
        'text' in part
          ? esc(part.text)
          : part.field === 'title'
            ? esc(title)
            : part.field === 'date'
              ? esc(input.date)
              : `<span data-field="${part.field}"></span>`,
      )
      .join('');
    css[place] = parts
      .map((part) =>
        'text' in part
          ? cssString(part.text)
          : part.field === 'title'
            ? cssString(title)
            : part.field === 'date'
              ? cssString(input.date)
              : `counter(${part.field})`,
      )
      .join(' ');
  }
  return { html, css };
}

const mm = (n: number) => `${Math.round(n * 100) / 100}mm`;

/** The print view of the page and its sub-pages. */
export function printView(input: OutInput, mode: PrintMode): PrintView {
  const box = pageBox(input.layout);
  const contentHeight = box.height - 2 * box.block;
  const sections: string[] = [];
  const bands: PrintView['bands'] = [];
  let pageRules = '';
  input.pages.forEach((page, i) => {
    const dir = pageDirection(page, input);
    const ctx: Ctx = { input, page, dir };
    const title = `${page.icon ? `${page.icon} ` : ''}${page.title || input.words.untitled}`;
    const titleText = page.title || input.words.untitled;
    let out = `<h1 class="pv-u pv-title"${dirAttr(textDirection(titleText) ?? dir)}>${esc(title)}</h1>`;
    if (page.properties?.length)
      out += `<div class="pv-u pv-table-wrap">${textTable(
        null,
        page.properties.map((p) => [p.name, p.text]),
      )}</div>`;
    for (const item of flatten(page.content)) out += body(ctx, item);
    sections.push(
      `<section class="pv-doc" data-doc="${i}"${dirAttr(dir)} style="page:pv-doc-${i}">${out}</section>`,
    );
    const header = bandOf(input.layout.header, input, titleText);
    const footer = bandOf(input.layout.footer, input, titleText);
    bands.push({
      header: { places: header.html },
      footer: { places: footer.html },
      dir,
      shown: {
        header: BAND_PLACES.some((p) => input.layout.header[p].trim()),
        footer: BAND_PLACES.some((p) => input.layout.footer[p].trim()),
      },
    });
    if (mode === 'css') {
      // Right to left, a band's start is the page's right.
      const side = (place: BandPlace) =>
        place === 'center' ? 'center' : (place === 'start') === (dir === 'ltr') ? 'left' : 'right';
      const boxes = (edge: 'top' | 'bottom', band: typeof header) =>
        BAND_PLACES.filter((place) => band.css[place])
          .map((place) => `@${edge}-${side(place)}{content:${band.css[place]};}`)
          .join('');
      pageRules += `@page pv-doc-${i}{${boxes('top', header)}${boxes('bottom', footer)}}\n`;
    }
  });
  const size = `${mm(box.width)} ${mm(box.height)}`;
  const marginBox = `font:8.5pt/1.3 ${PRINT_FONTS};color:#595959;`;
  const pageCss =
    mode === 'css'
      ? `@page{size:${size};margin:${mm(box.block)} ${mm(box.inline)};` +
        ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']
          .map((b) => `@${b}{${marginBox}}`)
          .join('') +
        `}\n${pageRules}`
      : `@page{size:${size};margin:0;}\n`;
  const css = `
.pv{font:10.5pt/1.5 ${PRINT_FONTS};color:#1f1f1f;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.pv *{box-sizing:border-box;}
.pv-doc+.pv-doc{break-before:page;page-break-before:always;}
.pv-u{margin:0 0 5pt;}
.pv-title{font-size:22pt;line-height:1.2;font-weight:700;margin:0 0 10pt;}
.pv-h{line-height:1.25;font-weight:600;break-after:avoid;page-break-after:avoid;}
.pv-h1{font-size:17pt;margin:14pt 0 5pt;}.pv-h2{font-size:14pt;margin:12pt 0 4pt;}.pv-h3{font-size:12pt;margin:10pt 0 3pt;}
.pv-li,.pv-toggle{display:flex;gap:5pt;align-items:baseline;}
.pv-mark,.pv-box{flex:none;min-width:12pt;text-align:end;}
.pv-li-text{flex:1;min-width:0;}.pv-done{color:#787774;}
.pv-quote{border-inline-start:3pt solid #c9c9c6;padding-inline-start:9pt;color:#37352f;}
.pv-callout{display:flex;gap:6pt;padding:6pt 9pt;border-radius:3pt;border-inline-start:3pt solid;break-inside:avoid;page-break-inside:avoid;}
${Object.entries(CALLOUT_TONES)
  .map(([tone, c]) => `.pv-tone-${tone}{background:#${c.fill};border-color:#${c.edge};}`)
  .join('')}
.pv-code{font:9pt/1.45 ${CODE_FONTS};background:#f6f6f5;border-radius:3pt;padding:6pt 8pt;white-space:pre;overflow:hidden;}
.pv-code.pv-wrap,.pv-code .pv-line{white-space:pre-wrap;overflow-wrap:anywhere;}
.pv code{font-family:${CODE_FONTS};font-size:0.9em;background:#f2f1ee;border-radius:2pt;padding:0 2pt;}
.pv-hr{border-top:0.75pt solid #d3d3d1;margin:8pt 0;}
.pv-table{border-collapse:collapse;width:100%;table-layout:fixed;}
.pv-table th,.pv-table td{border:0.5pt solid #bfbfbf;padding:3pt 5pt;vertical-align:top;text-align:start;overflow-wrap:anywhere;}
.pv-table th{background:#f2f2f2;font-weight:600;}
.pv-table thead{display:table-header-group;}
.pv-table tr,.pv-table td>div,.pv-table th>div{break-inside:avoid;page-break-inside:avoid;}
.pv-props th,.pv-props td:first-child{width:35%;font-weight:600;background:#f7f7f7;}
.pv-group th{text-align:start;background:#ebebea;}
.pv-table-title{font-weight:600;margin:6pt 0 3pt;break-after:avoid;page-break-after:avoid;}
.pv-figure{margin:6pt 0;break-inside:avoid;page-break-inside:avoid;}
.pv-figure img{display:block;max-width:100%;height:auto;max-height:${mm(contentHeight - 14)};object-fit:contain;}
.pv-align-center img{margin-inline:auto;}.pv-align-end img{margin-inline-start:auto;}
.pv-figure figcaption{font-size:9pt;color:#595959;margin-top:3pt;}
.pv-align-center figcaption{text-align:center;}.pv-align-end figcaption{text-align:end;}
.pv-placeholder{border:0.75pt dashed #a6a6a6;color:#595959;padding:4pt 8pt;border-radius:3pt;}
.pv-toc ol{list-style:none;margin:0;padding:0;}.pv-toc li{margin:0 0 2pt;}
.pv-toc .pv-l2{padding-inline-start:14pt;}.pv-toc .pv-l3{padding-inline-start:28pt;}
.pv a{color:#0b57d0;text-decoration:underline;}
.pv-mention{font-weight:500;}
${Object.entries(TEXT_COLOURS)
  .map(([token, hex]) => `.pv-c-${token}{color:#${hex};}`)
  .join('')}
${Object.entries(HIGHLIGHT_COLOURS)
  .map(([token, hex]) => `.pv-h-${token}{background:#${hex};color:inherit;}`)
  .join('')}
.pv-page{position:relative;width:${mm(box.width)};height:${mm(box.height - 0.6)};overflow:hidden;background:#fff;break-after:page;page-break-after:always;}
.pv-page:last-child{break-after:auto;page-break-after:auto;}
.pv-band{position:absolute;inset-inline:${mm(box.inline)};display:flex;gap:4mm;font:8.5pt/1.3 ${PRINT_FONTS};color:#595959;}
.pv-band>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pv-band>.pv-centre{text-align:center;}.pv-band>.pv-end{text-align:end;}
.pv-head{top:${mm(Math.max(4, box.block / 2 - 2.5))};}.pv-foot{bottom:${mm(Math.max(4, box.block / 2 - 2.5))};}
.pv-body{position:absolute;top:${mm(box.block)};inset-inline:${mm(box.inline)};height:${mm(contentHeight)};overflow:hidden;}
.pv-body>:first-child{margin-top:0;}
.pv-measure{position:absolute;top:0;inset-inline-start:-100000px;width:${mm(box.width - 2 * box.inline)};visibility:hidden;}
`;
  const title = input.pages[0]
    ? input.pages[0].title || input.words.untitled
    : input.words.untitled;
  return {
    css,
    pageCss,
    html: `<div class="pv" lang="${input.language}">${sections.join('')}</div>`,
    title,
    box,
    bands,
  };
}
