// Reads a printed PDF back with pdf.js (text, page sizes, images drawn) and judges it against what
// the spike page holds: the page's size, a header and a footer with page numbers on every page,
// Arabic as text in its order, no image and no table row split over two pages. Spike code, which
// the specs' PDF checks (tests/e2e/pdf.ts) grew from.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ARABIC, ARABIC_HEADER, IMAGES, ROWS, SIZES } from './pages.mjs';

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Each page's size, its text as lines (top to bottom), and the images drawn on it. */
export async function readPdf(bytes) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    const width = x1 - x0;
    const height = y1 - y0;
    const content = await page.getTextContent();
    // Items grouped into lines by their baseline, top first.
    const byLine = new Map();
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const y = Math.round(item.transform[5]);
      const key = [...byLine.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(item);
    }
    const lines = [...byLine.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => ({ y, text: lineText(items), rtl: items.some((i) => i.dir === 'rtl') }));
    // Images: where each is drawn, by the transform at its paint.
    const ops = await page.getOperatorList();
    const images = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args);
      else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
        const bottom = ctm[5] + Math.min(0, ctm[3]);
        const top = bottom + Math.abs(ctm[3]);
        images.push({ bottom, top, height: Math.abs(ctm[3]), width: Math.abs(ctm[0]) });
      }
    }
    pages.push({ width, height, lines, images });
  }
  return { pages };
}

/**
 * A line's text as a reader would read it. A print engine writes Arabic as shaped glyphs (its
 * presentation forms), often one item each, placed right to left: the line is cut into segments at
 * wide gaps (a header's start, centre and end boxes), each segment's items are read in its own
 * direction (right to left when most of its letters are Arabic), a space goes where a gap is wider
 * than a fifth of the font's size, and NFKC folds the shaped forms back into their letters. The
 * segments are joined with " | ", left to right on the page.
 */
export function lineText(items) {
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  const size = (item) => Math.hypot(item.transform[0], item.transform[1]) || 10;
  const segments = [];
  let current = [];
  for (const item of sorted) {
    const last = current[current.length - 1];
    // pdf.js fills a wide gap with one space item as wide as the gap: that is a break too.
    if (!item.str.trim() && item.width > size(item) * 3) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    if (last && item.transform[4] - (last.transform[4] + last.width) > size(item) * 3) {
      segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) segments.push(current);
  return segments
    .map((segment) => {
      const letters = segment.map((i) => i.str).join('');
      const arabic = (letters.match(/\p{Script=Arabic}/gu) ?? []).length;
      const latin = (letters.match(/[A-Za-z0-9]/g) ?? []).length;
      const rtl = arabic > latin;
      const ordered = rtl ? [...segment].reverse() : segment;
      let text = '';
      for (let i = 0; i < ordered.length; i++) {
        const item = ordered[i];
        if (i > 0) {
          const prev = ordered[i - 1];
          const gap = rtl
            ? prev.transform[4] - (item.transform[4] + item.width)
            : item.transform[4] - (prev.transform[4] + prev.width);
          if (gap > size(item) / 5 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
        }
        text += item.str;
      }
      return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join(' | ');
}

const near = (a, b) => Math.abs(a - b) <= 2;

/** Pass or fail for each thing the spike asks of a print. */
export function judge(read, size) {
  const [w, h] = SIZES[size].points;
  const { pages } = read;
  const count = pages.length;
  const text = (page) => page.lines.map((l) => l.text).join('\n');
  const all = pages.map(text).join('\n');
  const result = {
    pages: count,
    size: pages.every((p) => near(p.width, w) && near(p.height, h)),
    headerEveryPage: pages.every(
      (p) => text(p).includes('Spike header start') && text(p).includes('2026-11-26'),
    ),
    arabicHeaderEveryPage: pages.every((p) => text(p).includes(ARABIC_HEADER)),
    pageNumbers: pages.every((p, i) => text(p).includes(`Page ${i + 1} of ${count}`)),
    arabicInOrder: all.includes(ARABIC),
    imagesDrawn: pages.reduce((n, p) => n + p.images.length, 0),
    imagesWhole: pages.every((p) => p.images.every((i) => i.bottom >= -1 && i.top <= p.height + 1)),
    rowsSplit: [],
    appPrinted: all.includes('The app, which must not be printed'),
    lastLine: all.includes('في النهاية'),
  };
  for (let r = 1; r <= ROWS; r++) {
    const first = pages.findIndex((p) => text(p).includes(`Row ${r} line one`));
    const last = pages.findIndex((p) => text(p).includes(`Row ${r} line three`));
    if (first !== last || first < 0) result.rowsSplit.push(r);
  }
  result.imagesNotSplit = result.imagesDrawn === IMAGES && result.imagesWhole;
  result.pass =
    result.size &&
    result.headerEveryPage &&
    result.arabicHeaderEveryPage &&
    result.pageNumbers &&
    result.arabicInOrder &&
    result.imagesNotSplit &&
    result.rowsSplit.length === 0 &&
    !result.appPrinted &&
    result.lastLine;
  return result;
}
