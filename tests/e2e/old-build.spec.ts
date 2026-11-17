// The old builds against what this build writes: an older desktop app meeting newer documents
// and data must show them read-only, push nothing, and leave the server's bytes as they were. The
// old builds are the web builds of the releases (scripts/old-build.mjs, in target/old-build/<tag>,
// served on 127.0.0.1:4279 for v0.2.0, :4278 for v0.3.0, :4277 for v0.4.0, :4276 for v0.5.0 and
// :4275 for v0.6.0),
// each running the same document code as that release's desktop app (the app embeds that very
// build). Both builds talk to the e2e server stack as the same person.
//
// Phase 3 (v0.2.0, schema version 1): the page is made by the old build at version 1; this build
// opens it, which migrates it to this build's version (an ordinary edit, pushed; the worker raises
// the page). The old build, started again on its own copy, pulls that and must then show the page
// read-only, write nothing when typed into, and send no update; the server's state of the page
// (state hash and the updates' bytes) is the same before and after. A second page, made by this
// build and never held by the old build, is opened there too: v0.2.0 decides read-only when it
// opens a page, from what it holds, so a page it never held opens editable until opened again (an
// annotation says which); a third such page is typed into at that first open, to show what then
// happens (426, nothing stored on the server).
//
// Phase 4 (v0.3.0, schema version 2, no databases): a page holding a database block (schema 3)
// opens read-only there, the block drawn as needing a newer version, nothing sent, the server's
// bytes kept; and it never sees rows: its sidebar, its store and its sync know a database's page
// as a page, never its rows, while rows change on the server.
//
// Phase 5 (v0.4.0, schema version 3, no Sheet or ERP blocks): a page holding a workbook block and
// an ERP data block (schema 4) opens read-only there, both blocks drawn as needing a newer version,
// nothing sent but the visit, nothing asked of Sheet or the ERP, the server's bytes kept.
//
// Phase 6 (v0.5.0, schema version 4, no people in pages): a page naming a person (a
// `userMention`, schema 5) opens read-only there, the mention drawn in its line as needing a newer
// version, nothing sent but the visit, the server's bytes kept; and the feed's new kinds of change
// (a page's `comments`, a person's `notification`) pass it by: it stays synced.
//
// Phase 7 (v0.6.0, schema version 5, no plugin blocks): a page holding a chart and a kanban board
// (`pluginBlock`, schema 6) opens read-only there, both blocks drawn as needing a newer version,
// nothing sent but the visit, the server's bytes kept, and the blocks' props (with one this build
// does not know) exactly as this build wrote them when this build opens the page again.
//
// Phase 9 (v0.8.0 on :4272 and v0.7.0 on :4274, five view types): a timeline view, which neither
// knows, is drawn there as a table (their fallback); its filter changed there goes up as a
// `view.upsert` of type `table` without `viewTypes`, and the server keeps the stored type and the
// timeline's settings (the older-build rule): this build shows a timeline again, with its
// settings and the new filter.
//
// Phase 10 (v0.9.0 on :4271, schema 6 and `pluginBlock`, but no third-party plugins): a page
// holding a third-party plugin block (`pluginBlock` of a type v0.9.0 has no definition for, and
// for which it has no frame host) opens there with the block drawn as the editor's own placeholder
// ("needs a newer version", naming the type), the rest of the page editable (the schema is the
// same, so the page is not read-only); nothing of that block is sent, the server's bytes are kept,
// and this build draws the block's frame again with its props exactly as it wrote them.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { oldBuild, originOf, serveOldBuild } from '../../scripts/old-build.mjs';
import { writePluginBundles } from '../fixtures/plugins/make.mjs';
import { addView, chooseOptions, fullPage, grid, newDatabase, openRow, showView } from './database';
import {
  ERP_API,
  ERP_CLIENT,
  MOCK_SHEET,
  SHEET_ORIGIN,
  erpBlock,
  expectLive,
  insertErpBlock,
  insertExistingWorkbook,
  invite,
  newWorkbook,
  sheetBlock,
  watchAppErrors,
  workbookOf,
} from './ecosystem';

/** This build's document schema version (the old builds' are in their marker). */
const CURRENT = Number(
  readFileSync(join(import.meta.dirname, '../../packages/doc/src/schema.ts'), 'utf8').match(
    /SCHEMA_VERSION\s*=\s*(\d+)/,
  )![1],
);

test.skip(desktop, 'The old builds are web builds, in a browser');

const servers: { kill(): void }[] = [];
test.afterAll(() => servers.splice(0).forEach((s) => s.kill()));

// The reference plugin's bundle (tests/fixtures/plugins), for the v0.9.0 case; the preview this
// build is run under must be made with VITE_CGW_PLUGINS so the slash menu lists it.
const PLUGIN_BUNDLE = desktop
  ? ''
  : writePluginBundles(mkdtempSync(`${tmpdir()}/cgw-old-plugins-`)).reference;
async function serve(tag: string) {
  test.skip(!oldBuild(tag), `No ${tag} build: run node scripts/old-build.mjs first`);
  const child = await serveOldBuild(tag);
  if (child) servers.push(child);
  return originOf(tag);
}

