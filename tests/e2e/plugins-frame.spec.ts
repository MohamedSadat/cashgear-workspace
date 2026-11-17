// Phase 10 (M10.4, M10.5): third-party plugins on the client, against the e2e stack. The frames
// are served by the Sites process's second host (localhost:5291), so the preview Playwright starts
// must be a web build made with VITE_CGW_PLUGINS=http://localhost:5291 (tests/e2e/README.md); the
// server stack binds that host (scripts/server-stack.mjs). The reference and hostile plugins are
// the bundles in tests/fixtures/plugins, zipped by make.mjs.
//
// What is proven:
//   - an owner adds the reference plugin in Settings (its manifest shown first), sees it listed,
//     and a plugin block drawn in its frame with only what it was given (its props, the theme,
//     direction and language), raising its own count through the contract;
//   - a plugin granted a view is shown the view's rows, never a person's values;
//   - the hostile plugin reaches nothing: every attempt is recorded blocked inside the frame, no
//     request leaves it, and the page, the session and storage are untouched;
//   - a block whose plugin is missing, turned off, or newer than the installed one draws a
//     placeholder and the document keeps its type, version and props exactly;
//   - a page holding a plugin opens unchanged in a workspace that does not have it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { newDatabase } from './database';
import { watchAppErrors } from './ecosystem';
import { writePluginBundles } from '../fixtures/plugins/make.mjs';

test.skip(desktop, 'The plugins origin is framed by the web build (CSP); run in a browser');

// A plugin's sandboxed frame makes the browser log the refusals that prove the isolation holds
// (the CSP's blocked network, a refused navigation or pop-up, a sandboxed frame's storage): those
// are the point, not app errors.
const ALLOW = [
  /Content Security Policy|Refused to (connect|frame|navigate)|example\.com|\/steal/,
  /SecurityError|sandboxed|Blocked|ERR_|net::/,
  /Failed to load resource/,
];

const bundles = writePluginBundles(mkdtempSync(`${tmpdir()}/cgw-plugin-fixtures-`));

type Api = Awaited<ReturnType<typeof apiSession>>;

const pluginBlock = (page: import('@playwright/test').Page) =>
  editor(page).locator('[data-body="pluginBlock"]');
const frameOf = (page: import('@playwright/test').Page) =>
  page.frameLocator('[data-body="pluginBlock"] iframe');

/** Settings → Plugins → Add, with the bundle at `path`; waits for the list to hold `name`. */
async function addPlugin(page: import('@playwright/test').Page, path: string, name: string) {
  await page.goto('/#/settings');
  const section = page.getByTestId('plugins-settings');
  await expect(section).toBeVisible({ timeout: 30000 });
  const chooser = page.waitForEvent('filechooser');
  await section.getByTestId('plugins-add').click();
  await (await chooser).setFiles(path);
  await expect(page.getByTestId('plugins-review')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('plugins-confirm').click();
  await expect(section.getByTestId('plugins-list')).toContainText(name, { timeout: 30000 });
}

/** Inserts a plugin block by its name in the slash menu; waits for its body. */
async function insertPlugin(page: import('@playwright/test').Page, name: string) {
  await page.keyboard.type(`/${name}`);
  await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pluginBlock(page)).toHaveCount(1);
}

/** The server's derived JSON of a page, once the worker has it: for "unchanged" checks. */
async function docJson(api: Api, pageId: string): Promise<string> {
  let json = '';
  await expect
    .poll(
      async () => {
        const { status, body } = await api.raw(`/api/v1/pages/${pageId}/doc/json`);
        if (status !== 200) return false;
        json = (JSON.parse(body) as { json: string }).json;
        return true;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  return json;
}

const pageIdOf = (page: import('@playwright/test').Page) =>
  new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];

test('an owner adds the reference plugin, and a block draws in its frame with only what it was given', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = watchAppErrors(page, ALLOW);
  const account = await newAccount('Plugins owner');
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill('Plugins space');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  await addPlugin(page, bundles.reference, 'Notes');

  await newPage(page, 'A page with a plugin');
  await insertPlugin(page, 'Notes');
  const frame = frameOf(page);
  await expect(frame.locator('#status')).toHaveText('Ready', { timeout: 30000 });
  const state = JSON.parse((await frame.locator('#state').textContent()) ?? '{}');
  // It was told the plugin, the block (editable, not newer), its props, the theme, direction and
  // language, and nothing else.
  expect(state.inited).toBe(true);
  expect(state.plugin).toEqual({ type: 'vendor.notes', version: 1 });
  expect(state.block).toEqual({ version: 1, editable: true, newer: false });
  expect(state.direction).toBe('ltr');
  expect(state.language).toBe('en');
  expect(['light', 'dark']).toContain(state.theme);
  expect(state.foreign).toBe(0);

  // Its own write (raising a count) is written as the block's props, and survives a reload.
  await frame.getByRole('button', { name: 'Add one' }).click();
  await frame.getByRole('button', { name: 'Add one' }).click();
  await expect(frame.locator('#count')).toHaveText('2');
  await waitSaved(page);
  const pageId = pageIdOf(page);
  await expect
    .poll(async () => (await docJson(await apiSession(account), pageId)).includes('"count":2'), {
      timeout: 30000,
    })
    .toBe(true);
  await page.reload();
  await expect(frameOf(page).locator('#count')).toHaveText('2', { timeout: 30000 });
  expect(errors).toEqual([]);
});

