// Phase 7's editable ERP blocks (IMPLEMENTATION_PLAN.md, Phase 7, M7.1) against the server stack
// and the mock ERP (tests/mocks/erp: gina holds Vendors' Edit, faris Edit and AdvEdit, alice views
// only; with CGW_E2E_REAL_ERP, UnifiedAPI on LocalDB with Track E6's seeded keys), in Chrome and
// Edge:
//   - an edit to an ERP field is written only after "Review changes" and "Commit", is in the ERP's
//     audit naming the page and block it came from, and Workspace records the attempt;
//   - a change made in the ERP meanwhile is shown beside the person's and not overwritten until
//     they choose;
//   - a person without the edit privilege gets no editing, and a commit by any request is refused;
//   - leaving the page with changes not committed asks first;
//   - after editing, none of the ERP's values, nor what was typed, is in any store, the document or
//     search.
import type { Locator, Page, Request } from '@playwright/test';
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
const cell = (block: Locator, key: string, field: string) =>
  table(block).locator(`tr[data-key="${key}"] td[data-field="${field}"]`);

/** A page with an ERP block on Vendors in a linked workspace, connected as `user`. */
async function vendorsPage(page: Page, name: string, user: 'gina' | 'faris' | 'alice') {
  const account = await newAccount(name);
  await signedInWorkspace(page, account, `${name} space`, null, cloud.signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, `${name} space`);
  const link = await linkWorkspace(api, workspaceId, `${name} space`);
  await newPage(page, `${name} page`);
  await page.keyboard.type('Vendors to tidy.');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  const block = erpBlock(page);
  await connectErp(page, block, user);
  await chooseConnector(block, 'Vendors');
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
async function change(block: Locator, key: string, field: string, value: string) {
  await cell(block, key, field).getByRole('button').click();
  const input = cell(block, key, field).getByRole('textbox');
  await input.fill(value);
  await input.press('Enter');
  await expect(cell(block, key, field)).toHaveAttribute('data-changed', 'person');
}

/** A Kit vendor as the mock holds it now. */
async function mockVendor(key: string) {
  const state = await mockErp.state();
  return state.records.vendors.find((r) => r.company === 'Kit' && r.key === key)!;
}

/** Workspace's record of each real commit attempt, as the app sent it. */
function commitReports(page: Page): Record<string, unknown>[] {
  const reports: Record<string, unknown>[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && /\/api\/v1\/pages\/[^/]+\/erp-commits$/.test(request.url()))
      reports.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
  });
  return reports;
}

