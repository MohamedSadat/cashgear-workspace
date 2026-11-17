// Phase 10's editable Customers and Items on hand (IMPLEMENTATION_PLAN.md, Phase 10, M10.1;
// INTEGRATIONS.md, "Customers and Items on hand editable") against the server stack and the mock ERP
// (tests/mocks/erp: gina holds Customers' Edit and sees only the customers she created, faris
// Customers' Edit and AdvEdit and Items' Edit, alice views both, bob views Customers), in Chrome
// and Edge:
//   - a customer's edit is written only after "Review changes" and "Commit", is in the ERP's audit
//     naming the page and block, and a change made in the ERP meanwhile is shown, not overwritten;
//   - an item's name changed on one row is applied to every row of the item, reviewed per row and
//     written once for the item; a stock movement meanwhile is a conflict that asks for no choice;
//   - a user without the privilege gets no editing, and a commit by any request is refused (the
//     ownership rule too: another's customer is not found);
//   - after editing both, none of their values, nor what was typed, is in any store, the document
//     or search.
// The mock's audit and records are read, so the cases that need them skip with CGW_E2E_REAL_ERP;
// the contract suite (tests/contracts/erp/commit.test.ts) runs the same rules against UnifiedAPI.
import type { Locator, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { pageId, signedInWorkspace, signers, signOutDesktop } from './database';
import {
  APP_ORIGIN,
  COMMIT_CONFLICT,
  ERP_API,
  NO_PICTURE_YET,
  REAL_ERP,
  chooseConnector,
  connectErp,
  connectTicket,
  deviceDump,
  erpBlock,
  erpMarkers,
  found,
  insertErpBlock,
  linkWorkspace,
  mockErp,
  searchHits,
  serverPage,
  sessionOf,
  watchAppErrors,
  workspaceIdOf,
  type ErpUser,
} from './ecosystem';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});
test.beforeEach(async () => {
  test.skip(desktop, 'The desktop connects through the system browser: erp.spec.ts covers it');
  if (!REAL_ERP) await mockErp.reset();
});

const table = (block: Locator) => block.getByTestId('erp-table');
const rowsOf = (block: Locator, key: string) => table(block).locator(`tr[data-key="${key}"]`);
const cellOf = (row: Locator, field: string) => row.locator(`td[data-field="${field}"]`);

/** A page with an ERP block on `connector` in a linked workspace, connected as `user`. */
async function erpPage(page: Page, name: string, user: ErpUser, connector: string) {
  const account = await newAccount(name);
  await signedInWorkspace(page, account, `${name} space`, null, cloud.signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, `${name} space`);
  const link = await linkWorkspace(api, workspaceId, `${name} space`);
  await newPage(page, `${name} page`);
  await page.keyboard.type('ERP data to tidy.');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  const block = erpBlock(page);
  await connectErp(page, block, user);
  await chooseConnector(block, connector);
  await expect(table(block)).toBeVisible({ timeout: 30000 });
  return { account, api, workspaceId, link, block };
}

/** The id of the block holding the page's ERP view, from the editor's own document. */
const erpBlockId = (page: Page) =>
  page.evaluate(() => {
    interface Node {
      type: string;
      attrs?: Record<string, unknown>;
      content?: Node[];
    }
    const view = document.querySelector('.cgw-page .ProseMirror') as
      (Element & { editor?: { getJSON(): Node } }) | null;
    let id: string | null = null;
    const walk = (node: Node) => {
      if (node.type === 'block' && node.content?.some((c) => c.type === 'erpView'))
        id = String(node.attrs?.id);
      node.content?.forEach(walk);
    };
    if (view?.editor) walk(view.editor.getJSON());
    return id;
  });

/** Opens a cell's editor, types a value, and presses Enter. */
async function change(cell: Locator, value: string) {
  await cell.getByRole('button').click();
  const input = cell.getByRole('textbox');
  await input.fill(value);
  await input.press('Enter');
  await expect(cell).toHaveAttribute('data-changed', 'person');
}

/** A Kit record as the mock holds it now (Items on hand: every row of the item). */
async function mockRecords(connector: 'customers' | 'itemsOnHand', key: string) {
  const state = await mockErp.state();
  return state.records[connector]!.filter((r) => r.company === 'Kit' && r.key === key);
}

