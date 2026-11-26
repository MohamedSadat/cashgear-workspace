// Phase 19: a page's layout (layout.ts). The check's cases are shared with the server's port
// (`PageLayouts.cs`, `PageLayoutVectorTests`) through `vectors/page-layout-vectors.json`: rewrite it
// with `LAYOUT_VECTORS_WRITE=1`, then Prettier.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  bandParts,
  bandShown,
  checkLayout,
  pageBox,
  readLayout,
  withLayout,
  type PageLayout,
} from './layout';

interface CheckCase {
  name: string;
  layout: unknown;
  valid: boolean;
}

const long = 'x'.repeat(201);
const checks: CheckCase[] = [
  { name: 'no layout', layout: null, valid: true },
  { name: 'an empty object takes every default', layout: {}, valid: true },
  {
    name: 'every key set',
    layout: {
      size: 'letter',
      orientation: 'landscape',
      margins: 'narrow',
      header: { start: '{title}', center: '', end: '{date}' },
      footer: { start: '', center: 'Page {page} of {pages}', end: '' },
    },
    valid: true,
  },
  {
    name: 'Arabic text',
    layout: { footer: { center: 'صفحة {page} من {pages}' } },
    valid: true,
  },
  { name: 'keys a later build adds are kept', layout: { columns: { count: 2 } }, valid: true },
  { name: 'a band with some places', layout: { header: { end: 'Draft' } }, valid: true },
  {
    name: 'a place of 200 characters',
    layout: { header: { start: 'x'.repeat(200) } },
    valid: true,
  },
  { name: 'a list', layout: [], valid: false },
  { name: 'a string', layout: 'a4', valid: false },
  { name: 'a number', layout: 4, valid: false },
  { name: 'an unknown size', layout: { size: 'a3' }, valid: false },
  { name: 'a size in capitals', layout: { size: 'A4' }, valid: false },
  { name: 'an unknown orientation', layout: { orientation: 'upright' }, valid: false },
  { name: 'unknown margins', layout: { margins: 'none' }, valid: false },
  { name: 'margins as a number', layout: { margins: 10 }, valid: false },
  { name: 'a band that is text', layout: { header: 'Draft' }, valid: false },
  { name: 'a band that is null', layout: { footer: null }, valid: false },
  { name: 'a place that is a number', layout: { header: { start: 3 } }, valid: false },
  { name: 'a place of 201 characters', layout: { header: { start: long } }, valid: false },
  { name: 'a line break in a place', layout: { footer: { end: 'a\nb' } }, valid: false },
  { name: 'a tab in a place', layout: { footer: { end: 'a\tb' } }, valid: false },
  {
    name: 'more than 4,000 characters as JSON',
    layout: { note: 'x'.repeat(4000) },
    valid: false,
  },
];

const file = new URL('../vectors/page-layout-vectors.json', import.meta.url);
if (process.env.LAYOUT_VECTORS_WRITE === '1')
  writeFileSync(file, `${JSON.stringify({ check: checks }, null, 2)}\n`);
const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { check: CheckCase[] };

describe('page layout', () => {
  it('page-layout-vectors.json holds the cases as written', () => {
    expect(onDisk.check).toEqual(checks);
  });

  for (const c of onDisk.check)
    it(`checks ${c.name}`, () => {
      expect(checkLayout(c.layout) === null).toBe(c.valid);
    });

  it('reads a page with no layout as the default, and each key it cannot use as the default', () => {
    expect(readLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout({ size: 'a3', orientation: 'landscape', margins: 7 })).toEqual({
      ...DEFAULT_LAYOUT,
      orientation: 'landscape',
    } satisfies PageLayout);
  });

  it('reads a band the page sets as it is set, its other places empty', () => {
    const layout = readLayout({ header: { end: 'Draft' }, footer: { start: 3 } });
    expect(layout.header).toEqual({ start: '', center: '', end: 'Draft' });
    // A footer that is set holds no page number unless it says so.
    expect(layout.footer).toEqual({ start: '', center: '', end: '' });
    expect(bandShown(layout.footer)).toBe(false);
    expect(readLayout({}).footer).toEqual({ start: '', center: '{page}', end: '' });
  });

  it('keeps the keys it does not know when Page setup changes the ones it shows', () => {
    expect(withLayout({ columns: 2, size: 'a4' }, { size: 'letter' })).toEqual({
      columns: 2,
      size: 'letter',
    });
    expect(withLayout(null, { margins: 'wide' })).toEqual({ margins: 'wide' });
  });

  it('cuts a place into its text and its fields', () => {
    expect(bandParts('Page {page} of {pages} · {title} {nope} {date}')).toEqual([
      { text: 'Page ' },
      { field: 'page' },
      { text: ' of ' },
      { field: 'pages' },
      { text: ' · ' },
      { field: 'title' },
      { text: ' {nope} ' },
      { field: 'date' },
    ]);
    expect(bandParts('')).toEqual([]);
  });

  it("gives the paper's size as it lies, and the margins", () => {
    expect(pageBox(DEFAULT_LAYOUT)).toEqual({ width: 210, height: 297, block: 25.4, inline: 25.4 });
    expect(
      pageBox({ ...DEFAULT_LAYOUT, size: 'letter', orientation: 'landscape', margins: 'wide' }),
    ).toEqual({ width: 279.4, height: 215.9, block: 25.4, inline: 50.8 });
  });
});
