// Phase 19: what a printed PDF and an exported Word file hold, for the specs. A PDF is read back
// with pdf.js (each page's size, its text as lines read in their own direction with Arabic's shaped
// forms folded back by NFKC, and where each image is drawn), grown from the spike's checker
// (bench/print-spike/check.mjs). A Word file is unzipped and read by Phase 8's reader.
//
// Printing for real: Chrome and Edge, started headed with `--kiosk-printing` and "Save as PDF" as
// the remembered printer, save what `window.print()` prints with no dialog. Edge moves the file
// away a moment after writing it, so the folder is read on every change.
import { chromium, type BrowserContext } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDocx, type DocxResult } from '../../packages/doc/src/docx';

const require = createRequire(join(process.cwd(), 'packages', 'shell', 'package.json'));
const rootRequire = createRequire(join(process.cwd(), 'package.json'));

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfJs | null = null;
async function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (await import(
    pathToFileURL(rootRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
  )) as PdfJs;
  return pdfjs;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  dir: string;
}

export interface PdfPage {
  width: number;
  height: number;
  lines: string[];
  text: string;
  /** Each image drawn: its bottom and top on the page, in points. */
  images: { bottom: number; top: number }[];
}

/** A line's text in reading order (see bench/print-spike/check.mjs, `lineText`). */
function lineText(items: TextItem[]): string {
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  const size = (item: TextItem) => Math.hypot(item.transform[0], item.transform[1]) || 10;
  const segments: TextItem[][] = [];
  let current: TextItem[] = [];
  for (const item of sorted) {
    const last = current[current.length - 1];
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
      ordered.forEach((item, i) => {
        if (i > 0) {
          const prev = ordered[i - 1];
          const gap = rtl
            ? prev.transform[4] - (item.transform[4] + item.width)
            : item.transform[4] - (prev.transform[4] + prev.width);
          if (gap > size(item) / 5 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
        }
        text += item.str;
      });
      return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join(' | ');
}

const multiply = (m: number[], n: number[]) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Each page of a PDF: its size, its lines top to bottom, the images drawn on it. */
export async function readPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    const content = await page.getTextContent();
    const byLine = new Map<number, TextItem[]>();
    for (const item of content.items as TextItem[]) {
      if (!('str' in item) || !item.str) continue;
      const y = Math.round(item.transform[5]);
      const key = [...byLine.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key)!.push(item);
    }
    const lines = [...byLine.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => lineText(items));
    const ops = await page.getOperatorList();
    const images: PdfPage['images'] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    ops.fnArray.forEach((fn, i) => {
      const args = ops.argsArray[i] as number[];
      if (fn === lib.OPS.save) stack.push(ctm);
      else if (fn === lib.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === lib.OPS.transform) ctm = multiply(ctm, args);
      else if (fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintInlineImageXObject) {
        const bottom = ctm[5] + Math.min(0, ctm[3]);
        images.push({ bottom, top: bottom + Math.abs(ctm[3]) });
      }
    });
    pages.push({ width: x1 - x0, height: y1 - y0, lines, text: lines.join('\n'), images });
  }
  return pages;
}

/** Points for millimetres, as a PDF measures a page. */
export const points = (mm: number) => (mm / 25.4) * 72;

/** A Word file read by Phase 8's reader, and its parts by path. */
export function readWord(bytes: Uint8Array): DocxResult & { parts: Record<string, string> } {
  const { unzipSync, strFromU8 } = require('fflate') as typeof import('fflate');
  const files = unzipSync(bytes);
  const parts: Record<string, string> = {};
  for (const [path, data] of Object.entries(files))
    if (path.endsWith('.xml') || path.endsWith('.rels')) parts[path] = strFromU8(data);
  const read = readDocx(
    {
      document: parts['word/document.xml'],
      styles: parts['word/styles.xml'],
      numbering: parts['word/numbering.xml'],
      relationships: parts['word/_rels/document.xml.rels'],
    },
    { image: (path) => (files[path] ? `image:${path}` : null) },
  );
  return { ...read, parts };
}

/**
 * A headed browser that prints with no dialog: `print()` saves a PDF into `saved`, which
 * `printed()` reads back. The channel is the project's (Chrome or Edge).
 */
export async function kioskBrowser(
  channel: string,
  folder: string,
): Promise<{
  context: BrowserContext;
  printed: (run: () => Promise<unknown>) => Promise<Uint8Array>;
}> {
  rmSync(folder, { recursive: true, force: true });
  const profile = join(folder, 'profile');
  const saved = join(folder, 'saved');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(saved, { recursive: true });
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      printing: {
        print_preview_sticky_settings: {
          appState: JSON.stringify({
            recentDestinations: [{ id: 'Save as PDF', origin: 'local', account: '' }],
            selectedDestinationId: 'Save as PDF',
            version: 2,
            isHeaderFooterEnabled: false,
            isCssBackgroundEnabled: true,
          }),
        },
      },
      savefile: { default_directory: saved },
      download: { default_directory: saved, prompt_for_download: false },
    }),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel,
    headless: false,
    args: ['--kiosk-printing'],
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const printed = async (run: () => Promise<unknown>) => {
    let bytes: Uint8Array | null = null;
    let changed = 0;
    const watcher = watch(saved, (_, file) => {
      changed = Date.now();
      if (!file?.endsWith('.pdf')) return;
      try {
        const now = readFileSync(join(saved, file));
        if (now.length > (bytes?.length ?? 0)) bytes = now;
      } catch {
        // Moved away already: the read before holds it.
      }
    });
    try {
      await run();
      const started = Date.now();
      while (Date.now() - started < 30_000 && !(bytes && Date.now() - changed > 1000))
        await new Promise((r) => setTimeout(r, 100));
    } finally {
      watcher.close();
    }
    if (!bytes) throw new Error('Nothing was printed');
    return bytes;
  };
  return { context, printed };
}
