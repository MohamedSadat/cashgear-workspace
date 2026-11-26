// Phase 19: a page out of the workspace, in the app. Export to Word on the device, offline too, the
// file read back by Phase 8's reader; Print and Save as PDF in Chrome and Edge for real (started
// headed with `--kiosk-printing`, the print dialog's "Save as PDF" remembered), the PDF read back
// with pdf.js: the layout's paper, header, footer and page numbers on every page, every block, a
// database block's rows as a table, no picture or row cut over two pages, Arabic as text in its
// order; on the Windows app, Save as PDF straight to a file. Page setup and the export's dialog
// under Axe, in Arabic, light and dark.
import AxeBuilder from '@axe-core/playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { kioskBrowser, points, readPdf, readWord, type PdfPage } from './pdf';
import { OUT_WORDS, everyBlockPage, pageMenu } from './out';
import { watchErrors } from './helpers';

const TASKS = [
  'Write the project brief',
  'Review the budget',
  'Book the kickoff meeting',
  'Send the weekly update',
];
const TASKS_AR = [
  'اكتب موجز المشروع',
  'راجع الميزانية',
  'احجز اجتماع الانطلاق',
  'أرسل التحديث الأسبوعي',
];

/** The download a click starts, as bytes. */
async function downloaded(
  page: Page,
  click: () => Promise<unknown>,
): Promise<{ name: string; bytes: Uint8Array }> {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path!)) };
}

/** The desktop app's saved file (CGW_SAVE_DIR) once it is there. */
async function savedFile(
  folder: string,
  extension: string,
): Promise<{ name: string; bytes: Uint8Array }> {
  let name: string | undefined;
  // The app makes the folder with its first file (a poll that throws fails at once).
  await expect
    .poll(
      () =>
        (name = existsSync(folder)
          ? readdirSync(folder).find((f) => f.endsWith(extension))
          : undefined),
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return { name: name!, bytes: new Uint8Array(readFileSync(join(folder, name!))) };
}

/**
 * Whether a cell's words are in the text in their order: a narrow column wraps a cell over lines,
 * and a PDF's lines run across the row's cells.
 */
const inOrder = (text: string, line: string) => {
  let at = 0;
  for (const word of line.split(' ')) {
    const found = text.indexOf(word, at);
    if (found < 0) return false;
    at = found + word.length;
  }
  return true;
};

/** Every page's text, a line's end read as a space (a cell's text wraps over its lines). */
const allText = (pages: PdfPage[]) =>
  pages
    .map((p) => p.text)
    .join('\n')
    .replace(/\s+/g, ' ');

test.describe('Word', () => {
  test('a page with every block in English, to Word on the device with the network off', async ({
    page,
    savedFolder,
  }) => {
    const errors = watchErrors(page);
    const title = await everyBlockPage(page, 'en');
    const words = OUT_WORDS.en;
    await page.context().setOffline(true);
    const { name, bytes } = savedFolder
      ? (await pageMenu(page, 'Export to Word'), await savedFile(savedFolder, '.docx'))
      : await downloaded(page, () => pageMenu(page, 'Export to Word'));
    expect(name).toBe(`${title}.docx`);
    // The notice says what the file left out: the picture the page names but the device lacks.
    await expect(page.locator('.cgw-notice')).toContainText(
      'Not in it: images not on this device: 1',
    );
    const read = readWord(bytes);
    expect(read.title).toBe(title);
    const lines = JSON.stringify(read.doc);
    for (const text of [
      words.h1,
      words.a1a,
      words.n3,
      words.inner,
      words.quote,
      words.callout,
      words.insideToggle,
      words.cellC,
      'Cash Gear ERP',
      ...TASKS,
    ])
      expect(lines, text).toContain(text);
    const kinds = (read.doc.content ?? []).map(
      (b) => `${b.content?.[0]?.type}:${String(b.content?.[0]?.attrs?.kind ?? '')}`,
    );
    expect(kinds).toContain('textBody:heading');
    expect(kinds).toContain('textBody:checkItem');
    expect(kinds).toContain('textBody:numberedItem');
    expect(kinds).toContain('codeBlock:');
    // The page's own table and the database's: two tables; the pasted picture, one image.
    expect(kinds.filter((k) => k === 'table:').length).toBe(2);
    expect(kinds.filter((k) => k === 'image:').length).toBe(1);
    // The layout's section: its header and footer, with the page's number.
    expect(read.parts['word/footer1.xml']).toContain('PAGE');
    expect(read.parts['word/document.xml']).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(
      errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(e)),
    ).toEqual([]);
  });

  test('a page with every block in Arabic, to Word: right to left, read back so', async ({
    page,
    savedFolder,
  }) => {
    test.skip(desktop, 'the English case covers the desktop’s save');
    void savedFolder;
    const title = await everyBlockPage(page, 'ar');
    const { name, bytes } = await downloaded(page, () => pageMenu(page, 'تصدير إلى Word', 'ar'));
    expect(name).toBe(`${title}.docx`);
    const read = readWord(bytes);
    expect(read.title).toBe(title);
    const bodies = (read.doc.content ?? [])
      .map((b) => b.content?.[0])
      .filter((b) => b?.type === 'textBody');
    // Every Arabic paragraph comes back right to left; the one set left to right, as none.
    const rtl = bodies.filter((b) => b?.attrs?.dir === 'rtl').length;
    expect(rtl).toBeGreaterThan(20);
    const english = bodies.find((b) => JSON.stringify(b).includes('English, set left to right.'));
    expect(english?.attrs?.dir ?? null).toBeNull();
    const lines = JSON.stringify(read.doc);
    for (const text of [OUT_WORDS.ar.h1, OUT_WORDS.ar.quote, ...TASKS_AR])
      expect(lines, text).toContain(text);
  });
});

