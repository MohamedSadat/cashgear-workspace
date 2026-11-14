// Phase 5's Cash Gear Sheet criteria (IMPLEMENTATION_PLAN.md, Phase 5) against the server stack
// and the mock Sheet (tests/mocks/sheet; Sheet's preview with CGW_E2E_REAL_SHEET, README.md), in
// Chrome and Edge, and on the built desktop app where the criterion is the device's:
//   - a workbook inserted (new), opened in Sheet from its launch link, saved there, and the block
//     showing the new version after Refresh: live (the embed drawing it) with its picture sent;
//   - an existing workbook picked, its view changed, and drawn in Arabic and dark;
//   - a range imported into a database, and a view exported to a workbook and opened;
//   - a reader without access to the workbook, and a share link, see no picture and no frame;
//   - offline, the stored picture with its date, again after a reload while offline.
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { fullPage, network, pageId, signedInWorkspace, signers, signOutDesktop } from './database';
import {
  REAL_SHEET,
  SHEET_ORIGIN,
  blockAttrs,
  budgetBook,
  expectLive,
  insertExistingWorkbook,
  insertNewWorkbook,
  invite,
  liveFrame,
  mockSheet,
  newWorkbook,
  pictureSent,
  saveVersion,
  sessionOf,
  sheetBlock,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});
test.beforeEach(async () => {
  if (!REAL_SHEET) await mockSheet.reset();
});

const NO_ACCESS = "You don't have access to this workbook";
/** The browser's own lines for requests refused while the network is off. */
const appErrors = (errors: string[]) =>
  errors.filter(
    (e) =>
      !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(
        e,
      ),
  );