test('an ERP edit is written only after review and commit, names its page in the ERP’s audit, and a change made in the ERP is shown, not overwritten', async ({
  page,
}) => {
  test.skip(
    REAL_ERP,
    "The mock's audit and its records are read here; the contract suite runs against UnifiedAPI",
  );
  test.setTimeout(300000);
  const errors = watchAppErrors(page, [NO_PICTURE_YET, COMMIT_CONFLICT]);
  const reports = commitReports(page);
  const { api, workspaceId, link, block } = await vendorsPage(page, 'Tidier', 'gina');
  try {
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    const before = await mockVendor('V-1001');
    const address = '14 Corniche Rd, Alexandria';
    await change(block, 'V-1001', 'address', address);
    await expect(block.getByTestId('erp-change-count')).toHaveText('Changes not committed: 1');
    // Held in the tab: the ERP has not been asked to write anything.
    expect((await mockVendor('V-1001')).values.address).toBe(before.values.address);

    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    const review = block.getByTestId('erp-review');
    await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
    await expect(review.locator('tbody tr')).toHaveCount(1);
    await expect(review.locator('tbody tr')).toContainText(address);
    // A dry run writes nothing.
    expect((await mockVendor('V-1001')).values.address).toBe(before.values.address);
    expect((await mockErp.audit()).audit).toEqual([]);

    await review.getByRole('button', { name: 'Commit changes: 1' }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    expect((await mockVendor('V-1001')).values.address).toBe(address);
    await expect(cell(block, 'V-1001', 'address')).toContainText(address);
    const id = pageId(page);
    const blockId = await erpBlockId(page);
    const { audit } = await mockErp.audit();
    expect(audit).toEqual([
      expect.objectContaining({
        connector: 'vendors',
        key: 'V-1001',
        field: 'address',
        before: before.values.address ?? null,
        after: address,
        workspaceId,
        pageId: id,
        blockId,
      }),
    ]);
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toEqual({
      blockId,
      linkId: link.linkId,
      connectorId: 'vendors',
      commitId: audit[0]!.commitId,
      outcome: 'committed',
      records: 1,
      fields: 1,
    });

    // Someone changes V-1002's name in the ERP while it is changed here too.
    await change(block, 'V-1002', 'vendorName', 'Zumurrudan Supplies');
    await mockErp.editRecord('vendors', 'Kit', 'V-1002', { vendorName: 'Changed in the ERP' });
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    const conflicts = block.getByTestId('erp-conflicts');
    await expect(conflicts).toBeVisible({ timeout: 30000 });
    const row = conflicts.locator('tr[data-field="vendorName"]');
    await expect(row).toContainText('Zumurrudan Supplies');
    await expect(row).toContainText('Changed in the ERP');
    await expect(conflicts).toContainText('Bob Mansour');
    // Not overwritten: the ERP keeps its value until the person chooses and commits again.
    expect((await mockVendor('V-1002')).values.vendorName).toBe('Changed in the ERP');
    await expect(conflicts.getByRole('button', { name: 'Apply choices' })).toBeDisabled();
    await row.getByRole('radio', { name: 'Cash Gear ERP’s' }).check();
    await conflicts.getByRole('button', { name: 'Apply choices' }).click();
    await expect(block.getByTestId('erp-change-count')).toHaveText(
      'No changes yet. Choose a value to change it.',
    );
    expect((await mockVendor('V-1002')).values.vendorName).toBe('Changed in the ERP');
    // That conflict came from the review's dry run, which is not a commit attempt: not reported.
    expect(reports.map((r) => r.outcome)).toEqual(['committed']);

    // A change made in the ERP between a clean review and Commit: the commit's 409 is shown, the
    // ERP keeps its value, and the attempt is reported as a conflict.
    await change(block, 'V-1003', 'mobile', '01000000003');
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
    await mockErp.editRecord('vendors', 'Kit', 'V-1003', { mobile: '01999999999' });
    await review.getByRole('button', { name: 'Commit changes: 1' }).click();
    await expect(conflicts).toBeVisible({ timeout: 30000 });
    await expect(conflicts.locator('tr[data-field="mobile"]')).toContainText('01999999999');
    expect((await mockVendor('V-1003')).values.mobile).toBe('01999999999');
    await expect.poll(() => reports.map((r) => r.outcome)).toEqual(['committed', 'conflict']);
    await conflicts.getByRole('button', { name: 'Keep Cash Gear ERP’s for all' }).click();
    await expect(block.getByTestId('erp-change-count')).toHaveText(
      'No changes yet. Choose a value to change it.',
    );

    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('a person without the edit privilege gets no editing, and a commit by any request is refused', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const { api, workspaceId, link, block } = await vendorsPage(page, 'Viewer', 'alice');
  try {
    await expect(block.getByRole('button', { name: 'Edit data' })).toHaveCount(0);
    await expect(table(block).getByRole('button')).toHaveCount(0);
    // A session of the same ERP user, from the app's origin, as the page's own would be: any
    // commit is 403, the dry run too, whatever it sends.
    const ticket = await connectTicket('alice', workspaceId, link.erpLinkId);
    const redeemed = await fetch(`${ERP_API}/api/connect/Session/Redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ ticket, workspaceId }),
    });
    expect(redeemed.status).toBe(200);
    const { token } = (await redeemed.json()) as { token: string };
    for (const dryRun of [true, false]) {
      const answer = await fetch(`${ERP_API}/api/connect/Connectors/vendors/Commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: APP_ORIGIN,
          'X-Connect-Session': token,
        },
        body: JSON.stringify({
          commitId: crypto.randomUUID(),
          schemaVersion: 'vendors.1',
          dryRun,
          source: { workspaceId, pageId: pageId(page), blockId: null },
          records: [
            {
              id: '4411',
              key: 'V-1001',
              version: 'AAAAAAAAEAE=',
              changes: { address: { from: null, to: 'Forged' } },
            },
          ],
        }),
      });
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        'privilege.denied',
      );
    }
    // Without a session at all, from the page itself.
    const bare = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/connect/Connectors/vendors/Commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return r.status;
    }, ERP_API);
    expect(bare).toBe(401);
    if (!REAL_ERP) {
      expect((await mockErp.audit()).audit).toEqual([]);
      expect((await mockVendor('V-1001')).values.address).not.toBe('Forged');
    }
    expect(
      errors.filter((e) => !/status of 40[13] .*Connectors\/vendors\/Commit$/.test(e)),
    ).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('leaving a page with ERP changes not committed asks first: staying keeps them, leaving forgets them', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const { api, block } = await vendorsPage(page, 'Leaver', 'gina');
  try {
    const id = pageId(page);
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    await change(block, 'V-1003', 'mobile', '01555000111');
    await page.evaluate(() => (location.hash = '#/trash'));
    const dialog = page.getByRole('alertdialog', { name: 'Leave with changes not committed?' });
    await expect(dialog).toBeVisible();
    // The page is still the one shown.
    await expect(block).toBeVisible();
    await dialog.getByRole('button', { name: 'Stay on this page' }).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${id}$`));
    await expect(cell(block, 'V-1003', 'mobile')).toHaveAttribute('data-changed', 'person');

    await page.evaluate(() => (location.hash = '#/trash'));
    await dialog.getByRole('button', { name: 'Leave and discard' }).click();
    await expect(page).toHaveURL(/#\/trash$/);
    await page.evaluate((id) => (location.hash = `#/p/${id}`), id);
    const back = erpBlock(page);
    await expect(table(back)).toBeVisible({ timeout: 30000 });
    await expect(cell(back, 'V-1003', 'mobile')).not.toHaveAttribute('data-changed', /.+/);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('nothing stored: after editing ERP data, none of it, nor what was typed, is in any store, the document or search', async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const { api, block, workspaceId } = await vendorsPage(page, 'Keeper', 'faris');
  const markers = await erpMarkers();
  // What the person types becomes ERP data: made-up words found nowhere else, new each run (a
  // real ERP keeps what the last browser's run committed, and typing it again is no change).
  const run = Date.now().toString(36);
  const typed = [`Brinmoorvale Steelworks ${run}`, `Qorvathine Depot ${run}`];
  try {
    await block.getByRole('button', { name: 'Edit data', exact: true }).click();
    await change(block, 'V-1001', 'vendorName', typed[0]!);
    await change(block, 'V-1004', 'address', typed[1]!);
    await block.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(block.getByTestId('erp-review')).toHaveAttribute('data-phase', 'reviewed', {
      timeout: 30000,
    });
    await block.getByRole('button', { name: 'Commit changes: 2' }).click();
    await expect(block.getByTestId('erp-committed')).toBeVisible({ timeout: 30000 });
    await expect(table(block)).toContainText(typed[0]!);
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    const device = await deviceDump(page);
    const own = found(device.build, [...markers, ...typed]);
    expect(own, "the values in the app's own files").toEqual([]);
    expect(device.text, 'the page is on this device').toContain('Keeper page');
    expect(found(device.text, [...markers, ...typed]), device.summary.join('; ')).toEqual([]);
    const server = await serverPage(api, id, 'Vendors to tidy.');
    const serverText = [server.json, server.updates, ...server.versions].join('\n');
    expect(found(serverText, [...markers, ...typed])).toEqual([]);
    for (const word of typed) expect(await searchHits(api, workspaceId, word)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});
