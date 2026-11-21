// Phase 13 (M13.1, M13.2): a plugin's network, and plugins in the change feed, against the e2e
// stack. As plugins-frame.spec.ts: the frames come from the Sites process's plugins host
// (localhost:5291), so the preview must be a web build made with VITE_CGW_PLUGINS=http://localhost:5291.
// The plugin's host is tests/mocks/net (localhost:4288; 127.0.0.1:4288 is another host to the CSP),
// which records every request that reaches it.
//
// What is proven:
//   - a plugin reaches the hosts an admin approved and no other: adding it shows its hosts, with
//     its rows, and allows them; the rows' titles reach the approved host, a host it does not name
//     and a host it names but no one approved never see a request;
//   - a new host in an update waits for approval (the update dialog says so, the row lists it
//     waiting), then is reached once allowed; stopping its network stops every host;
//   - an added, updated, switched or removed plugin reaches a member's open tab without a reload.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { expect, test, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { newDatabase, newRow } from './database';
import { watchAppErrors } from './ecosystem';
import { team } from './collab';
import { writePluginBundles } from '../fixtures/plugins/make.mjs';

test.skip(desktop, 'The plugins origin is framed by the web build (CSP); run in a browser');

// The refusals that prove the isolation holds are logged by the browser, not by the app.
const ALLOW = [
  /Content Security Policy|Refused to (connect|frame|navigate)|example\.com|127\.0\.0\.1:4288/,
  /SecurityError|sandboxed|Blocked|ERR_|net::/,
  /Failed to load resource|Failed to fetch/,
];

const NET = 'http://127.0.0.1:4288';
const bundles = writePluginBundles(mkdtempSync(`${tmpdir()}/cgw-plugin-network-`));

type Seen = { method: string; host: string; path: string; body: string };

const seen = async (): Promise<Seen[]> =>
  ((await (await fetch(`${NET}/__mock/requests`)).json()) as { requests: Seen[] }).requests.filter(
    (r) => r.path.startsWith('/echo'),
  );

const pluginBlock = (page: Page) => editor(page).locator('[data-body="pluginBlock"]');
const frameOf = (page: Page) => page.frameLocator('[data-body="pluginBlock"] iframe');
const settings = (page: Page) => page.getByTestId('plugins-settings');
const rowOf = (page: Page, type: string) => settings(page).locator(`tr[data-plugin="${type}"]`);

/** Settings → Plugins → Add (or a row's Update), up to the review dialog; returns it. */
async function review(page: Page, path: string, updateOf?: string) {
  await page.goto('/#/settings');
  await expect(settings(page)).toBeVisible({ timeout: 30000 });
  const chooser = page.waitForEvent('filechooser');
  if (updateOf)
    await settings(page)
      .getByRole('button', { name: `Update ${updateOf}` })
      .click();
  else await settings(page).getByTestId('plugins-add').click();
  await (await chooser).setFiles(path);
  const dialog = page.getByTestId('plugins-review');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  return dialog;
}

/** What the frame recorded of each target, once it has tried them all. */
async function attempts(page: Page) {
  const frame = frameOf(page);
  await expect(frame.locator('#summary')).toHaveAttribute('data-done', 'true', { timeout: 30000 });
  const out: Record<string, string> = {};
  for (const li of await frame.locator('#attempts li').all())
    out[(await li.getAttribute('data-attempt'))!] = (await li.getAttribute('data-outcome'))!;
  return out;
}

async function signedInWorkspace(page: Page, name: string, space: string) {
  const account = await newAccount(name);
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill(space);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return account;
}