const NEWER =
  'This page was saved by a newer version of Cash Gear Workspace. It is shown read-only; update the app to edit it.';

type Api = Awaited<ReturnType<typeof apiSession>>;

/** The server's state of a page: its state hash (once the worker has it) and every update's bytes. */
async function serverState(api: Api, pageId: string) {
  let hash: { epoch: number; upToSeq: number; hash: string | null } | null = null;
  await expect
    .poll(
      async () => {
        hash = await api.get(`/api/v1/pages/${pageId}/doc/state-hash`);
        return hash!.hash;
      },
      { timeout: 30000 },
    )
    .not.toBeNull();
  const pull = await api.get(`/api/v1/pages/${pageId}/doc?after=0`);
  return { hash, updates: pull.updates, snapshot: pull.snapshot, headSeq: pull.headSeq };
}

async function pageRecord(api: Api, workspaceId: string, pageId: string) {
  const tree = await api.get(`/api/v1/workspaces/${workspaceId}/tree`);
  return tree.pages.find((p: { id: string }) => p.id === pageId);
}

const pageIdOf = (page: Page) => new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];

test('the v0.2.0 build shows a migrated page read-only, sends nothing, and the server keeps its bytes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD_ORIGIN = await serve('v0.2.0');
  const account = await newAccount('Two builds');
  const api = await apiSession(account);

  // The old build makes the page, at version 1.
  const oldContext = await browser.newContext({ baseURL: OLD_ORIGIN });
  let old = await oldContext.newPage();
  await old.goto(`${OLD_ORIGIN}/`);
  await signIn(old, account, `${OLD_ORIGIN}/`);
  await signedIn(old, account);
  await old.getByLabel('Workspace name').fill('Two builds');
  await old.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(old)).toBeVisible();
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await newPage(old, 'Made by the old build');
  await old.keyboard.type('Written by version one');
  await waitSaved(old);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  const migratedId = pageIdOf(old);
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Two builds')!.id;
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, migratedId))?.docSchemaVersion, {
      timeout: 30000,
    })
    .toBe(1);
  // Away from the page, and closed: the old build's next start must not have it open already.
  await old.goto(`${OLD_ORIGIN}/#/settings`);
  await old.close();

  // This build opens it (and so migrates it), and makes a page of its own at version 2.
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByRole('treeitem', { name: /Made by the old build/ }).click({ timeout: 30000 });
  await expect(editor(now)).toContainText('Written by version one', { timeout: 20000 });
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, migratedId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  await newPage(now, 'Made by the new build');
  await now.keyboard.type('Written by version two');
  await waitSaved(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const newerId = pageIdOf(now);
  await newPage(now, 'Typed into by the old build');
  await now.keyboard.type('Also version two');
  await waitSaved(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const typedId = pageIdOf(now);
  for (const id of [newerId, typedId])
    await expect
      .poll(async () => (await pageRecord(api, workspaceId, id))?.docSchemaVersion, {
        timeout: 60000,
      })
      .toBe(CURRENT);
  expect(nowErrors).toEqual([]);
  await current.close();
  const before = {
    migrated: await serverState(api, migratedId),
    newer: await serverState(api, newerId),
    typed: await serverState(api, typedId),
  };

  // The old build starts again on its own copy, away from the page, and syncs.
  old = await oldContext.newPage();
  const pushes: string[] = [];
  const answers: number[] = [];
  old.on('request', (request) => {
    if (request.method() === 'POST' && /\/doc\/(updates|repair)$/.test(request.url()))
      pushes.push(request.url());
  });
  old.on('response', (response) => {
    if (/\/doc\/(updates|repair)$/.test(response.url())) answers.push(response.status());
  });
  await old.goto(`${OLD_ORIGIN}/#/settings`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  // The migrated page: read-only, with the banner, and typing writes nothing.
  await old.getByRole('treeitem', { name: /Made by the old build/ }).click({ timeout: 30000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(editor(old)).toContainText('Written by version one');
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  await expect(old.getByLabel('Page title')).not.toBeEditable();
  const shown = await editor(old).innerText();
  await editor(old).click();
  await old.keyboard.type('typed in the old build');
  await old.keyboard.press('Enter');
  await expect(editor(old)).toHaveText(shown);
  await expect(old.getByTestId('save-status')).not.toHaveText(/Saving|Unsaved/);

  // The page it never held: v0.2.0 opens an empty document, then pulls the server's. Whether that
  // first open is read-only is recorded; started again from its store it must be.
  await old.getByRole('treeitem', { name: /Made by the new build/ }).click({ timeout: 30000 });
  await expect(editor(old)).toContainText('Written by version two', { timeout: 20000 });
  const firstOpenReadOnly = (await old.getByText(NEWER).count()) > 0;
  test.info().annotations.push({
    type: 'v0.2.0, first open of a page it never held',
    description: firstOpenReadOnly
      ? 'read-only at once'
      : 'opened editable until reopened (v0.2.0 decides at open, before the pull); nothing typed there',
  });
  await old.goto(`${OLD_ORIGIN}/#/settings`);
  await old.reload();
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await old.getByRole('treeitem', { name: /Made by the new build/ }).click({ timeout: 30000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  await editor(old).click();
  await old.keyboard.type('typed again');
  await expect(editor(old)).toHaveText('Written by version two');

  // A few passes of its sync loop later: nothing was sent.
  await old.waitForTimeout(5000);
  expect(pushes, `updates the old build sent (answered ${answers.join(', ')})`).toEqual([]);

  // What v0.2.0 does when someone types at that first open (it cannot be changed now): the edit
  // is pushed and refused with 426 (client.tooOld); the old build keeps it unsent and says the
  // page needs a newer version.
  await old.getByRole('treeitem', { name: /Typed into by the old build/ }).click();
  await expect(editor(old)).toContainText('Also version two', { timeout: 20000 });
  if ((await old.getByText(NEWER).count()) === 0) {
    await editor(old).click();
    await old.keyboard.press('Control+End');
    await old.keyboard.type(' typed at the first open');
    await expect.poll(() => answers.length, { timeout: 30000 }).toBeGreaterThan(0);
    expect(new Set(answers)).toEqual(new Set([426]));
    await expect(
      old.getByText('This page needs a newer version of the app to edit it.'),
    ).toBeVisible();
    test.info().annotations.push({
      type: 'v0.2.0, typed at that first open',
      description: `${pushes.length} push(es), answered ${answers.join(', ')}; the server kept its bytes`,
    });
  }

  // The server holds what it held, for all three pages.
  const after = {
    migrated: await serverState(api, migratedId),
    newer: await serverState(api, newerId),
    typed: await serverState(api, typedId),
  };
  expect(after).toEqual(before);
  expect((await pageRecord(api, workspaceId, migratedId)).docSchemaVersion).toBe(CURRENT);
  await oldContext.close();
  await api.dispose();
});

test('the v0.3.0 build shows a page with a database read-only, sends nothing, and never sees rows', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD = await serve('v0.3.0');
  const account = await newAccount('Two releases');
  const api = await apiSession(account);

  // This build: a page holding a database (schema 3), and a database of its own with rows.
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByLabel('Workspace name').fill('Two releases');
  await now.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(now)).toBeVisible();
  await newPage(now, 'Plans with a table');
  await now.keyboard.type('Written by version three');
  await now.keyboard.press('Enter');
  await now.keyboard.type('/database');
  await now.getByRole('option', { name: /^Database/ }).click();
  await now
    .getByRole('dialog', { name: 'New database' })
    .getByRole('button', { name: 'Create' })
    .click();
  await expect(editor(now).locator('.cgw-db')).toBeVisible();
  await waitSaved(now);
  const plansId = pageIdOf(now);
  await newDatabase(now, 'Tasks');
  const tasksId = pageIdOf(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Two releases')!.id;
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, plansId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  const rowTitles = (
    (await api.get(`/api/v1/databases/${tasksId}/rows?limit=100`)).rows as { title: string }[]
  ).map((r) => r.title);
  expect(rowTitles).toContain('Review the budget');
  // The old build shows a newer page from the worker's derived document, a moment behind the
  // updates: wait until it holds the database block (under load it was a step behind; the old
  // build then showed the page without its placeholder).
  await expect
    .poll(
      async () => ((await api.get(`/api/v1/pages/${plansId}/doc/json`)) as { json: string }).json,
      { timeout: 60000 },
    )
    .toContain('databaseView');
  const before = await serverState(api, plansId);

  // v0.3.0, signed in as the same person on its own copy.
  const oldContext = await browser.newContext({ baseURL: OLD });
  const old = await oldContext.newPage();
  const oldErrors: string[] = [];
  old.on('pageerror', (error) => oldErrors.push(error.message));
  // Document updates, and operations other than the visits opening a page records.
  const pushes: string[] = [];
  old.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (/\/doc\/(updates|repair)$/.test(request.url())) pushes.push(request.url());
    if (/\/ops$/.test(request.url()))
      for (const op of (request.postDataJSON()?.ops ?? []) as { type: string }[])
        if (op.type !== 'visit.record') pushes.push(`${op.type} ${request.url()}`);
  });
  await old.goto(`${OLD}/`);
  await signIn(old, account, `${OLD}/`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  const sidebar = old.getByRole('tree', { name: 'Pages' });
  // The database is a page to it; its rows are nowhere.
  await expect(sidebar.getByRole('treeitem', { name: /Tasks/ })).toBeVisible({ timeout: 30000 });
  for (const title of rowTitles)
    await expect(sidebar.getByRole('treeitem', { name: new RegExp(title) })).toHaveCount(0);

  // The page with a database: read-only, the block drawn as needing a newer version.
  await sidebar.getByRole('treeitem', { name: /Plans with a table/ }).click();
  await expect(editor(old)).toContainText('Written by version three', { timeout: 20000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(
    editor(old).getByText('This block needs a newer version of Cash Gear Workspace.'),
  ).toBeVisible();
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  const shown = (await editor(old).textContent())!;
  await editor(old).click();
  await old.keyboard.type('typed in the old build');
  await old.keyboard.press('Enter');
  await expect(editor(old)).toHaveText(shown);
  // The database's own page opens as an (empty) page: no table, no row.
  await sidebar.getByRole('treeitem', { name: /Tasks/ }).click();
  await expect(old.getByLabel('Page title')).toHaveValue('Tasks', { timeout: 20000 });
  await expect(old.locator('[role="grid"]')).toHaveCount(0);
  for (const title of rowTitles) await expect(old.getByText(title)).toHaveCount(0);

  // Rows change on the server meanwhile: their feed changes are not its kind, and it stays well.
  const again = await current.newPage();
  await again.goto(`/#/p/${tasksId}`);
  await showView(fullPage(again), 'All tasks');
  await openRow(again, 'Review the budget');
  await chooseOptions(again, 'Status', ['Done']);
  await expect(syncStatus(again)).toHaveText('Synced', { timeout: 30000 });
  await old.waitForTimeout(5000);
  await expect(syncStatus(old)).toHaveText('Synced');
  const stored = await old.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const open = indexedDB.open('cgw-workspace');
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('pages').objectStore('pages').getAll();
          all.onsuccess = () => {
            db.close();
            done((all.result as { title: string }[]).map((p) => p.title));
          };
        };
      }),
  );
  expect(stored).toContain('Tasks');
  for (const title of rowTitles) expect(stored).not.toContain(title);

  // Nothing sent, and the server holds what it held.
  expect(pushes, 'what the old build sent').toEqual([]);
  expect(await serverState(api, plansId)).toEqual(before);
  expect(oldErrors).toEqual([]);
  expect(nowErrors).toEqual([]);
  await oldContext.close();
  await current.close();
  await api.dispose();
});

test('the v0.4.0 build shows a page with a workbook and ERP data read-only, sends nothing but visits, and the server keeps its bytes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD = await serve('v0.4.0');
  const account = await newAccount('Three releases');
  const api = await apiSession(account);

  // This build: a page holding an ERP data block and a workbook block (schema 4).
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchAppErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByLabel('Workspace name').fill('Three releases');
  await now.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(now)).toBeVisible();
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Three releases')!.id;
  await newWorkbook(api, workspaceId, 'Old budget', workbookOf([['Item'], ['Rent']]));
  await newPage(now, 'Plans with a workbook');
  await now.keyboard.type('Written by version four');
  await now.keyboard.press('Enter');
  await insertErpBlock(now);
  await expect(erpBlock(now).getByTestId('erp-no-link')).toBeVisible({ timeout: 30000 });
  await insertExistingWorkbook(now, 'Old budget');
  await expectLive(sheetBlock(now), 'Rent');
  await waitSaved(now);
  const plansId = pageIdOf(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, plansId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  expect(CURRENT).toBeGreaterThanOrEqual(4);
  // The worker's derived document has both blocks: the server holds the whole page.
  await expect
    .poll(
      async () => ((await api.get(`/api/v1/pages/${plansId}/doc/json`)) as { json: string }).json,
      { timeout: 60000 },
    )
    .toMatch(/sheetEmbed[\s\S]*erpView|erpView[\s\S]*sheetEmbed/);
  const before = await serverState(api, plansId);
  await current.close();

  // v0.4.0, signed in as the same person on its own copy.
  const oldContext = await browser.newContext({ baseURL: OLD });
  const old = await oldContext.newPage();
  const oldErrors: string[] = [];
  old.on('pageerror', (error) => oldErrors.push(error.message));
  const pushes: string[] = [];
  const elsewhere: string[] = [];
  old.on('request', (request) => {
    const url = request.url();
    if ([MOCK_SHEET, SHEET_ORIGIN, ERP_API, ERP_CLIENT].some((o) => url.startsWith(o)))
      elsewhere.push(url);
    if (/\/workbooks|\/erp-links|\/sheet-sessions/.test(url)) elsewhere.push(url);
    if (request.method() !== 'POST') return;
    if (/\/doc\/(updates|repair)$/.test(url)) pushes.push(url);
    if (/\/ops$/.test(url))
      for (const op of (request.postDataJSON()?.ops ?? []) as { type: string }[])
        if (op.type !== 'visit.record') pushes.push(`${op.type} ${url}`);
  });
  await old.goto(`${OLD}/`);
  await signIn(old, account, `${OLD}/`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  const sidebar = old.getByRole('tree', { name: 'Pages' });
  await sidebar.getByRole('treeitem', { name: /Plans with a workbook/ }).click({ timeout: 30000 });
  await expect(editor(old)).toContainText('Written by version four', { timeout: 20000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(
    editor(old).getByText('This block needs a newer version of Cash Gear Workspace.'),
  ).toHaveCount(2);
  await expect(editor(old).locator('iframe')).toHaveCount(0);
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  await expect(old.getByLabel('Page title')).not.toBeEditable();
  const shown = (await editor(old).textContent())!;
  await editor(old).click();
  await old.keyboard.type('typed in the old build');
  await old.keyboard.press('Enter');
  await expect(editor(old)).toHaveText(shown);
  // Started again from its store: still read-only, the same placeholders.
  await old.reload();
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(
    editor(old).getByText('This block needs a newer version of Cash Gear Workspace.'),
  ).toHaveCount(2);
  await old.waitForTimeout(5000);

  expect(pushes, 'what the old build sent').toEqual([]);
  expect(elsewhere, 'what the old build asked of Sheet, the ERP or their routes').toEqual([]);
  expect(await serverState(api, plansId)).toEqual(before);
  expect(oldErrors).toEqual([]);
  expect(nowErrors).toEqual([]);
  await oldContext.close();
  await api.dispose();
});

/** A UUIDv7, as the app makes its ids: the comment routes take no other. */
function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('the v0.5.0 build shows a version-5 page read-only, sends nothing but visits, and the server keeps its bytes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD = await serve('v0.5.0');
  const account = await newAccount('Four releases');
  const colleagueAccount = await newAccount('Colleague');
  const api = await apiSession(account);
  const me = (await api.get('/api/v1/account/me')) as { id: string };

  // This build: a page naming a colleague (schema 5).
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchAppErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByLabel('Workspace name').fill('Four releases');
  await now.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(now)).toBeVisible();
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Four releases')!.id;
  const colleague = await invite(api, workspaceId, colleagueAccount);
  const them = (await colleague.get('/api/v1/account/me')) as { id: string };
  await newPage(now, 'Plans with a person');
  await now.keyboard.type('Written by version five');
  await now.keyboard.press('Enter');
  // The mention as the clipboard brings it (the "@" menu's people are the shell's).
  await editor(now).evaluate((root, userId) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      `<p>Ask <span data-user-mention="" data-userid="${userId}">@</span> to review</p>`,
    );
    root.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, them.id);
  await expect(editor(now).locator('.cgw-user-mention')).toHaveCount(1);
  await expect(editor(now)).toContainText('Ask @');
  await waitSaved(now);
  const plansId = pageIdOf(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, plansId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  expect(CURRENT).toBeGreaterThanOrEqual(5);
  // The worker's derived document has the mention: the server holds the whole page.
  await expect
    .poll(
      async () => {
        // 404 until the worker has derived the page.
        const { status, body } = await api.raw(`/api/v1/pages/${plansId}/doc/json`);
        if (status !== 200) return false;
        const { json } = JSON.parse(body) as { json: string };
        return json.includes('"userMention"') && json.includes(them.id);
      },
      { timeout: 60000 },
    )
    .toBe(true);
  // The colleague comments on the page and names its maker: a `comments` change in the feed, and
  // a `notification` change in the maker's own feed.
  const blockId = (await editor(now).locator('[data-block]').nth(1).getAttribute('data-block-id'))!;
  const comment = (text: string) => [
    { type: 'text', text },
    { type: 'userMention', attrs: { userId: me.id } },
  ];
  const threadId = uuidv7();
  await colleague.post(`/api/v1/pages/${plansId}/comments/threads`, {
    id: threadId,
    blockId,
    anchor: { start: null, end: null },
    quote: '',
    comment: { id: uuidv7(), body: comment('Shall we, ') },
  });
  await expect
    .poll(
      async () =>
        ((await api.get('/api/v1/account/notifications?unread=true')) as { unread: number }).unread,
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(1);
  const before = await serverState(api, plansId);
  await current.close();

  // v0.5.0, signed in as the same person on its own copy.
  const oldContext = await browser.newContext({ baseURL: OLD });
  const old = await oldContext.newPage();
  const oldErrors: string[] = [];
  old.on('pageerror', (error) => oldErrors.push(error.message));
  const pushes: string[] = [];
  old.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'POST') return;
    if (/\/doc\/(updates|repair)$/.test(url)) pushes.push(url);
    if (/\/ops$/.test(url))
      for (const op of (request.postDataJSON()?.ops ?? []) as { type: string }[])
        if (op.type !== 'visit.record') pushes.push(`${op.type} ${url}`);
  });
  await old.goto(`${OLD}/`);
  await signIn(old, account, `${OLD}/`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  const sidebar = old.getByRole('tree', { name: 'Pages' });
  await sidebar.getByRole('treeitem', { name: /Plans with a person/ }).click({ timeout: 30000 });
  await expect(editor(old)).toContainText('Written by version five', { timeout: 20000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  // The mention is a placeholder in its line; the text around it stays.
  await expect(editor(old)).toContainText('Ask [needs a newer version] to review');
  await expect(editor(old).locator('.cgw-user-mention')).toHaveCount(0);
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  await expect(old.getByLabel('Page title')).not.toBeEditable();
  const shown = (await editor(old).textContent())!;
  await editor(old).click();
  await old.keyboard.type('typed in the old build');
  await old.keyboard.press('Enter');
  await expect(editor(old)).toHaveText(shown);
  // A reply while it is open: more of the new kinds of change, passed by.
  await colleague.post(`/api/v1/comments/threads/${threadId}/comments`, {
    id: uuidv7(),
    body: comment('or later, '),
  });
  await old.waitForTimeout(5000);
  await expect(syncStatus(old)).toHaveText('Synced');
  // Started again from its store: still read-only, the same placeholder.
  await old.reload();
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await expect(editor(old)).toContainText('Ask [needs a newer version] to review');
  await old.waitForTimeout(5000);

  expect(pushes, 'what the old build sent').toEqual([]);
  expect(await serverState(api, plansId)).toEqual(before);
  expect(oldErrors).toEqual([]);
  expect(nowErrors).toEqual([]);
  await oldContext.close();
  await colleague.dispose();
  await api.dispose();
});

test('the v0.6.0 build shows a page with plugin blocks read-only, sends nothing but visits, and the server keeps its bytes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD = await serve('v0.6.0');
  const account = await newAccount('Five releases');
  const api = await apiSession(account);

  // This build: a page with a database, a chart of it and a board of it (schema 6).
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchAppErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByLabel('Workspace name').fill('Five releases');
  await now.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(now)).toBeVisible();
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Five releases')!.id;
  await newPage(now, 'Plans with a chart');
  await now.keyboard.type('Written by version six');
  await now.keyboard.press('Enter');
  for (const name of ['Chart', 'Kanban board']) {
    await now.keyboard.type(`/${name}`);
    await expect(now.getByRole('option', { name, exact: true })).toBeVisible();
    await now.keyboard.press('Enter');
  }
  await expect(editor(now).locator('[data-body="pluginBlock"]')).toHaveCount(2);
  await expect(editor(now).locator('[data-body="pluginBlock"]').first()).toContainText(
    'No database chosen.',
  );
  await waitSaved(now);
  const plansId = pageIdOf(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, plansId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  expect(CURRENT).toBeGreaterThanOrEqual(6);
  // The worker's derived document holds both plugin blocks.
  let derived = '';
  await expect
    .poll(
      async () => {
        const { status, body } = await api.raw(`/api/v1/pages/${plansId}/doc/json`);
        if (status !== 200) return false;
        derived = (JSON.parse(body) as { json: string }).json;
        return derived.includes('cashgear.chart') && derived.includes('cashgear.kanban');
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const before = await serverState(api, plansId);
  await current.close();

  // v0.6.0, signed in as the same person on its own copy.
  const oldContext = await browser.newContext({ baseURL: OLD });
  const old = await oldContext.newPage();
  const oldErrors: string[] = [];
  old.on('pageerror', (error) => oldErrors.push(error.message));
  const pushes: string[] = [];
  old.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'POST') return;
    if (/\/doc\/(updates|repair)$/.test(url)) pushes.push(url);
    if (/\/ops$/.test(url))
      for (const op of (request.postDataJSON()?.ops ?? []) as { type: string }[])
        if (op.type !== 'visit.record') pushes.push(`${op.type} ${url}`);
  });
  await old.goto(`${OLD}/`);
  await signIn(old, account, `${OLD}/`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  const sidebar = old.getByRole('tree', { name: 'Pages' });
  await sidebar.getByRole('treeitem', { name: /Plans with a chart/ }).click({ timeout: 30000 });
  await expect(editor(old)).toContainText('Written by version six', { timeout: 20000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  // Both blocks are placeholders where they were.
  await expect(
    editor(old).getByText('This block needs a newer version of Cash Gear Workspace.'),
  ).toHaveCount(2);
  await expect(editor(old).locator('[data-body="pluginBlock"]')).toHaveCount(0);
  await expect(old.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  const shown = (await editor(old).textContent())!;
  await editor(old).click();
  await old.keyboard.type('typed in the old build');
  await old.keyboard.press('Enter');
  await expect(editor(old)).toHaveText(shown);
  await old.reload();
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await expect(old.getByText(NEWER)).toBeVisible({ timeout: 20000 });
  await old.waitForTimeout(5000);

  expect(pushes, 'what the old build sent').toEqual([]);
  expect(await serverState(api, plansId)).toEqual(before);
  expect(oldErrors).toEqual([]);
  expect(nowErrors).toEqual([]);
  await oldContext.close();

  // This build again: the blocks are as it wrote them.
  const again = await browser.newContext();
  const back = await again.newPage();
  await back.goto('/');
  await signIn(back, account);
  await signedIn(back, account);
  await back
    .getByRole('tree', { name: 'Pages' })
    .getByRole('treeitem', { name: /Plans with a chart/ })
    .click();
  await expect(editor(back).locator('[data-body="pluginBlock"]')).toHaveCount(2);
  const { body } = await api.raw(`/api/v1/pages/${plansId}/doc/json`);
  expect((JSON.parse(body) as { json: string }).json).toBe(derived);
  await again.close();
  await api.dispose();
});

/** A view as the server holds it (its tree). */
type ServerView = { id: string; name: string; type: string; config: Record<string, unknown> };
async function serverView(api: Api, workspaceId: string, name: string): Promise<ServerView> {
  const tree = await api.get(`/api/v1/workspaces/${workspaceId}/tree`);
  return (tree.views as ServerView[]).find((v) => v.name === name)!;
}

for (const tag of ['v0.8.0', 'v0.7.0'] as const)
  test(`the ${tag} build shows a timeline view as a table, and its filter changed there leaves it a timeline with its settings`, async ({
    browser,
  }) => {
    test.setTimeout(240000);
    const OLD = await serve(tag);
    const account = await newAccount(`Timeline and ${tag}`);
    const api = await apiSession(account);

    // This build: a Tasks database with a timeline view, laned by status, by months, no list.
    const current = await browser.newContext();
    const now = await current.newPage();
    const nowErrors = watchAppErrors(now);
    await now.goto('/');
    await signIn(now, account);
    await signedIn(now, account);
    await now.getByLabel('Workspace name').fill(`Timeline ${tag}`);
    await now.getByRole('button', { name: 'Create workspace' }).click();
    await expect(editor(now)).toBeVisible();
    await newDatabase(now, 'Tasks');
    const db = fullPage(now);
    await addView(db, now, 'Timeline');
    await expect(db.locator('.cgw-db-tl')).toBeVisible();
    await db.getByRole('button', { name: 'Layout', exact: true }).click();
    const layout = now.getByRole('dialog', { name: 'Layout' });
    await layout.getByLabel('Lanes by').selectOption({ label: 'Status' });
    await layout.getByLabel('Zoom').selectOption({ label: 'Months' });
    await layout.getByLabel('Show the rows with no date beside it').uncheck();
    await now.keyboard.press('Escape');
    await expect(db.locator('[data-cg-timeline-lane]').first()).toBeVisible();
    await expect(syncStatus(now)).toHaveAttribute('data-state', 'synced', { timeout: 30000 });
    const workspaceId = (
      (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
    ).find((w) => w.name === `Timeline ${tag}`)!.id;
    const made = await serverView(api, workspaceId, 'Timeline');
    expect(made.type).toBe('timeline');
    expect(made.config.timeline).toMatchObject({ scale: 'month', undated: false });
    expect((made.config.timeline as { lane: string }).lane).toBeTruthy();
    expect(made.config.filter).toBeNull();
    await current.close();

    // The older build, signed in as the same person: the timeline is a table there.
    const oldContext = await browser.newContext({ baseURL: OLD });
    const old = await oldContext.newPage();
    const oldErrors: string[] = [];
    old.on('pageerror', (error) => oldErrors.push(error.message));
    const upserts: { type: string; payload: Record<string, unknown> }[] = [];
    old.on('request', (request) => {
      if (request.method() !== 'POST' || !/\/ops$/.test(request.url())) return;
      for (const op of (request.postDataJSON()?.ops ?? []) as {
        type: string;
        payload: Record<string, unknown>;
      }[])
        if (op.type === 'view.upsert') upserts.push(op);
    });
    await old.goto(`${OLD}/`);
    await signIn(old, account, `${OLD}/`);
    await signedIn(old, account);
    await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
    await old
      .getByRole('tree', { name: 'Pages' })
      .getByRole('treeitem', { name: /Tasks/ })
      .click({ timeout: 30000 });
    const oldDb = fullPage(old);
    await showView(oldDb, 'Timeline');
    await expect(grid(oldDb)).toBeVisible({ timeout: 20000 });
    await expect(oldDb.locator('.cgw-db-tl')).toHaveCount(0);
    // Its filter changed there: Status is Not started.
    await oldDb.getByRole('button', { name: 'Filter', exact: true }).click();
    const filters = old.getByRole('dialog', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Add a filter', exact: true }).click();
    await filters.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Status' });
    await filters.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Not started' });
    await old.keyboard.press('Escape');
    await expect(oldDb.getByRole('button', { name: 'Filters: 1' })).toBeVisible();
    await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
    await expect.poll(() => upserts.length, { timeout: 30000 }).toBeGreaterThan(0);
    // It sent the view as a table, and said nothing of the types it knows.
    expect(upserts.every((op) => op.payload.type === 'table')).toBe(true);
    expect(upserts.some((op) => 'viewTypes' in op.payload)).toBe(false);
    expect(oldErrors).toEqual([]);
    await oldContext.close();

    // The server kept the type and the settings, and took the filter.
    await expect
      .poll(async () => (await serverView(api, workspaceId, 'Timeline')).config.filter, {
        timeout: 30000,
      })
      .not.toBeNull();
    const kept = await serverView(api, workspaceId, 'Timeline');
    expect(kept.type).toBe('timeline');
    expect(kept.config.timeline).toEqual(made.config.timeline);
    expect(JSON.stringify(kept.config.filter)).toContain('"condition"');

    // This build again: a timeline, by months and in lanes, with the filter from the older build.
    const again = await browser.newContext();
    const back = await again.newPage();
    await back.goto('/');
    await signIn(back, account);
    await signedIn(back, account);
    await back
      .getByRole('tree', { name: 'Pages' })
      .getByRole('treeitem', { name: /Tasks/ })
      .click();
    const backDb = fullPage(back);
    await showView(backDb, 'Timeline');
    await expect(backDb.locator('.cgw-db-tl')).toBeVisible({ timeout: 20000 });
    await expect(backDb.locator('[data-cg-timeline-scale="month"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(backDb.locator('[data-cg-timeline-lane]').first()).toBeVisible();
    await expect(backDb.locator('.cgw-cal-undated')).toHaveCount(0);
    await expect(backDb.getByRole('button', { name: 'Filters: 1' })).toBeVisible();
    expect(nowErrors).toEqual([]);
    await again.close();
    await api.dispose();
  });

test('the v0.9.0 build shows a third-party plugin block as a placeholder, sends nothing of it, and the server keeps its bytes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const OLD = await serve('v0.9.0');
  const account = await newAccount('Plugins and v0.9.0');
  const api = await apiSession(account);

  // This build: a page with text and a third-party plugin block (the reference plugin installed
  // first). The build Playwright previews is made with VITE_CGW_PLUGINS, so the slash menu lists it.
  const current = await browser.newContext();
  const now = await current.newPage();
  const nowErrors = watchAppErrors(now);
  await now.goto('/');
  await signIn(now, account);
  await signedIn(now, account);
  await now.getByLabel('Workspace name').fill('Plugins v0.9.0');
  await now.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(now)).toBeVisible();
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === 'Plugins v0.9.0')!.id;

  // Install the reference plugin in Settings.
  await now.goto('/#/settings');
  const section = now.getByTestId('plugins-settings');
  await expect(section).toBeVisible({ timeout: 30000 });
  const chooser = now.waitForEvent('filechooser');
  await section.getByTestId('plugins-add').click();
  await (await chooser).setFiles(PLUGIN_BUNDLE);
  await expect(now.getByTestId('plugins-review')).toBeVisible({ timeout: 30000 });
  await now.getByTestId('plugins-confirm').click();
  await expect(section.getByTestId('plugins-list')).toContainText('Notes', { timeout: 30000 });

  await newPage(now, 'A third-party plugin');
  await now.keyboard.type('Written by version ten');
  await now.keyboard.press('Enter');
  await now.keyboard.type('/Notes');
  await expect(now.getByRole('option', { name: 'Notes', exact: true })).toBeVisible();
  await now.keyboard.press('Enter');
  await expect(editor(now).locator('[data-body="pluginBlock"]')).toHaveCount(1);
  await waitSaved(now);
  const pageId = pageIdOf(now);
  await expect(syncStatus(now)).toHaveText('Synced', { timeout: 30000 });
  await expect
    .poll(async () => (await pageRecord(api, workspaceId, pageId))?.docSchemaVersion, {
      timeout: 60000,
    })
    .toBe(CURRENT);
  const before = await serverState(api, pageId);
  await current.close();

  // v0.9.0, the same person on its own copy: the block is the editor's own placeholder, the page
  // is not read-only (the schema is the same), nothing of the block is sent.
  const oldContext = await browser.newContext({ baseURL: OLD });
  const old = await oldContext.newPage();
  const oldErrors: string[] = [];
  old.on('pageerror', (error) => oldErrors.push(error.message));
  const pushes: string[] = [];
  old.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'POST') return;
    if (/\/doc\/(updates|repair)$/.test(url)) pushes.push(url);
    if (/\/ops$/.test(url))
      for (const op of (request.postDataJSON()?.ops ?? []) as { type: string }[])
        if (op.type !== 'visit.record') pushes.push(`${op.type} ${url}`);
  });
  await old.goto(`${OLD}/`);
  await signIn(old, account, `${OLD}/`);
  await signedIn(old, account);
  await expect(syncStatus(old)).toHaveText('Synced', { timeout: 30000 });
  await old
    .getByRole('tree', { name: 'Pages' })
    .getByRole('treeitem', { name: /A third-party plugin/ })
    .click({ timeout: 30000 });
  await expect(editor(old)).toContainText('Written by version ten', { timeout: 20000 });
  // The block names the type it does not know; no frame is drawn there.
  await expect(
    editor(old).getByText(
      'This block needs a newer version of Cash Gear Workspace (vendor.notes).',
    ),
  ).toBeVisible({ timeout: 20000 });
  await expect(editor(old).locator('[data-body="pluginBlock"] iframe')).toHaveCount(0);
  // The page is the same schema, so it is not read-only there (no "newer version" banner).
  await expect(old.getByText(NEWER)).toHaveCount(0);
  await old.waitForTimeout(5000);
  expect(pushes, 'what the old build sent').toEqual([]);
  expect(await serverState(api, pageId)).toEqual(before);
  expect(oldErrors).toEqual([]);
  expect(nowErrors).toEqual([]);
  await oldContext.close();

  // This build again: the block's frame is drawn, with its props exactly as written.
  const again = await browser.newContext();
  const back = await again.newPage();
  const backErrors = watchAppErrors(back);
  await back.goto('/');
  await signIn(back, account);
  await signedIn(back, account);
  await back
    .getByRole('tree', { name: 'Pages' })
    .getByRole('treeitem', { name: /A third-party plugin/ })
    .click();
  await expect(back.locator('[data-body="pluginBlock"] iframe')).toHaveCount(1, { timeout: 30000 });
  expect(backErrors).toEqual([]);
  await again.close();
  await api.dispose();
});