test('a plugin granted a view is shown its rows, never a person’s values', async ({ page }) => {
  test.setTimeout(180000);
  const errors = watchAppErrors(page, ALLOW);
  const account = await newAccount('Plugins rows');
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill('Rows space');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await addPlugin(page, bundles.reference, 'Notes');

  await newDatabase(page, 'Tasks', { title: 'Tasks' });
  await newPage(page, 'Rows page');
  await insertPlugin(page, 'Notes');
  // The plugin asks for a view (reads.rows): choose the Tasks database.
  await pluginBlock(page).getByRole('button', { name: 'Choose a database' }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option', { name: /Tasks/ }).first().click();
  await expect(pick).toHaveCount(0);
  const frame = frameOf(page);
  await expect(frame.locator('#rows')).toBeVisible({ timeout: 30000 });
  const state = JSON.parse((await frame.locator('#state').textContent()) ?? '{}');
  expect(state.rows.databaseId).toBeTruthy();
  for (const property of state.rows.properties)
    expect(['person', 'createdBy', 'lastEditedBy']).not.toContain(property.type);
  // No person id leaves in any value.
  expect(JSON.stringify(state.rows.values)).not.toMatch(/0000000000p[0-9]/);
  expect(errors).toEqual([]);
});

test('the hostile plugin reaches nothing: every attempt blocked, no request leaves the frame', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = watchAppErrors(page, ALLOW);
  // Any request to example.com (or anywhere off the app's own hosts) would be the plugin escaping.
  const escaped: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/example\.com|\/steal/.test(url)) escaped.push(url);
  });
  const account = await newAccount('Hostile owner');
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill('Hostile space');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await addPlugin(page, bundles.hostile, 'Prober');

  await newPage(page, 'A hostile plugin');
  await insertPlugin(page, 'Prober');
  const frame = frameOf(page);
  await expect(frame.locator('#summary')).toHaveText('Blocked everything', { timeout: 30000 });
  await expect(frame.locator('#summary')).toHaveAttribute('data-reached', '0');
  // Each attempt recorded blocked.
  const attempts = frame.locator('#attempts li');
  await expect(attempts).not.toHaveCount(0);
  const reached = await frame.locator('#attempts li[data-outcome="reached"]').count();
  expect(reached).toBe(0);
  // It never reached the page: its own messages to the parent changed nothing, and the page is
  // still the app (not navigated away).
  await page.waitForTimeout(2000);
  expect(escaped, escaped.join('\n')).toEqual([]);
  expect(new URL(page.url()).host).toBe('127.0.0.1:4273');
  expect(await pluginBlock(page).count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a missing, a turned-off and a newer plugin draw a placeholder, and the document keeps the block', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page, ALLOW);
  const account = await newAccount('Plugins states');
  const api = await apiSession(account);
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill('States space');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // A block written at version 2 (the reference plugin's v2 bundle), then the plugin made v1: the
  // block is newer than what is installed, and is drawn read-only.
  await addPlugin(page, bundles.referenceV2, 'Notes');
  await newPage(page, 'A plugin page');
  await insertPlugin(page, 'Notes');
  await expect(frameOf(page).locator('#status')).toHaveText('Ready', { timeout: 30000 });
  await waitSaved(page);
  const pageId = pageIdOf(page);
  const before = await docJson(api, pageId);
  expect(before).toContain('vendor.notes');

  // Turned off: the block says so, and the document is unchanged.
  await page.goto('/#/settings');
  await page
    .getByTestId('plugins-settings')
    .getByRole('button', { name: 'Turn off Notes' })
    .click();
  await expect(page.getByTestId('plugin-state')).toHaveText('Off', { timeout: 30000 });
  await page.goto(`/#/p/${pageId}`);
  await expect(pluginBlock(page)).toContainText('Notes is turned off in this workspace.', {
    timeout: 30000,
  });
  await expect(frameOf(page).locator('#status')).toHaveCount(0);

  // Removed: the block says the plugin isn't installed.
  await page.goto('/#/settings');
  await page.getByTestId('plugins-settings').getByRole('button', { name: 'Remove Notes' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('plugins-none')).toBeVisible({ timeout: 30000 });
  await page.goto(`/#/p/${pageId}`);
  await expect(pluginBlock(page)).toContainText(
    'The plugin vendor.notes isn’t installed in this workspace.',
    { timeout: 30000 },
  );

  // Newer: add the plugin again at version 1 (a fresh type now there is no live row); the block,
  // written at 2, is drawn read-only.
  await addPlugin(page, bundles.reference, 'Notes');
  await page.goto(`/#/p/${pageId}`);
  await expect(frameOf(page).locator('#status')).toHaveText('Read only', { timeout: 30000 });
  const newerState = JSON.parse((await frameOf(page).locator('#state').textContent()) ?? '{}');
  expect(newerState.block).toEqual({ version: 2, editable: false, newer: true });

  // Through all of it the document kept the block's type, version and props exactly: a page
  // holding a plugin block opens unchanged where the plugin is not there (the removed case above),
  // and in the v0.9.0 build (old-build.spec.ts).
  await waitSaved(page).catch(() => {});
  expect(await docJson(api, pageId)).toBe(before);
  await api.dispose();
  expect(errors).toEqual([]);
});