test('a plugin reaches the hosts an admin approved and no other; a new host in an update waits for approval', async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = watchAppErrors(page, ALLOW);
  await fetch(`${NET}/__mock/reset`, { method: 'POST' });
  await signedInWorkspace(page, 'Network owner', 'Network space');

  // Adding it shows its host, and with its rows says both are allowed together.
  const add = await review(page, bundles.network);
  await expect(add.getByTestId('plugin-hosts')).toHaveText('localhost:4288');
  await expect(add).toContainText(
    'It is shown the rows of the database view a block names, as each reader may read them, and it can send them to these hosts. Adding it allows both.',
  );
  await page.getByTestId('plugins-confirm').click();
  await expect(rowOf(page, 'vendor.ping')).toContainText('Connects to: localhost:4288', {
    timeout: 30000,
  });
  await expect(rowOf(page, 'vendor.ping').locator('[data-hosts="waiting"]')).toHaveCount(0);

  // A block granted a view: its rows' titles go to the approved host, and nowhere else.
  await newDatabase(page, 'Empty database', { title: 'Tasks' });
  await newRow(page, 'Quarterly close');
  await newPage(page, 'A page that pings');
  await page.keyboard.type('/Ping');
  await expect(page.getByRole('option', { name: 'Ping', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pluginBlock(page)).toHaveCount(1);
  await pluginBlock(page).getByRole('button', { name: 'Choose a database' }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option', { name: /Tasks/ }).first().click();
  await expect(pick).toHaveCount(0);
  await expect
    .poll(async () => (await attempts(page)).approved, { timeout: 30000 })
    .toBe('reached');
  expect(await attempts(page)).toEqual({
    approved: 'reached',
    other: 'blocked',
    unnamed: 'blocked',
  });
  await waitSaved(page);
  const sent = await seen();
  expect(sent.length).toBeGreaterThan(0);
  expect(new Set(sent.map((r) => r.host))).toEqual(new Set(['localhost:4288']));
  expect(sent.some((r) => r.body.includes('Quarterly close'))).toBe(true);

  // An update naming a new host: the dialog marks it new and says it waits; the row lists it
  // waiting; the open page draws the new version, which still cannot reach it.
  const pageUrl = page.url();
  const update = await review(page, bundles.networkV2, 'Ping');
  await expect(update.getByTestId('plugin-hosts')).toContainText('127.0.0.1:4288 (new)');
  await expect(update).toContainText(
    'This version also asks to connect to the hosts marked new. They wait until you allow them in its row.',
  );
  await page.getByTestId('plugins-confirm').click();
  const row = rowOf(page, 'vendor.ping');
  await expect(row.locator('[data-hosts="waiting"]')).toHaveText(
    'Waiting for approval: 127.0.0.1:4288',
    { timeout: 30000 },
  );
  await expect(row.locator('[data-hosts="approved"]')).toHaveText('Connects to: localhost:4288');
  await page.goto(pageUrl);
  await expect(frameOf(page).locator('#summary')).toHaveAttribute('data-done', 'true', {
    timeout: 30000,
  });
  expect(await attempts(page)).toEqual({
    approved: 'reached',
    other: 'blocked',
    unnamed: 'blocked',
  });
  expect((await seen()).every((r) => r.host === 'localhost:4288')).toBe(true);

  // Allowed in its row (rows and network named together): now it reaches both, never example.com.
  await page.goto('/#/settings');
  await rowOf(page, 'vendor.ping').getByTestId('plugin-allow').click();
  const allow = page.getByRole('alertdialog', { name: 'Allow Ping to connect' });
  await expect(allow).toContainText(
    'Ping is shown the rows of the database view a block names, and will be able to send them to these hosts:',
  );
  await allow.getByTestId('plugin-allow-confirm').click();
  await expect(rowOf(page, 'vendor.ping').locator('[data-hosts="approved"]')).toHaveText(
    'Connects to: localhost:4288, 127.0.0.1:4288',
    { timeout: 30000 },
  );
  await page.goto(pageUrl);
  await expect.poll(async () => (await attempts(page)).other, { timeout: 30000 }).toBe('reached');
  expect(await attempts(page)).toEqual({
    approved: 'reached',
    other: 'reached',
    unnamed: 'blocked',
  });
  expect((await seen()).some((r) => r.host === '127.0.0.1:4288')).toBe(true);

  // Its network stopped: neither host is reached any more.
  await page.goto('/#/settings');
  await rowOf(page, 'vendor.ping').getByTestId('plugin-stop-network').click();
  await expect(rowOf(page, 'vendor.ping').locator('[data-hosts="waiting"]')).toHaveText(
    'Waiting for approval: localhost:4288, 127.0.0.1:4288',
    { timeout: 30000 },
  );
  const before = (await seen()).length;
  await page.goto(pageUrl);
  await expect
    .poll(async () => (await attempts(page)).approved, { timeout: 30000 })
    .toBe('blocked');
  expect(await attempts(page)).toEqual({
    approved: 'blocked',
    other: 'blocked',
    unnamed: 'blocked',
  });
  expect((await seen()).length).toBe(before);
  expect(errors).toEqual([]);
});

test('an added, updated, switched or removed plugin reaches a member’s open tab without a reload', async ({
  page,
  browser,
}) => {
  test.setTimeout(300000);
  const t = await team(page, browser, ['Plugins feed owner', 'Plugins feed member'], {
    workspace: 'Feed space',
    allowed: ALLOW,
  });
  const owner = t.owner.page;
  const member = t.members[0]!.page;
  try {
    // A page holding the reference plugin's block, open in the member's tab.
    const add = await review(owner, bundles.reference);
    await owner.getByTestId('plugins-confirm').click();
    await expect(rowOf(owner, 'vendor.notes')).toBeVisible({ timeout: 30000 });
    await newPage(owner, 'A plugin for everyone');
    await owner.keyboard.type('/Notes');
    await expect(owner.getByRole('option', { name: 'Notes', exact: true })).toBeVisible();
    await owner.keyboard.press('Enter');
    await expect(frameOf(owner).locator('#status')).toHaveText('Ready', { timeout: 30000 });
    await waitSaved(owner);
    await expect(syncStatus(owner)).toHaveText('Synced', { timeout: 30000 });
    const pageUrl = owner.url().replace(/^https?:\/\/[^/]+/, '');
    await member.goto(pageUrl);
    await expect(frameOf(member).locator('#status')).toHaveText('Ready', { timeout: 30000 });
    // From here the member's tab is never reloaded: a mark on its window would go with a reload.
    await member.evaluate(() => ((window as unknown as { cgwMark: number }).cgwMark = 13));
    const stateOf = async () =>
      JSON.parse((await frameOf(member).locator('#state').textContent()) ?? '{}') as {
        plugin?: { version: number };
      };

    // Turned off: the member's block says so.
    await owner.goto('/#/settings');
    await settings(owner).getByRole('button', { name: 'Turn off Notes' }).click();
    await expect(pluginBlock(member)).toContainText('Notes is turned off in this workspace.', {
      timeout: 30000,
    });
    // Turned on: drawn again.
    await settings(owner).getByRole('button', { name: 'Turn on Notes' }).click();
    await expect(frameOf(member).locator('#status')).toHaveText('Ready', { timeout: 30000 });
    // Updated: the member's frame is the new version's.
    await review(owner, bundles.referenceV2, 'Notes');
    await owner.getByTestId('plugins-confirm').click();
    await expect.poll(async () => (await stateOf()).plugin?.version, { timeout: 30000 }).toBe(2);
    // Removed: the block says the plugin isn't installed.
    await owner.goto('/#/settings');
    await settings(owner).getByRole('button', { name: 'Remove Notes' }).click();
    await owner.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(pluginBlock(member)).toContainText(
      'The plugin vendor.notes isn’t installed in this workspace.',
      { timeout: 30000 },
    );
    // Added again: drawn in its frame.
    await review(owner, bundles.referenceV2);
    await owner.getByTestId('plugins-confirm').click();
    await expect(frameOf(member).locator('#status')).toHaveText('Ready', { timeout: 30000 });
    expect(await member.evaluate(() => (window as unknown as { cgwMark?: number }).cgwMark)).toBe(
      13,
    );
    void add;
    for (const person of [t.owner, ...t.members]) expect(person.errors).toEqual([]);
  } finally {
    await t.close();
  }
});
