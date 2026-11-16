// The clipboard's two shapes of a rectangle of cells: tab-separated text (what Excel, Sheet and
// every spreadsheet read and write) and an HTML table (what a spreadsheet takes when it is there,
// and what some pages give with no text). Pure, apart from reading HTML through `DOMParser`.
//
// Written: a field holding a tab, a line break or a quote is put in quotes, its quotes doubled
// (Sheet's rule, and Excel's for line breaks); rows end with CRLF, the last one too, as Excel's do.
// Read: Excel's and Sheet's text, leniently. One line end at the end is not a row. A field that
// starts with a quote is quoted only when its closing quote ends the field (a tab, a line end or
// the end follows): `"a""b"` is `a"b`, while `"Big" deal` is read as written. CRLF, LF and a lone
// CR end a row. Rows keep their own lengths (a short row leaves the cells after it as they were).

/** A cell as read from the clipboard: its text and, from an HTML table, an exact number. */
export interface ClipCell {
  text: string;
  /** Sheet's `x:num` (and Excel's): the number a cell shows as `text`, exactly. */
  number?: number;
}

const needsQuotes = (text: string) => /[\t\r\n"]/.test(text);
const field = (text: string) => (needsQuotes(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** Rows of cells as tab-separated text. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((cells) => `${cells.map(field).join('\t')}\r\n`).join('');
}

/** Tab-separated text as rows of cells (no rows for empty text; a lone line end is one empty cell). */
export function parseTsv(input: string): string[][] {
  if (input === '') return [];
  const text = input.replace(/(\r\n|\n|\r)$/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const ends = (at: number) =>
    at >= text.length || text[at] === '\t' || text[at] === '\n' || text[at] === '\r';
  for (;;) {
    let cell: string | null = null;
    if (text[i] === '"') {
      // A quoted field, if its closing quote ends the field.
      let j = i + 1;
      let quoted = '';
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] !== '"') break;
          quoted += '"';
          j += 2;
          continue;
        }
        quoted += text[j++];
      }
      if (j < text.length && ends(j + 1)) {
        cell = quoted;
        i = j + 1;
      }
    }
    if (cell === null) {
      // Unquoted (or a quote that does not close the field): up to the tab or the line end.
      let j = i;
      while (!ends(j)) j++;
      cell = text.slice(i, j);
      i = j;
    }
    row.push(cell);
    if (i >= text.length) {
      rows.push(row);
      return rows;
    }
    const c = text[i];
    if (c === '\t') {
      i++;
      continue;
    }
    // A line end.
    rows.push(row);
    row = [];
    i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/**
 * Rows of cells as an HTML table: each cell's text as shown, a line break in it as a break that
 * Excel keeps in the same cell; the table drawn in the interface's direction.
 */
export function toHtmlTable(rows: readonly (readonly string[])[], dir: 'ltr' | 'rtl'): string {
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map(
            (text) =>
              `<td>${escapeHtml(text)
                .split(/\r\n|\n|\r/)
                .join('<br style="mso-data-placement:same-cell">')}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<meta charset="utf-8"><table dir="${dir}"><tbody>${body}</tbody></table>`;
}

const BLOCKS = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE']);

/** A cell's text as a browser would show it: runs of spaces as one, breaks and blocks as lines. */
function textOf(node: Node): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += (n.nodeValue ?? '').replace(/[ \t\r\n\f]+/g, ' ');
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    if (tag === 'STYLE' || tag === 'SCRIPT') return;
    const block = BLOCKS.has(tag);
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const child of el.childNodes) walk(child);
    if (block && out && !out.endsWith('\n')) out += '\n';
  };
  walk(node);
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * The first table of some HTML as rows of cells (null when it has none, or `DOMParser` is not
 * there): a cell spanning columns stands for as many, the ones after it empty.
 */
export function parseHtmlTable(html: string): ClipCell[][] | null {
  if (typeof DOMParser === 'undefined' || !/<table[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows: ClipCell[][] = [];
  for (const tr of (table as HTMLTableElement).rows) {
    const cells: ClipCell[] = [];
    for (const cell of tr.cells) {
      const text = textOf(cell);
      const num = cell.getAttribute('x:num');
      const number = num !== null && num.trim() !== '' ? Number(num) : NaN;
      cells.push(Number.isFinite(number) ? { text, number } : { text });
      const span = Math.min(1000, Math.max(1, Number(cell.getAttribute('colspan')) || 1));
      for (let s = 1; s < span; s++) cells.push({ text: '' });
    }
    rows.push(cells);
  }
  return rows.length ? rows : null;
}