/** The block's own menu (⋯) and one of its items. */
async function blockMenu(page: Page, item: string) {
  await sheetBlock(page).getByRole('button', { name: 'Workbook options' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('a new workbook is opened in Sheet, saved there, and shown live after Refresh with its picture sent', async ({
  page,
}) => {
  test.skip(desktop, 'The desktop opens Sheet in the system browser: the browser runs this one');
  const context = page.context();
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const account = await newAccount('Sheet maker');
  await signedInWorkspace(page, account, 'Sheet space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    await newPage(page, 'Budget page');
    await page.keyboard.type('Before the workbook.');
    await page.keyboard.press('Enter');
    const workbookId = await insertNewWorkbook(page, 'Budget 2027');
    const block = sheetBlock(page);
    await expect(block).toHaveAttribute('data-state', 'empty', { timeout: 30000 });
    await expect(block.locator('.cgw-sheet-name')).toHaveText('Budget 2027');
    await expect(block).toContainText('Empty workbook');
    await expect(block).toContainText(
      'This workbook is empty. Open it in Cash Gear Sheet; its first save shows here.',
    );
    expect(await blockAttrs(page, 'sheetEmbed')).toEqual([
      expect.objectContaining({ workbookId, sheet: null, range: null }),
    ]);
    await waitSaved(page);

    // "Open in Cash Gear Sheet": a launch link on the build's Sheet origin, in a new tab, whose
    // ticket leaves the address at once.
    const launched = page.waitForResponse((r) =>
      r.url().endsWith(`/workbooks/${workbookId}/launch`),
    );
    const opened = context.waitForEvent('page');
    await block.getByRole('button', { name: 'Open in Cash Gear Sheet' }).click();
    const launch = await launched;
    expect(launch.status()).toBe(200);
    const { url } = (await launch.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${SHEET_ORIGIN}/cloud#launch=[A-Za-z0-9_-]{43}$`));
    const sheet = await opened;
    await sheet.waitForLoadState('domcontentloaded');
    expect(new URL(sheet.url()).origin).toBe(SHEET_ORIGIN);
    await expect.poll(() => sheet.url()).not.toContain(url.split('#launch=')[1]);
    if (REAL_SHEET) {
      // Sheet's own editor and its save are Sheet's suite's: the save goes through
      // sheet-session.1 as Sheet's does.
      await saveVersion(
        api,
        workbookId,
        workbookOf([
          ['Item', 'Quantity'],
          ['Saved by the test', 1],
        ]),
      );
    } else {
      await expect(sheet.locator('#status')).toHaveAttribute('data-state', 'ready');
      await expect(sheet.locator('#name')).toHaveText('Budget 2027');
      await expect(sheet.locator('#access')).toHaveText('edit');
      await expect(sheet.locator('#etag')).toHaveText('(none)');
      await sheet.locator('#save').click();
      await expect(sheet.locator('#status')).toHaveAttribute('data-state', 'saved');
    }
    const first = (await api.get(`/api/v1/workbooks/${workbookId}`)) as { etag: string };
    expect(first.etag).toMatch(/^"[0-9a-f-]{36}"$/);

    // Back on the page: Refresh shows the new version live, and an editor sends its picture.
    await page.bringToFront();
    const picture = pictureSent(page, workbookId);
    await blockMenu(page, 'Refresh');
    await expectLive(block, REAL_SHEET ? undefined : 'Saved by the mock');
    await expect(block.locator('.cgw-sheet-saved')).toContainText(`by ${account.name}`);
    const frame = block.locator('.cgw-sheet-live iframe');
    await expect(frame).toHaveAttribute('src', `${SHEET_ORIGIN}/embed`);
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const sent = await picture;
    expect(sent.status()).toBe(204);
    expect(sent.request().headers()['content-type']).toBe('image/png');
    const hash = new URL(sent.url()).pathname.split('/').pop()!;
    const stored = (await api.get(`/api/v1/workbooks/${workbookId}/previews/${hash}`)) as {
      etag: string;
      width: number;
    };
    expect(stored.etag).toBe(first.etag);
    expect(stored.width).toBeGreaterThan(0);

    // Saved again in Sheet: the block's Refresh shows that version, and its picture follows.
    if (REAL_SHEET)
      await saveVersion(
        api,
        workbookId,
        workbookOf([
          ['Item', 'Quantity'],
          ['Saved by the test', 2],
        ]),
      );
    else {
      await sheet.bringToFront();
      await sheet.locator('#save').click();
      await expect(sheet.locator('#status')).toHaveAttribute('data-state', 'saved');
      await expect(sheet.locator('#etag')).not.toHaveText(first.etag);
    }
    const second = (await api.get(`/api/v1/workbooks/${workbookId}`)) as { etag: string };
    expect(second.etag).not.toBe(first.etag);
    await page.bringToFront();
    const again = pictureSent(page, workbookId);
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    if (!REAL_SHEET)
      await expect(liveFrame(block).locator('td.number', { hasText: /^2$/ })).toBeVisible({
        timeout: 30000,
      });
    await expectLive(block);
    expect((await again).status()).toBe(204);
    const newest = (await api.get(`/api/v1/workbooks/${workbookId}/previews/${hash}`)) as {
      etag: string;
    };
    expect(newest.etag).toBe(second.etag);
    await sheet.close();
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('an existing workbook is picked and its view changed, and Arabic and dark draw it right to left and dark', async ({
  page,
}) => {
  test.skip(desktop, 'Drawn the same by the desktop app: the browser runs this one');
  test.setTimeout(180000);
  const errors = watchAppErrors(page);
  const account = await newAccount('Picker');
  await signedInWorkspace(page, account, 'Picker space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Picker space');
    await newWorkbook(api, workspaceId, 'Quarterly budget', budgetBook());
    await newWorkbook(api, workspaceId, 'Staff list', workbookOf([['Name'], ['Ada']]));
    await newPage(page, 'Picked');
    await insertExistingWorkbook(page, 'Quarterly');
    const block = sheetBlock(page);
    await expectLive(block, 'Rent');
    await expect(block.locator('.cgw-sheet-name')).toHaveText('Quarterly budget');

    // The view picker: the visible sheets (not the hidden one), a range checked against the
    // limit, a height; the same embed draws the new view (one frame, one `init`).
    await blockMenu(page, 'Change the view');
    const picker = block.getByRole('form', { name: 'What the block shows' });
    await expect(picker.getByLabel('Sheet').locator('option')).toHaveText([
      'The first sheet',
      'Budget',
      'الميزانية',
    ]);
    await picker.getByLabel('Range').fill('a1:z999');
    await picker.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(picker.getByRole('alert')).toHaveText(
      'A range shown here holds at most 5,000 cells.',
    );
    await picker.getByLabel('Range').fill('b2:a1');
    await picker.getByLabel('Most height (pixels)').fill('200');
    await picker.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(picker).toHaveCount(0);
    if (!REAL_SHEET) {
      await expect.poll(() => liveFrame(block).locator('td').count()).toBe(4);
      await expect(liveFrame(block).locator('td').first()).toHaveText('Item');
    }
    await expectLive(block);
    expect(await blockAttrs(page, 'sheetEmbed')).toEqual([
      expect.objectContaining({ sheet: null, range: 'B2:A1', height: 200 }),
    ]);
    // The Arabic sheet, whole: drawn right to left.
    await blockMenu(page, 'Change the view');
    await picker.getByLabel('Sheet').selectOption('الميزانية');
    await picker.getByLabel('Range').fill('');
    await picker.getByRole('button', { name: 'Show', exact: true }).click();
    if (!REAL_SHEET) {
      await expect(liveFrame(block).locator('table')).toHaveAttribute('dir', 'rtl');
      await expect(liveFrame(block).locator('td', { hasText: 'الإيجار' })).toBeVisible();
      const events = (await mockSheet.state()).events;
      expect(events.filter((e) => e.kind === 'init')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'received:setView').length).toBeGreaterThanOrEqual(2);
    }
    await waitSaved(page);

    // Arabic and dark: the block's words and direction, and the embed told both.
    await page.evaluate(() => {
      localStorage.setItem('cgw-language', 'ar');
      localStorage.setItem('cgw-theme', 'dark');
    });
    if (!REAL_SHEET) await mockSheet.reset();
    await page.reload();
    const arabic = sheetBlock(page);
    await expectLive(arabic);
    await expect(arabic.getByRole('button', { name: 'فتح في Cash Gear Sheet' })).toBeVisible();
    await expect(arabic.getByRole('button', { name: 'تحديث', exact: true })).toBeVisible();
    expect(await arabic.evaluate((el) => el.closest('[dir]')?.getAttribute('dir'))).toBe('rtl');
    if (!REAL_SHEET) {
      const root = liveFrame(arabic).locator('html');
      await expect(root).toHaveAttribute('data-theme', 'dark');
      await expect(root).toHaveAttribute('dir', 'rtl');
      await expect(root).toHaveAttribute('lang', 'ar');
      const init = (await mockSheet.state()).events.find((e) => e.kind === 'init')!;
      expect(init).toMatchObject({ theme: 'dark', direction: 'rtl', locale: 'ar' });
    }
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('a range is imported into a database, and a view is exported to a workbook and opened in Sheet', async ({
  page,
}) => {
  test.skip(desktop, 'The desktop opens Sheet in the system browser: the browser runs this one');
  const context = page.context();
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const account = await newAccount('Importer');
  await signedInWorkspace(page, account, 'Import space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Import space');
    await newWorkbook(
      api,
      workspaceId,
      'Stock list',
      workbookOf([
        ['Item', 'Quantity', 'Checked'],
        ['Bolts', 40, true],
        ['Nuts', 75, false],
        ['Washers', 120, true],
      ]),
    );
    await newPage(page, 'Stock page');
    await insertExistingWorkbook(page, 'Stock list');
    const block = sheetBlock(page);
    await expectLive(block, 'Bolts');

    // The block's range, into a new database under the page, through the CSV import.
    await blockMenu(page, 'Import this range into a database');
    const range = page.getByRole('dialog', { name: 'Import a range of Stock list' });
    await expect(range.getByLabel('Sheet')).toHaveValue('Sheet1');
    await range.getByLabel('Range', { exact: true }).fill('A1:C3');
    await expect(range).toContainText('Cells: 9');
    await expect(
      range.getByRole('radio', { name: 'A new database under this page' }),
    ).toBeChecked();
    await range.getByRole('button', { name: 'Next', exact: true }).click();
    const csv = page.getByRole('dialog', { name: 'Import CSV' });
    await expect(csv).toContainText('Stock list Sheet1.csv: 2 rows');
    await csv.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(csv).toContainText('Imported rows: 2', { timeout: 60000 });
    await csv.getByRole('button', { name: 'Close' }).first().click();
    // Under the page: its row opens to show the database.
    const tree = page.getByRole('tree', { name: 'Pages' });
    const parent = tree.getByRole('treeitem', { name: /Stock page/ });
    await expect(parent).toHaveAttribute('aria-expanded', /true|false/, { timeout: 30000 });
    if ((await parent.getAttribute('aria-expanded')) !== 'true') {
      await parent.focus();
      await page.keyboard.press('ArrowRight');
    }
    await tree.getByRole('treeitem', { name: /Stock list Sheet1/ }).click({ timeout: 30000 });
    const db = fullPage(page);
    await expect(db).toBeVisible();
    await expect(db.getByRole('status')).toHaveText('Rows: 2');
    await expect(db.getByText('Bolts')).toBeVisible();
    await expect(db.getByText('Nuts')).toBeVisible();
    await expect(db.getByText('Washers')).toHaveCount(0);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

    // The view, exported to a workbook the server writes, and opened in Sheet.
    await db.getByRole('button', { name: /^View options/ }).click();
    await page.getByRole('menuitem', { name: 'Export to a workbook…' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export to a workbook' });
    await exportDialog.getByLabel('Workbook name').fill('Stock export');
    const exported = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/databases\/[^/]+\/workbooks$/.test(r.url()),
    );
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    const made = await exported;
    expect(made.status()).toBe(201);
    const exportedId = ((await made.json()) as { id: string }).id;
    await expect(page.getByText('The workbook “Stock export” is made.')).toBeVisible();
    const content = (await api.get(`/api/v1/workbooks/${exportedId}/range`)) as { csv: string };
    expect(content.csv).toContain('Bolts');
    expect(content.csv).toContain('75');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Open in Cash Gear Sheet' }).click();
    const sheet = await opened;
    await sheet.waitForLoadState('domcontentloaded');
    expect(new URL(sheet.url()).origin).toBe(SHEET_ORIGIN);
    if (!REAL_SHEET) {
      await expect(sheet.locator('#status')).toHaveAttribute('data-state', 'ready');
      await expect(sheet.locator('#name')).toHaveText('Stock export');
      await expect(sheet.locator('#sheet td', { hasText: 'Bolts' })).toBeVisible();
      await expect(sheet.locator('#sheet td', { hasText: /^40$/ })).toBeVisible();
    }
    await sheet.close();
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test("a reader without access to the workbook sees no picture, and neither does the page's share link", async ({
  page,
}) => {
  test.skip(desktop, 'A second person and a share link are browsers');
  const browser = page.context().browser()!;
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const owner = await newAccount('Owner');
  await signedInWorkspace(page, owner, 'Team space', null, cloud.signer);
  const api = await sessionOf(owner);
  const reader = await newAccount('Reader');
  let readerApi: Awaited<ReturnType<typeof invite>> | null = null;
  try {
    const workspaceId = await workspaceIdOf(api, 'Team space');
    const workbookId = await newWorkbook(
      api,
      workspaceId,
      'Payroll',
      workbookOf([
        ['Name', 'Salary'],
        ['Ada', 5100],
      ]),
    );
    await newPage(page, 'Team page');
    await page.keyboard.type('Visible to the team.');
    await page.keyboard.press('Enter');
    const picture = pictureSent(page, workbookId);
    await insertExistingWorkbook(page, 'Payroll');
    await expectLive(sheetBlock(page), 'Ada');
    expect((await picture).status()).toBe(204);
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    // The workbook restricted to its maker; the reader is a member who may read the page.
    await api.put(`/api/v1/workbooks/${workbookId}/permissions`, { restricted: true, entries: [] });
    readerApi = await invite(api, workspaceId, reader);
    expect((await readerApi.raw(`/api/v1/workbooks/${workbookId}`)).status).toBe(404);
    const other = await browser.newContext();
    const there = await other.newPage();
    // The block's read of the workbook is answered 404 (none it may read): the browser logs it.
    const readerErrors = watchAppErrors(there, [
      /status of 404 .*\/api\/v1\/workbooks\/[0-9a-f-]{36}$/,
    ]);
    const asked: string[] = [];
    there.on('request', (r) => {
      if (/\/workbooks\/[^/]+\/(previews|content|launch)/.test(r.url())) asked.push(r.url());
    });
    await there.goto('/');
    await signIn(there, reader);
    await signedIn(there, reader);
    await there.goto(`/#/p/${id}`);
    await expect(editor(there)).toContainText('Visible to the team.', { timeout: 30000 });
    const seen = sheetBlock(there);
    await expect(seen).toHaveAttribute('data-state', 'noAccess', { timeout: 30000 });
    await expect(seen).toContainText(NO_ACCESS);
    await expect(seen.locator('img')).toHaveCount(0);
    await expect(seen.locator('iframe')).toHaveCount(0);
    await expect(seen.getByRole('button', { name: 'Open in Cash Gear Sheet' })).toHaveCount(0);
    expect(asked).toEqual([]);
    await other.close();
    expect(readerErrors).toEqual([]);

    // A view link of the page: the block says the same, with no picture and no frame.
    await expect
      .poll(
        async () =>
          (
            (await api.get(`/api/v1/pages/${id}/doc/json`).catch(() => null)) as {
              json: string;
            } | null
          )?.json ?? '',
        { timeout: 60000 },
      )
      .toContain('sheetEmbed');
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = page.getByRole('dialog', { name: /Share/ });
    await dialog.getByRole('button', { name: 'Create a view link' }).click();
    const shareLink = (await dialog.getByTestId('share-link').textContent())!.trim();
    const anonymousContext = await browser.newContext();
    const anonymous = await anonymousContext.newPage();
    const anonymousErrors = watchAppErrors(anonymous);
    await anonymous.goto(shareLink);
    await expect(anonymous.getByText('Visible to the team.')).toBeVisible({ timeout: 30000 });
    await expect(anonymous.getByText(NO_ACCESS)).toBeVisible();
    await expect(anonymous.locator('.cgw-sheet img, .cgw-sheet-picture')).toHaveCount(0);
    await expect(anonymous.locator('iframe')).toHaveCount(0);
    await anonymousContext.close();
    expect(anonymousErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await readerApi?.dispose();
    await api.dispose();
  }
});

test('offline, the block shows the stored picture with its date, and again after a reload', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const account = await newAccount('Traveller');
  await signedInWorkspace(page, account, 'Away space', authUrlFile, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Away space');
    const workbookId = await newWorkbook(
      api,
      workspaceId,
      'Field notes',
      workbookOf([
        ['Site', 'Visits'],
        ['North yard', 3],
      ]),
    );
    await newPage(page, 'Away page');
    await page.keyboard.type('Notes from the road.');
    await page.keyboard.press('Enter');
    const picture = pictureSent(page, workbookId);
    await insertExistingWorkbook(page, 'Field notes');
    await expectLive(sheetBlock(page), 'North yard');
    expect((await picture).status()).toBe(204);
    // The device keeps the picture just after sending it.
    await page.waitForTimeout(1500);
    await waitSaved(page);
    await newPage(page, 'Elsewhere');
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

    // The network cut: the page opened again shows the picture with its date, not the frame.
    const net = await network(page, page.context());
    await net.off();
    await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 30000 });
    const year = String(new Date().getFullYear());
    const expectPicture = async () => {
      await page
        .getByRole('tree', { name: 'Pages' })
        .getByRole('treeitem', { name: /Away page/ })
        .click();
      await expect(editor(page)).toContainText('Notes from the road.', { timeout: 30000 });
      const offline = sheetBlock(page);
      await expect(offline.locator('.cgw-sheet-picture img')).toBeVisible({ timeout: 30000 });
      await expect(offline.locator('.cgw-sheet-picture figcaption')).toHaveText(
        new RegExp(`^Offline: the picture from .*${year}`),
      );
      await expect(offline.locator('.cgw-sheet-name')).toHaveText('Field notes');
      await expect(offline.locator('.cgw-sheet-live[data-shown]')).toHaveCount(0);
      const width = await offline
        .locator('.cgw-sheet-picture img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth);
      expect(width).toBeGreaterThan(0);
    };
    await expectPicture();
    // Again after a reload while offline (a browser starts from its service worker).
    await page.reload();
    await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 30000 });
    await expectPicture();
    await net.on();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    expect(appErrors(errors)).toEqual([]);
  } finally {
    await api.dispose();
  }
});
