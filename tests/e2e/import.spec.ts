// Phase 8, M8.4: import from Markdown, Notion and Word, on the device. Each import into a local
// workspace and into a synced one (against the server stack, `scripts/server-stack.mjs --e2e`):
// the page tree, links between pages, a database with typed properties and row pages, images and
// files as assets, the report of what was skipped; a hostile archive contained, too many pages
// refused, a stop that keeps nothing; the panel in Arabic and dark, and Axe on it. The fixtures
// are made by code (packages/shell/src/exchange/fixtures/fixtures.ts), never downloaded.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { createWorkspace, editor, watchErrors } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  fullPage,
  grid,
  openRow,
  otherDevice,
  pageId,
  rowOf,
  signedInWorkspace,
  signers,
  signOutDesktop,
  treeRow,
} from './database';
import {
  manyPages,
  markdownFolder,
  notionExport,
  relatedNotionExport,
  traversalZip,
  wordDocument,
} from '../../packages/shell/src/exchange/fixtures/fixtures';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The Notion fixture's database rows. */
const ROWS = ['Write the spec', 'Review', 'Ship it', 'Plan the party'];

const panel = (page: Page) => page.getByRole('dialog', { name: /Import pages|استيراد صفحات/ });
const report = (page: Page) => page.getByTestId('import-report');

/** Settings → Your data → Import from Markdown, Notion or Word, with a kind chosen. */
async function openImport(page: Page, kind: 'Markdown' | 'A Notion export' | 'A Word document') {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Import from Markdown, Notion or Word' }).click();
  await expect(panel(page)).toBeVisible();
  await panel(page)
    .getByRole('radio', { name: new RegExp(`^${kind}`) })
    .check();
}

async function importBytes(
  page: Page,
  name: string,
  bytes: Uint8Array,
  mimeType = 'application/zip',
) {
  await panel(page)
    .getByTestId('import-file')
    .setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
  await expect(report(page)).toBeVisible({ timeout: 60000 });
}

/** The report's skipped entries' codes. */
const skipped = (page: Page) =>
  report(page)
    .locator('[data-code]')
    .evaluateAll((items) => items.map((i) => i.getAttribute('data-code')));

/** A page's row in the sidebar by its title (not a section whose name starts with it). */
const pageRow = (page: Page, title: string) =>
  page
    .getByRole('tree', { name: 'Pages' })
    .getByRole('treeitem', { name: new RegExp(`^${title}(\\s|$)`) })
    .first();

/** The assets a page's file blocks name, in the server's derived document. */
async function serverFiles(api: Awaited<ReturnType<typeof apiSession>>, id: string) {
  const answer = await api.get(`/api/v1/pages/${id}/doc/json`);
  const json = typeof answer.json === 'string' ? JSON.parse(answer.json) : answer.json;
  const ids: string[] = [];
  const walk = (node: { type?: string; attrs?: { assetId?: string }; content?: unknown[] }) => {
    if (node.type === 'file' && node.attrs?.assetId) ids.push(node.attrs.assetId);
    for (const child of node.content ?? []) walk(child as typeof node);
  };
  if (json) walk(json);
  return ids;
}

/**
 * Expands a page's row in the sidebar as a person does (focus it, ArrowRight). The tree opens the
 * ancestors of the page on screen but never the page itself, for an import's top page as for any
 * other (the CSV import's specs expand their page the same way).
 */
