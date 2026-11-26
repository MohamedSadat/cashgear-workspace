// Phase 19's print spike: the pages it prints. One print document (a page's print view as the
// renderer would draw it: `@page` size and margins, a header and a footer in the margin boxes with
// page numbers, English and Arabic, tall images, a table of three-line rows), and two ways an app
// would print it: from a frame of its own, or from its own document with print media hiding the
// app. Spike code: it never ships.
import { deflateSync } from 'node:zlib';

/** A PNG of one colour, `width` by `height` (8-bit RGB), with no library. */
export function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ARABIC = 'يطبع هذا السطر باللغة العربية من اليمين إلى اليسار';
export const ARABIC_HEADER = 'تقرير الطباعة';
export const IMAGES = 6;
export const ROWS = 60;

const COLOURS = [
  [200, 60, 60],
  [60, 160, 80],
  [60, 90, 200],
  [200, 160, 40],
  [140, 60, 180],
  [40, 160, 170],
];

/**
 * The fonts: the generic `sans-serif` (Arial here) writes Arabic's initial yeh as the Farsi letter
 * in a PDF's text; Segoe UI and Tahoma write the Arabic one.
 */
export const FONT = 'system-ui, "Segoe UI", Tahoma, sans-serif';

/** Size names as `@page` takes them. */
export const SIZES = {
  'a4-portrait': { css: 'A4 portrait', points: [595.28, 841.89] },
  'letter-landscape': { css: 'letter landscape', points: [792, 612] },
};

/**
 * The print document's CSS: the layout's `@page`, its margin boxes, and the breaks. `fixed` draws
 * the header and footer as fixed boxes in the flow instead (the fallback if an engine draws no
 * margin boxes).
 */
export function printCss(size, { fixed = false } = {}) {
  // The page's content box's height: an image is never taller (it would be cut over two pages).
  const [, h] = SIZES[size].points;
  const contentMm = (h / 72) * 25.4 - 40;
  const boxes = fixed
    ? ''
    : `
  @top-left { content: "Spike header start"; font: 9pt ${FONT}; }
  @top-center { content: "${ARABIC_HEADER}"; font: 9pt ${FONT}; }
  @top-right { content: "2026-11-26"; font: 9pt ${FONT}; }
  @bottom-center { content: "Page " counter(page) " of " counter(pages); font: 9pt ${FONT}; }`;
  return `
@page { size: ${SIZES[size].css}; margin: 20mm 18mm;${boxes}
}
.pv { font: 11pt/1.45 ${FONT}; color: #111; }
.pv h1 { font-size: 20pt; margin: 0 0 8pt; }
.pv h2 { font-size: 15pt; margin: 14pt 0 6pt; break-after: avoid; }
.pv p { margin: 0 0 6pt; }
.pv figure { margin: 8pt 0; break-inside: avoid; }
.pv figure img { display: block; width: auto; height: auto; max-width: 120mm; max-height: ${contentMm.toFixed(1)}mm; }
.pv table { border-collapse: collapse; width: 100%; }
.pv thead { display: table-header-group; }
.pv tr { break-inside: avoid; }
.pv td, .pv th { border: 0.5pt solid #888; padding: 3pt 5pt; vertical-align: top; text-align: start; }
${
  fixed
    ? `.pv-fixed-head, .pv-fixed-foot { position: fixed; inset-inline: 0; font: 9pt ${FONT}; }
.pv-fixed-head { top: 0; } .pv-fixed-foot { bottom: 0; }`
    : ''
}`;
}

/** The print view's body: what the renderer would draw for a page. */
export function printBody({ fixed = false } = {}) {
  const parts = [];
  if (fixed)
    parts.push(
      `<div class="pv-fixed-head">Spike header start · ${ARABIC_HEADER} · 2026-11-26</div>`,
      `<div class="pv-fixed-foot">Spike footer</div>`,
    );
  parts.push('<h1>Print spike</h1>');
  parts.push('<p>An English paragraph before everything else. '.repeat(6) + '</p>');
  parts.push(`<h2 dir="rtl">عنوان عربي</h2><p dir="rtl">${ARABIC}.</p>`);
  for (let i = 1; i <= IMAGES; i++) {
    parts.push(`<p>Before image ${i}.</p>`);
    parts.push(
      `<figure><img src="image${i}.png" alt="Image ${i}" width="600" height="900"></figure>`,
    );
  }
  parts.push('<h2>A table of three-line rows</h2>');
  parts.push('<table><thead><tr><th>Name</th><th>Lines</th></tr></thead><tbody>');
  for (let r = 1; r <= ROWS; r++)
    parts.push(
      `<tr><td>Row ${r}</td><td>Row ${r} line one<br>Row ${r} line two<br>Row ${r} line three</td></tr>`,
    );
  parts.push('</tbody></table>');
  parts.push(`<p dir="rtl">${ARABIC} في النهاية.</p>`);
  return parts.join('\n');
}

/** The print document alone: what a frame of its own would load. */
export function documentPage(size, options = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Print spike</title>
<style>html, body { margin: 0; } ${printCss(size, options)}</style></head>
<body><main class="pv">${printBody(options)}</main></body></html>`;
}

/** The app's own frame, as the shell draws it: a full-height box that scrolls inside. */
const APP = `<div id="root" style="height:100%;display:flex;flex-direction:column;overflow:hidden">
<header style="height:48px;background:#ddd">Cash Gear Workspace (the app's frame)</header>
<div style="flex:1;overflow:auto">${'<p>The app, which must not be printed.</p>'.repeat(200)}</div>
</div>`;

/** The app with the print view in a frame of its own (`srcdoc`), printed from the frame. */
export function framePage(size, options = {}) {
  const doc = documentPage(size, options).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>App with a print frame</title>
<base href="./">
<style>html, body { height: 100%; margin: 0; overflow: hidden; }
iframe { position: fixed; inset-inline-start: -10000px; width: 210mm; height: 297mm; border: 0; }</style>
</head><body>${APP}<iframe id="pv" srcdoc="${doc}"></iframe>
<script>window.printView = () => document.getElementById('pv').contentWindow.print();</script>
</body></html>`;
}

/** The app with the print view in its own document: shown in print media only. */
export function mainPage(size, options = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>App printing itself</title>
<style>html, body { height: 100%; margin: 0; overflow: hidden; }
.pv-root { display: none; }
@media print {
  html, body { height: auto !important; overflow: visible !important; }
  body > :not(.pv-root) { display: none !important; }
  .pv-root { display: block; }
  ${printCss(size, options)}
}</style></head>
<body>${APP}<div class="pv-root"><main class="pv">${printBody(options)}</main></div>
<script>window.printView = () => window.print();</script>
</body></html>`;
}

/** Every spike page and image, by file name. */
export function spikeFiles() {
  const files = {};
  for (const size of Object.keys(SIZES)) {
    files[`doc-${size}.html`] = documentPage(size);
    files[`frame-${size}.html`] = framePage(size);
    files[`main-${size}.html`] = mainPage(size);
    files[`main-fixed-${size}.html`] = mainPage(size, { fixed: true });
  }
  for (let i = 1; i <= IMAGES; i++) files[`image${i}.png`] = png(600, 900, COLOURS[i - 1]);
  return files;
}