/** Another ERP user changes a record behind the page's back (Items on hand: by its id). */
const editInErp = (body: Record<string, unknown>) =>
  fetch(`${ERP_API}/__mock/edit-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Kit', by: 'Bob Mansour', ...body }),
  }).then((r) => expect(r.status).toBeLessThan(300));

/** A session of an ERP user from the app's origin, as the page's own would be. */
async function erpToken(user: ErpUser, workspaceId: string, erpLinkId: string) {
  const ticket = await connectTicket(user, workspaceId, erpLinkId);
  const redeemed = await fetch(`${ERP_API}/api/connect/Session/Redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ ticket, workspaceId }),
  });
  expect(redeemed.status).toBe(200);
  return ((await redeemed.json()) as { token: string }).token;
}

/** A commit sent by hand with a session: its status and first error code. */
async function forged(token: string, connector: string, body: Record<string, unknown>) {
  const answer = await fetch(`${ERP_API}/api/connect/Connectors/${connector}/Commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN, 'X-Connect-Session': token },
    body: JSON.stringify(body),
  });
  const json = (await answer.json().catch(() => null)) as { errors?: { code: string }[] } | null;
  return { status: answer.status, code: json?.errors?.[0]?.code };
}

test('a customer’s edit is written only after review and commit, names its page in the ERP’s audit, and a change made in the ERP is shown, not overwritten', async ({
  page,
}) => {
  test.skip(REAL_ERP, "The mock's audit and records are read here");
  test.setTimeout(300000);
  const errors = watchAppErrors(page, [NO_PICTURE_YET, COMMIT_CONFLICT]);
  const { api, workspaceId, block } = await erpPage(page, 'Cust tidier', 'gina', 'Customers');
  try {
    // The ownership rule: gina sees only the customers she created, without their national ID.
    const hers = (await mockErp.state()).records.customers!.filter(
      (r) => r.company === 'Kit' && r.values.createdBy === 'u105',
    );
    await expect(block.getByTestId('erp-range')).toContainText(`of ${hers.length}`);
    await expect(table(block).locator('th[data-field="nationalId"]')).toHaveCount(0);
    await expect(rowsOf(block, 'C-1001')).toHaveCount(0);

    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    const before = (await mockRecords('customers', 'C-1006'))[0]!;
    const mobile = '01277788899';
    await change(cellOf(rowsOf(block, 'C-1006'), 'mobile'), mobile);
    // AdvEdit's fields are not hers to change.
    await expect(cellOf(rowsOf(block, 'C-1006'), 'creditLimit').getByRole('button')).toHaveCount(0);
    expect((await mockRecords('customers', 'C-1006'))[0]!.values.mobile).toBe(before.values.mobile);

    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    const review = block.getByTestId('erp-review');
    await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
    await expect(review.locator('tbody tr')).toHaveCount(1);
    await expect(review.locator('tbody tr')).toContainText(mobile);
    expect((await mockErp.audit()).audit).toEqual([]);
    await review.getByRole('button', { name: 'Commit changes: 1' }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    const after = (await mockRecords('customers', 'C-1006'))[0]!;
    expect(after.values.mobile).toBe(mobile);
    // The customer screen's stamps, and nothing of the address book.
    expect(after.values.modifiedBy).toBe('Gina Wahba');
    expect(after.values.city).toBe(before.values.city);
    const { audit } = await mockErp.audit();
    expect(audit).toEqual([
      expect.objectContaining({
        connector: 'customers',
        key: 'C-1006',
        field: 'mobile',
        before: before.values.mobile ?? null,
        after: mobile,
        workspaceId,
        pageId: pageId(page),
        blockId: await erpBlockId(page),
      }),
    ]);

    // Someone renames C-1002 in the ERP while it is renamed here too.
    await change(cellOf(rowsOf(block, 'C-1002'), 'customerName'), 'Zumurrudan Bakeries');
    await editInErp({
      connector: 'customers',
      key: 'C-1002',
      values: { customerName: 'Renamed in the ERP' },
    });
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    const conflicts = block.getByTestId('erp-conflicts');
    await expect(conflicts).toBeVisible({ timeout: 30000 });
    const row = conflicts.locator('tr[data-field="customerName"]');
    await expect(row).toContainText('Zumurrudan Bakeries');
    await expect(row).toContainText('Renamed in the ERP');
    await expect(conflicts).toContainText('Bob Mansour');
    expect((await mockRecords('customers', 'C-1002'))[0]!.values.customerName).toBe(
      'Renamed in the ERP',
    );
    await conflicts.getByRole('button', { name: 'Keep Cash Gear ERP’s for all' }).click();
    await expect(block.getByTestId('erp-change-count')).toHaveText(
      'No changes yet. Choose a value to change it.',
    );
    expect((await mockRecords('customers', 'C-1002'))[0]!.values.customerName).toBe(
      'Renamed in the ERP',
    );
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('an item’s name changed on one row changes every row of the item, written once; a stock movement meanwhile asks for no choice', async ({
  page,
}) => {
  test.skip(REAL_ERP, "The mock's audit and records are read here");
  test.setTimeout(300000);
  const errors = watchAppErrors(page, [NO_PICTURE_YET, COMMIT_CONFLICT]);
  const { api, block } = await erpPage(page, 'Item tidier', 'faris', 'Items on hand');
  try {
    const item = await mockRecords('itemsOnHand', 'ITM-0001');
    expect(item.length).toBeGreaterThanOrEqual(2);
    const rows = rowsOf(block, 'ITM-0001');
    await expect(rows).toHaveCount(item.length);
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    // The quantity is never editable here.
    await expect(cellOf(rows.first(), 'onHandQty').getByRole('button')).toHaveCount(0);
    const name = 'Qorvath olive oil, one litre';
    await cellOf(rows.nth(1), 'itemName').getByRole('button').click();
    await expect(cellOf(rows.nth(1), 'itemName')).toContainText(
      'Every row with the same Item ID changes too.',
    );
    await cellOf(rows.nth(1), 'itemName').getByRole('textbox').fill(name);
    await cellOf(rows.nth(1), 'itemName').getByRole('textbox').press('Enter');
    for (let i = 0; i < item.length; i++) {
      await expect(cellOf(rows.nth(i), 'itemName')).toHaveAttribute('data-changed', 'person');
      await expect(cellOf(rows.nth(i), 'itemName')).toContainText(name);
    }
    await expect(block.getByTestId('erp-change-count')).toHaveText(
      `Changes not committed: ${item.length}`,
    );
    await expect(rowsOf(block, 'ITM-0002').locator('td[data-changed]')).toHaveCount(0);

    // A posting moves one row's stock between the review and the commit.
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    const review = block.getByTestId('erp-review');
    await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
    await expect(review.locator('tbody tr')).toHaveCount(item.length);
    await editInErp({ connector: 'itemsOnHand', id: item[1]!.id, values: { onHandQty: '79.000' } });
    await review.getByRole('button', { name: `Commit changes: ${item.length}` }).click();
    const conflicts = block.getByTestId('erp-conflicts');
    await expect(conflicts).toBeVisible({ timeout: 30000 });
    await expect(conflicts.getByTestId('erp-conflict-other')).toHaveCount(1);
    expect((await mockRecords('itemsOnHand', 'ITM-0001')).map((r) => r.values.itemName)).toEqual(
      item.map((r) => r.values.itemName),
    );
    // No field of the commit changed there: nothing to choose; review again and commit.
    await conflicts.getByRole('button', { name: 'Apply choices' }).click();
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
    await review.getByRole('button', { name: `Commit changes: ${item.length}` }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    const now = await mockRecords('itemsOnHand', 'ITM-0001');
    for (const r of now) expect(r.values.itemName).toBe(name);
    // Stock as the ERP moved it, never by the commit.
    expect(now.map((r) => r.values.onHandQty)).toEqual(
      item.map((r, i) => (i === 1 ? '79.000' : r.values.onHandQty)),
    );
    const { audit } = await mockErp.audit();
    expect(audit).toEqual([
      expect.objectContaining({
        connector: 'itemsOnHand',
        key: 'ITM-0001',
        field: 'itemName',
        before: item[0]!.values.itemName,
        after: name,
        pageId: pageId(page),
      }),
    ]);
    for (let i = 0; i < item.length; i++) {
      await expect(cellOf(rows.nth(i), 'itemName')).toContainText(name);
    }
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('a person without the privilege gets no editing of Customers or Items on hand, and a commit by any request is refused', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const { api, workspaceId, link, block } = await erpPage(
    page,
    'Cust viewer',
    'alice',
    'Customers',
  );
  try {
    await expect(block.getByRole('button', { name: 'Edit data' })).toHaveCount(0);
    await expect(table(block).getByRole('button')).toHaveCount(0);
    const source = { workspaceId, pageId: pageId(page), blockId: null };
    const record = (connector: string, id: string, key: string, field: string) => ({
      commitId: crypto.randomUUID(),
      schemaVersion: `${connector}.1`,
      dryRun: false,
      source,
      records: [
        { id, key, version: 'AAAAAAAAAAE=', changes: { [field]: { from: null, to: 'Forged' } } },
      ],
    });
    const customer = (dryRun: boolean) => ({
      ...record('customers', '7101', 'C-1001', 'address'),
      dryRun,
    });
    const item = record('itemsOnHand', 'ITM-0001|S-MAIN|WH-CAI|A-01', 'ITM-0001', 'itemName');
    // A viewer of both, any request, dry runs too.
    const viewer = await erpToken('alice', workspaceId, link.erpLinkId);
    for (const body of [customer(true), customer(false), { ...customer(false), records: [] }, {}]) {
      expect(await forged(viewer, 'customers', body)).toEqual({
        status: 403,
        code: 'privilege.denied',
      });
    }
    expect(await forged(viewer, 'itemsOnHand', item)).toEqual({
      status: 403,
      code: 'privilege.denied',
    });
    // Bob views Customers only; gina edits Customers but may not see Items on hand at all.
    const bob = await erpToken('bob', workspaceId, link.erpLinkId);
    expect(await forged(bob, 'customers', customer(true))).toEqual({
      status: 403,
      code: 'privilege.denied',
    });
    const gina = await erpToken('gina', workspaceId, link.erpLinkId);
    expect(await forged(gina, 'itemsOnHand', item)).toEqual({
      status: 403,
      code: 'privilege.denied',
    });
    // The ownership rule: a customer she did not create is not found for her.
    if (!REAL_ERP) {
      const theirs = (await mockErp.state()).records.customers!.find(
        (r) => r.company === 'Kit' && r.values.createdBy !== 'u105',
      )!;
      expect(
        await forged(gina, 'customers', {
          ...record('customers', theirs.id, theirs.key, 'mobile'),
          dryRun: true,
        }),
      ).toEqual({ status: 400, code: 'record.notFound' });
      expect((await mockErp.audit()).audit).toEqual([]);
      expect((await mockRecords('customers', 'C-1001'))[0]!.values.address).not.toBe('Forged');
    }
    // Without a session at all, from the page itself.
    const bare = await page.evaluate(async (erp) => {
      const r = await fetch(`${erp}/api/connect/Connectors/customers/Commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return r.status;
    }, ERP_API);
    expect(bare).toBe(401);
    expect(
      errors.filter((e) => !/status of 40[13] .*Connectors\/customers\/Commit$/.test(e)),
    ).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('nothing stored: after editing customers and items, none of their values, nor what was typed, is in any store, the document or search', async ({
  page,
}) => {
  test.skip(REAL_ERP, "The mock's seeded keys are edited here");
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const { api, block, workspaceId } = await erpPage(page, 'Keeper ten', 'faris', 'Customers');
  const markers = await erpMarkers();
  // What the person types becomes ERP data: made-up words found nowhere else, new each run.
  const run = Date.now().toString(36);
  const typed = [`Calderunix Bakehouse ${run}`, `Ystrellane olive oil ${run}`];
  try {
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    await change(cellOf(rowsOf(block, 'C-1001'), 'customerName'), typed[0]!);
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(block.getByTestId('erp-review')).toHaveAttribute('data-phase', 'reviewed', {
      timeout: 30000,
    });
    await block.getByRole('button', { name: 'Commit changes: 1' }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    await expect(table(block)).toContainText(typed[0]!);

    // The same block on Items on hand: one row's name, every row of the item.
    await block
      .getByRole('group', { name: 'View settings' })
      .getByLabel('Data')
      .selectOption({ label: 'Items on hand' });
    await expect(block.getByTestId('erp-title')).toHaveText('Items on hand', { timeout: 30000 });
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    const rows = rowsOf(block, 'ITM-0001');
    await change(cellOf(rows.first(), 'itemName'), typed[1]!);
    const count = await rows.count();
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(block.getByTestId('erp-review')).toHaveAttribute('data-phase', 'reviewed', {
      timeout: 30000,
    });
    await block.getByRole('button', { name: `Commit changes: ${count}` }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    const device = await deviceDump(page);
    expect(found(device.build, [...markers, ...typed]), "the app's own files").toEqual([]);
    expect(device.text, 'the page is on this device').toContain('Keeper ten page');
    expect(found(device.text, [...markers, ...typed]), device.summary.join('; ')).toEqual([]);
    const server = await serverPage(api, id, 'ERP data to tidy.');
    const serverText = [server.json, server.updates, ...server.versions].join('\n');
    expect(found(serverText, [...markers, ...typed])).toEqual([]);
    for (const word of typed) expect(await searchHits(api, workspaceId, word)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});