test.describe('Print and PDF', () => {
  test.skip(desktop, 'printing in the Windows app is its own case below');

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from this pattern
  test('a page printed in its layout: Letter landscape, its header, footer and page numbers, every block, nothing cut', async ({}, testInfo) => {
    const channel = String(testInfo.project.use.channel ?? 'chrome');
    const { context, printed } = await kioskBrowser(channel, testInfo.outputPath('kiosk'));
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const title = await everyBlockPage(page, 'en');
      const words = OUT_WORDS.en;
      // Page setup: Letter, landscape, narrow margins; the title and the date at the head; the
      // page's number of the count at the foot.
      await pageMenu(page, 'Page setup…');
      const setup = page.getByRole('dialog', { name: 'Page setup' });
      await setup.getByRole('radio', { name: 'Letter' }).check();
      await setup.getByRole('radio', { name: 'Landscape' }).check();
      await setup.getByRole('radio', { name: 'Narrow' }).check();
      await setup.getByTestId('layout-header-start').fill('{title}');
      await setup.getByTestId('layout-header-end').fill('{date}');
      await setup.getByTestId('layout-footer-center').fill('Page {page} of {pages}');
      await expect(setup.getByTestId('layout-preview')).toHaveText(
        'At the foot of the first page: Page 1 of 1',
      );
      await setup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(setup).toHaveCount(0);
      const pdf = await printed(() => pageMenu(page, 'Print…'));
      const pages = await readPdf(pdf);
      expect(pages.length).toBeGreaterThan(2);
      for (const [i, p] of pages.entries()) {
        expect(Math.round(p.width), `page ${i + 1}'s width`).toBe(Math.round(points(279.4)));
        expect(Math.round(p.height), `page ${i + 1}'s height`).toBe(Math.round(points(215.9)));
        expect(p.text, `page ${i + 1}'s header`).toContain(title);
        expect(p.text, `page ${i + 1}'s footer`).toContain(`Page ${i + 1} of ${pages.length}`);
        for (const image of p.images) {
          expect(image.bottom, `an image cut at page ${i + 1}'s foot`).toBeGreaterThanOrEqual(-1);
          expect(image.top, `an image cut at page ${i + 1}'s head`).toBeLessThanOrEqual(
            p.height + 1,
          );
        }
      }
      const text = allText(pages);
      for (const line of [
        words.h1,
        words.h3,
        words.a1a,
        words.n3,
        words.open,
        words.quote,
        words.callout,
        words.insideToggle,
        words.cellC,
        'A file not on this device',
        'Cash Gear ERP: vendors',
        'In progress (1)',
        words.lastLine,
      ])
        expect(text, line).toContain(line);
      // Each of the database's rows on one page, once.
      for (const task of TASKS)
        expect(
          pages.filter((p) => p.text.includes(task)),
          task,
        ).toHaveLength(1);
      // The picture drawn whole, once.
      expect(pages.reduce((n, p) => n + p.images.length, 0)).toBe(1);
      // The layout is the page's: it came back from the store.
      await page.reload();
      await pageMenu(page, 'Page setup…');
      await expect(page.getByRole('radio', { name: 'Letter' })).toBeChecked();
    } finally {
      await context.close();
    }
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from this pattern
  test('an Arabic page saved as a PDF on the web: the dialog says which printer, Arabic is text in its order', async ({}, testInfo) => {
    const channel = String(testInfo.project.use.channel ?? 'chrome');
    const { context, printed } = await kioskBrowser(channel, testInfo.outputPath('kiosk'));
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await everyBlockPage(page, 'ar');
      await pageMenu(page, 'حفظ بصيغة PDF…', 'ar');
      const dialog = page.getByRole('dialog', { name: 'حفظ بصيغة PDF' });
      await expect(dialog).toContainText('Save as PDF');
      const pdf = await printed(() =>
        dialog.getByRole('button', { name: 'حفظ', exact: true }).click(),
      );
      const pages = await readPdf(pdf);
      // A4 portrait, the default layout: the page's number at the foot.
      for (const [i, p] of pages.entries()) {
        expect(Math.round(p.width)).toBe(Math.round(points(210)));
        expect(p.lines.at(-1), `page ${i + 1}'s footer`).toBe(String(i + 1));
      }
      const text = allText(pages);
      for (const line of [
        OUT_WORDS.ar.h1,
        OUT_WORDS.ar.quote,
        OUT_WORDS.ar.lastLine,
        'يكتب هذا السطر من اليمين إلى اليسار.',
        ...TASKS_AR,
      ])
        expect(text, line).toContain(line);
    } finally {
      await context.close();
    }
  });
});