async function expandRow(page: Page, title: string) {
  const row = pageRow(page, title);
  await expect(row).toHaveAttribute('aria-expanded', /true|false/, { timeout: 30000 });
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.focus();
    await page.keyboard.press('ArrowRight');
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Opens a page from the sidebar by its path from the import's top page, expanding on the way. */
async function openPage(page: Page, ...path: string[]) {
  for (const parent of path.slice(0, -1)) await expandRow(page, parent);
  const title = path.at(-1)!;
  await pageRow(page, title).click();
  await expect(page.getByLabel('Page title')).toHaveValue(title);
}

/** Every image on the page has loaded its picture. */
async function imagesLoaded(scope: Locator) {
  await expect
    .poll(() =>
      scope
        .locator('.cgw-image img')
        .evaluateAll(
          (imgs) => imgs.length > 0 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
}

async function checkNotion(page: Page) {
  // The tree: Home at the end of the section, its pages, the database.
  await openPage(page, 'Home');
  const body = editor(page);
  await expect(body.locator('.cgw-child-page-title')).toHaveText(['Projects', 'Meeting notes']);
  await expect(body.locator('.cgw-db-block')).toHaveCount(1);
  await expect(body.locator('.cgw-body[data-kind="callout"]')).toContainText(
    'Remember to update the tasks.',
  );
  await imagesLoaded(body);
  // A link by the page's Notion address became a mention; following it opens the page.
  await body.locator('.cgw-page-mention', { hasText: 'Launch' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Launch');
  await expect(editor(page).locator('.cgw-body[data-kind="checkItem"]')).toHaveCount(2);
  // The database: typed columns and its rows; a row's page is its body.
  await expandRow(page, 'Home');
  await pageRow(page, 'Tasks').click();
  const db = fullPage(page);
  for (const title of ROWS) await expect(rowOf(db, title)).toBeVisible();
  await expect(grid(db).getByRole('columnheader')).toContainText([
    'Name',
    'Status',
    'Due',
    'Done',
    'Estimate',
    'Link',
    'Project',
  ]);
  await expect(rowOf(db, 'Write the spec')).toContainText('Doing');
  await openRow(page, 'Write the spec');
  await expect(editor(page)).toContainText('The spec covers import.');
  await expect(editor(page)).not.toContainText('Status: Doing');
  await imagesLoaded(editor(page));
}

test.describe('import', () => {
  test('a Notion export into a local workspace: pages, a typed database, row pages, links, images and the report', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const errors = watchErrors(page);
    await createWorkspace(page, 'Imports');
    const fixture = notionExport();
    await openImport(page, 'A Notion export');
    await importBytes(page, fixture.name, fixture.bytes);
    await expect(report(page)).toContainText('Pages: 4');
    await expect(report(page)).toContainText('Databases: 1');
    await expect(report(page)).toContainText('Rows: 4');
    await expect(report(page)).toContainText('Images: 2');
    expect(await skipped(page)).toEqual(
      expect.arrayContaining(['brokenLink', 'notLinked', 'linksAsText']),
    );
    await expect(report(page).locator('[data-code="notLinked"]')).toContainText('notes.bin');
    await report(page).getByRole('button', { name: 'Open the imported page' }).click();
    await expect(page.getByLabel('Page title')).toHaveValue('Home');
    await checkNotion(page);
    expect(errors).toEqual([]);
  });

  test('two related Notion databases: relations both ways, a files column, people as names', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const errors = watchErrors(page);
    await createWorkspace(page, 'Relations');
    const fixture = relatedNotionExport();
    await openImport(page, 'A Notion export');
    await importBytes(page, fixture.name, fixture.bytes);
    await expect(report(page)).toContainText('Databases: 2');
    expect(await skipped(page)).toEqual(
      expect.arrayContaining(['peopleAsText', 'linksAsText', 'filesAsText']),
    );
    await report(page).getByRole('button', { name: 'Close' }).click();
    // Tasks name their project; Projects list their tasks, the back relation filled in.
    await expandRow(page, 'Work');
    await pageRow(page, 'Tasks').click();
    const tasks = fullPage(page);
    await expect(rowOf(tasks, 'Write the spec')).toContainText('Launch');
    await expect(rowOf(tasks, 'Write the spec')).toContainText('brief.pdf');
    await expect(rowOf(tasks, 'Ship it')).toContainText('Website');
    await pageRow(page, 'Projects').click();
    const projects = fullPage(page);
    await expect(rowOf(projects, 'Launch')).toContainText('Write the spec');
    await expect(rowOf(projects, 'Launch')).toContainText('Review');
    await expect(rowOf(projects, 'Website')).toContainText('Ship it');
    await expect(rowOf(projects, 'Website')).toContainText('Launch');
    expect(errors).toEqual([]);
  });

  test('a Markdown folder into a local workspace: the tree after its folders, links, an image and a file', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    const errors = watchErrors(page);
    await createWorkspace(page, 'Markdown');
    // The folder on disk, chosen as a folder.
    const fixture = markdownFolder();
    const root = testInfo.outputPath('folder');
    for (const [path, bytes] of Object.entries(fixture.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    await openImport(page, 'Markdown');
    await panel(page).getByTestId('import-folder').setInputFiles(join(root, 'Handbook'));
    await expect(report(page)).toBeVisible({ timeout: 60000 });
    await expect(report(page)).toContainText('Pages: 6');
    expect(await skipped(page)).toEqual(
      expect.arrayContaining(['frontMatter', 'externalImage', 'brokenLink', 'notLinked']),
    );
    await report(page).getByRole('button', { name: 'Open the imported page' }).click();
    await expect(page.getByLabel('Page title')).toHaveValue('Handbook');
    await openPage(page, 'Handbook', 'Welcome');
    const body = editor(page);
    await imagesLoaded(body);
    await expect(body.locator('.cgw-file-name')).toHaveText('manual.pdf');
    await expect(body.locator('.cgw-bookmark')).toHaveCount(1);
    await body.locator('.cgw-page-mention', { hasText: 'Guide' }).click();
    await expect(page.getByLabel('Page title')).toHaveValue('Guide');
    await openPage(page, 'Handbook', 'Reference', 'API');
    await expect(editor(page).getByRole('table')).toContainText('string');
    expect(errors).toEqual([]);
  });

  test('a Word document into a local workspace: headings, lists, a table, an image, right to left', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const errors = watchErrors(page);
    await createWorkspace(page, 'Word');
    const fixture = wordDocument();
    await openImport(page, 'A Word document');
    await importBytes(
      page,
      fixture.name,
      fixture.bytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(await skipped(page)).toEqual(
      expect.arrayContaining(['trackedChanges', 'comments', 'textBoxes']),
    );
    await report(page).getByRole('button', { name: 'Open the imported page' }).click();
    await expect(page.getByLabel('Page title')).toHaveValue('Quarterly report');
    const body = editor(page);
    await expect(body.locator('.cgw-body[data-kind="heading"]')).toHaveText([
      'Summary',
      'Lists',
      'Figures',
    ]);
    await expect(body.getByRole('table')).toContainText('North');
    await expect(body.locator('.cgw-body[data-kind="bulletItem"]')).toHaveCount(3);
    await expect(body.locator('.cgw-body[dir="rtl"]')).toContainText('مرحبا بالعالم');
    await expect(body.getByRole('link', { name: 'A link' })).toHaveAttribute(
      'href',
      'https://example.com/report',
    );
    await imagesLoaded(body);
    expect(errors).toEqual([]);
  });

  test('a Notion export into a synced workspace reaches a second device, assets included', async ({
    page,
    authUrlFile,
  }) => {
    test.setTimeout(300000);
    const errors = watchErrors(page);
    const account = await newAccount('Importer');
    await signedInWorkspace(page, account, 'Synced imports', authUrlFile, cloud.signer);
    const fixture = notionExport();
    await openImport(page, 'A Notion export');
    await importBytes(page, fixture.name, fixture.bytes);
    await report(page).getByRole('button', { name: 'Close' }).click();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60000 });
    await checkNotion(page);
    // Another device of the same person: the pages, the rows and the pictures came through.
    const other = await otherDevice(await cloud.signer(), account);
    await openPage(other.page, 'Home');
    await expect(editor(other.page).locator('.cgw-child-page-title')).toHaveText([
      'Projects',
      'Meeting notes',
    ]);
    await imagesLoaded(editor(other.page));
    await expandRow(other.page, 'Home');
    await pageRow(other.page, 'Tasks').click();
    for (const title of ROWS) await expect(rowOf(fullPage(other.page), title)).toBeVisible();
    await other.context.close();
    expect(errors).toEqual([]);
  });

  test('a Markdown folder and a Word document into a synced workspace', async ({
    page,
    authUrlFile,
  }) => {
    test.setTimeout(240000);
    const account = await newAccount('Importer two');
    await signedInWorkspace(page, account, 'Synced files', authUrlFile, cloud.signer);
    await openImport(page, 'Markdown');
    const folder = markdownFolder();
    await importBytes(page, 'Handbook.zip', folder.bytes);
    await report(page).getByRole('button', { name: 'Import something else' }).click();
    await panel(page)
      .getByRole('radio', { name: /^A Word document/ })
      .check();
    const word = wordDocument();
    await importBytes(
      page,
      word.name,
      word.bytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await report(page).getByRole('button', { name: 'Close' }).click();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60000 });
    const other = await otherDevice(await cloud.signer(), account);
    await openPage(other.page, 'Handbook', 'Welcome');
    // The attachment reached the server, named and readable, and the second device draws its
    // block. (Its name shows there only once the host fetches the asset's record: a file block
    // whose asset another device uploaded reads "This file is not on this device" today, for any
    // file, not only an import's. A product gap reported to the parent, outside the import.)
    await expect(editor(other.page).locator('.cgw-file')).toHaveCount(1);
    const api = await apiSession(account);
    const welcome = pageId(other.page);
    await expect
      .poll(async () => (await serverFiles(api, welcome)).length, { timeout: 30000 })
      .toBe(1);
    const [assetId] = await serverFiles(api, welcome);
    await expect
      .poll(async () => (await api.raw(`/api/v1/assets/${assetId}/url`)).status, { timeout: 30000 })
      .toBe(200);
    expect(await api.get(`/api/v1/assets/${assetId}`)).toMatchObject({
      fileName: 'manual.pdf',
      contentType: 'application/pdf',
    });
    await api.dispose();
    await openPage(other.page, 'Quarterly report');
    await imagesLoaded(editor(other.page));
    await other.context.close();
  });

  test('a hostile archive is contained, too many pages are refused, and nothing is kept', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await createWorkspace(page, 'Hostile');
    const before = await page.getByRole('tree', { name: 'Pages' }).getByRole('treeitem').count();
    await openImport(page, 'Markdown');
    await importBytes(page, 'evil.zip', traversalZip());
    expect(await skipped(page)).toEqual(
      expect.arrayContaining(['unsafePath', 'tooDeep', 'namesCleaned']),
    );
    await report(page).getByRole('button', { name: 'Import something else' }).click();
    await panel(page)
      .getByTestId('import-file')
      .setInputFiles({
        name: 'many.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(manyPages(2001)),
      });
    await expect(panel(page).getByRole('alert')).toHaveText(
      'Nothing was imported: it makes 2,002 pages, and an import makes at most 2,000.',
    );
    await panel(page).getByRole('button', { name: 'Close' }).click();
    // The hostile archive's own pages are there; the refused one left nothing.
    await expect(page.getByRole('tree', { name: 'Pages' }).getByRole('treeitem')).toHaveCount(
      before + 1,
    );
    await expect(treeRow(page, 'evil')).toHaveCount(1);
  });

  test('the panel in Arabic and dark: right to left, Axe finds nothing', async ({ page }) => {
    test.skip(desktop, 'The web build covers the panel’s markup; the desktop runs the imports.');
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('cgw-language', 'ar');
      localStorage.setItem('cgw-theme', 'dark');
    });
    await page.reload();
    await page.getByLabel('اسم مساحة العمل').fill('استيراد');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeVisible();
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'استيراد من ماركداون أو نوشن أو وورد' }).click();
    const dialog = panel(page);
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const problems = (
      await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()
    ).violations;
    expect(problems.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await dialog.getByRole('radio', { name: /^تصدير من نوشن/ }).check();
    const fixture = notionExport();
    await dialog.getByTestId('import-file').setInputFiles({
      name: fixture.name,
      mimeType: 'application/zip',
      buffer: Buffer.from(fixture.bytes),
    });
    await expect(report(page)).toContainText('الصفحات: 4', { timeout: 60000 });
    const after = (
      await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()
    ).violations;
    expect(after.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    // No English of the app's own in the report (file names are the person's).
    const text = await report(page).evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('bdi').forEach((b) => b.remove());
      return copy.textContent ?? '';
    });
    expect(text).not.toMatch(/[A-Za-z]/);
  });
});
