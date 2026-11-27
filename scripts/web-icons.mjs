// The web app's install icons (after 0.19.0), drawn from its favicon (`apps/web/public/favicon.svg`,
// the desktop's icons are the same design) in Chrome through Playwright: 192 and 512 px, a maskable
// 512 px (a full square field, the page inside the safe zone), and the apple-touch-icon (180 px,
// square, opaque). Run again after the favicon changes: `node scripts/web-icons.mjs`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'apps/web/public');
const out = join(pub, 'icons');
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
const field = /<rect width="1024" height="1024" rx="\d+" fill="(#[0-9a-f]{6})"\/>/i.exec(svg)?.[1];
if (!field) throw new Error('favicon.svg no longer starts with its coloured field');

/** The favicon as drawn, its rounded tile on a transparent ground. */
const plain = svg;
/** A full square of the field's colour, the drawing scaled to 80 % about its centre. */
const square = (scale) =>
  svg
    .replace(/<rect width="1024" height="1024" rx="\d+" fill="#[0-9a-f]{6}"\/>/i, '')
    .replace(
      /<svg([^>]*)>/,
      `<svg$1><rect width="1024" height="1024" fill="${field}"/><g transform="translate(${(512 * (1 - scale)).toFixed(1)} ${(512 * (1 - scale)).toFixed(1)}) scale(${scale})">`,
    )
    .replace('</svg>', '</g></svg>');

const icons = [
  ['icon-192.png', 192, plain],
  ['icon-512.png', 512, plain],
  ['icon-maskable-512.png', 512, square(0.8)],
  ['apple-touch-icon.png', 180, square(1)],
];

mkdirSync(out, { recursive: true });
// Installed Chrome, as the specs use (no browser download needed).
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [name, size, source] of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    writeFileSync(join(out, name), png);
    await page.close();
    console.log(`${name}: ${size} px, ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