test('the Windows app saves a page as a PDF straight to a file, with no print dialog', async ({
  page,
  savedFolder,
}) => {
  test.skip(!desktop, 'the Windows app only');
  const title = await everyBlockPage(page, 'en');
  await pageMenu(page, 'Save as PDF…');
  const { name, bytes } = await savedFile(savedFolder!, '.pdf');
  expect(name).toBe(`${title}.pdf`);
  const pages = await readPdf(bytes);
  expect(Math.round(pages[0].width)).toBe(Math.round(points(210)));
  for (const [i, p] of pages.entries()) expect(p.lines.at(-1)).toBe(String(i + 1));
  const text = allText(pages);
  for (const line of [OUT_WORDS.en.h1, OUT_WORDS.en.quote]) expect(text, line).toContain(line);
  for (const line of TASKS) expect(inOrder(text, line), line).toBe(true);
});

test.describe('Page setup and the export, for everyone', () => {
  test.skip(desktop, 'Axe and the narrow screen are browser concerns');

  for (const theme of ['light', 'dark'] as const)
    for (const language of ['en', 'ar'] as const)
      test(`Page setup and the export's dialog under Axe, ${language === 'ar' ? 'in Arabic' : 'in English'}, ${theme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await everyBlockPage(page, language);
        await pageMenu(page, language === 'ar' ? 'إعداد الصفحة…' : 'Page setup…', language);
        const setup = page.getByTestId('page-setup');
        await expect(setup).toBeVisible();
        const problems = (await new AxeBuilder({ page }).include('.cgw-dialog').analyze())
          .violations;
        expect(problems.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        if (language === 'ar') {
          await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
          const latin = await page.locator('.cgw-dialog').evaluate((dialog) => {
            const allowed =
              /\b(Word|PDF|A4|Letter|Save as PDF|Cash Gear ERP)\b|\{(title|date|page|pages)\}/g;
            const found: string[] = [];
            const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode())
              if (/[A-Za-z]{2,}/.test((node.textContent ?? '').replace(allowed, ' ')))
                found.push(node.textContent!.trim());
            return found;
          });
          expect(latin).toEqual([]);
        }
        await page.keyboard.press('Escape');
        await expect(setup).toHaveCount(0);
        // The export's dialog where it asks something: Save as PDF on the web names the printer.
        await pageMenu(page, language === 'ar' ? 'حفظ بصيغة PDF…' : 'Save as PDF…', language);
        const out = page.getByTestId('out-dialog');
        await expect(out).toBeVisible();
        const outProblems = (await new AxeBuilder({ page }).include('.cgw-dialog').analyze())
          .violations;
        expect(outProblems.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        await out.getByRole('button', { name: language === 'ar' ? 'إلغاء' : 'Cancel' }).click();
        await expect(out).toHaveCount(0);
      });
});
