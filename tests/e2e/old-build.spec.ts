// The old builds against what this build writes: an older desktop app meeting newer documents
// and data must show them read-only, push nothing, and leave the server's bytes as they were. The
// old builds are the web builds of the releases (scripts/old-build.mjs, in target/old-build/<tag>,
// served on 127.0.0.1:4279 for v0.2.0 and :4278 for v0.3.0), each running the same document code
// as that release's desktop app (the app embeds that very build). Both builds talk to the e2e
// server stack as the same person.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { oldBuild, originOf, serveOldBuild } from '../../scripts/old-build.mjs';
import { chooseOptions, fullPage, newDatabase, openRow, showView } from './database';
import {
  ERP_API,
  ERP_CLIENT,
  MOCK_SHEET,
  SHEET_ORIGIN,
  erpBlock,
  expectLive,
  insertErpBlock,
  insertExistingWorkbook,
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
