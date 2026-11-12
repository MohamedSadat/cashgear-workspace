// Phase 3's acceptance criterion "an old desktop build against a migrated document: read-only,
// nothing pushed, the server's bytes unchanged". The old build is the web build of v0.2.0
// (scripts/old-build.mjs, in target/old-build, served on 127.0.0.1:4279), which runs the same
// document code as the v0.2.0 desktop app (that app embeds this very build): schema version 1, its
// gate (D7) and its sync engine. Both builds talk to the e2e server stack as the same person.
//
// The page is made by the old build at version 1; this build opens it, which migrates it to
// version 2 (an ordinary edit, pushed; the worker raises the page). The old build, started again
// on its own copy, pulls that and must then show the page read-only, write nothing when typed
// into, and send no update; the server's state of the page (state hash and the updates' bytes)
// is the same before and after. A second page, made by this build at version 2 and never held by
// the old build, is opened there too: v0.2.0 decides read-only when it opens a page, from what it
// holds, so a page it never held opens editable until opened again (an annotation says which); a
// third such page is typed into at that first open, to show what then happens (426, nothing
// stored on the server).
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { OLD_ORIGIN, oldBuild, serveOldBuild } from '../../scripts/old-build.mjs';

test.skip(desktop, 'The old build is the v0.2.0 web build, in a browser');
test.skip(!oldBuild(), 'No old build: run node scripts/old-build.mjs first');

let server: { kill(): void } | null = null;
test.beforeAll(async () => {
  server = await serveOldBuild();
});
test.afterAll(() => server?.kill());

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
    .toBe(2);
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
      .toBe(2);
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
  expect((await pageRecord(api, workspaceId, migratedId)).docSchemaVersion).toBe(2);
  await oldContext.close();
  await api.dispose();
});
