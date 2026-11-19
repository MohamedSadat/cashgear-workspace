// Phase 12's ERP reports (IMPLEMENTATION_PLAN.md, Phase 12, M12.6; INTEGRATIONS.md, "Reports (Phase
// 12, Track E11)") against the server stack and the mock ERP (tests/mocks/erp: alice an accounts
// manager, every report with cost; bob the warehouse, stock balance without cost; gina payables,
// AP aging only), in Chrome and Edge:
//   - AP aging by vendor is inserted as a report, its parameters changed and kept in the block (a
//     date, a choice, a lookup), its rows totalled, its bands named by the date it ages by; only
//     Refresh and a parameter's change ask the ERP again; no editing, no AI;
//   - stock balance's switch and the trial balance's period, each kept; cost only for whom the ERP
//     shows it, and a report refused to a person without its role;
//   - a build that asks for connectors without `kinds` (0.11.0 and older) is listed no report, and
//     a report's query without parameters is refused;
//   - after each report is shown, none of its values is in any store, the document, its versions
//     or search: the block holds only what the person chose.
// The mock's ledgers' exact answers are read, so the cases skip with CGW_E2E_REAL_ERP; the
// contract suite (tests/contracts/erp/reports.test.ts) runs the same rules against UnifiedAPI.
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { waitSaved } from './helpers';
import { syncStatus } from './cloud';
import { pageId, signers, signOutDesktop } from './database';
import {
  APP_ORIGIN,
  ERP_API,
  REAL_ERP,
  connectErp,
  deviceDump,
  erpBlock,
  erpMarkers,
  found,
  mockErp,
  searchHits,
  serverPage,
  watchAppErrors,
} from './ecosystem';
import {
  REPORT_LABELS,
  cellOf,
  control,
  erp12Scene,
  erpToken,
  headerOf,
  heldParameters,
  inEnglish,
  parametersOf,
  reportAt,
  rowOf,
  setDate,
  showData,
  table,
  totalsOf,
  watchQueries,
} from './erp12';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});
test.beforeEach(async () => {
  test.skip(desktop, 'The desktop connects through the system browser: erp.spec.ts covers it');
  test.skip(REAL_ERP, "The mock's ledgers' exact answers are read");
  await mockErp.reset();
});

/** The page loaded again: the ERP session lives in the tab's memory, so it is connected again. */
async function reconnect(page: Page, user: 'alice' | 'bob' | 'gina') {
  await page.reload();
  const block = erpBlock(page);
  await connectErp(page, block, user);
  return block;
}

/** Queries of one connector sent since `from`. */
const since = (sent: ReturnType<typeof watchQueries>, from: number, connector: string) =>
  sent.slice(from).filter((q) => q.connector === connector);

test('AP aging is inserted as a report, its parameters are changed and kept in the block, its rows totalled and its bands named by the date it ages by', async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const sent = watchQueries(page);
  const scene = await erp12Scene(page, 'Aging', cloud.signer);
  try {
    const block = erpBlock(page);
    // Listed as a report, apart from the lists; read with the defaults, then as of the day set.
    const queries = since(sent, 0, 'apAging');
    expect(queries[0]!.body.parameters).toEqual({});
    expect(queries.at(-1)!.body.parameters).toEqual({ asOf: '2026-10-31' });
    await expect(block.getByTestId('erp-report')).toHaveText('Report');
    const bar = parametersOf(block);
    await expect(bar).toHaveAccessibleName('Report settings');
    for (const name of ['asOf', 'ageBy', 'basis', 'vendorGroup'] as const) {
      await expect(control(block, name)).toBeVisible();
    }
    await expect(control(block, 'ageBy')).toHaveValue('dueDate');
    await expect(control(block, 'basis')).toHaveValue('oldestFirst');
    // A report has no editing and no AI, whatever the ERP lets the person do elsewhere.
    await expect(block.getByRole('button', { name: 'Edit data', exact: true })).toHaveCount(0);
    await expect(block.getByRole('button', { name: /Prepare changes with AI/ })).toHaveCount(0);

    // Its rows as of 2026-10-31, aged by due date, and their totals over every match.
    const token = await erpToken('alice', scene.workspaceId, scene.erpLinkId);
    const due = await reportAt(token, 'apAging', { asOf: '2026-10-31' });
    const v1001 = rowOf(block, 'V-1001');
    await expect(cellOf(v1001, 'balance')).toHaveText('1,100.00', { timeout: 30000 });
    await expect(cellOf(v1001, 'band0')).toHaveText('500.00');
    await expect(cellOf(v1001, 'band3')).toHaveText('600.00');
    await expect(headerOf(block, 'band0')).toHaveText('Not due');
    await expect(headerOf(block, 'band4')).toHaveText('Over 90 days');
    const totals = totalsOf(block);
    await expect(totals.locator('th[scope="row"]')).toHaveText('Total');
    await expect(cellOf(totals, 'balance')).toHaveText(inEnglish(due.totals!.balance!));
    await expect(cellOf(totals, 'band3')).toHaveText(inEnglish(due.totals!.band3!));
    await expect(cellOf(totals, 'openItems')).toHaveText('');
    await expect(block.getByTestId('erp-range')).toContainText(`of ${due.total}`);

    // Aged by invoice date: the bands' names and amounts move; the block holds the choice.
    const before = sent.length;
    await control(block, 'ageBy').selectOption({ label: 'Invoice date' });
    await expect(headerOf(block, 'band0')).toHaveText('0–30 days', { timeout: 30000 });
    await expect(headerOf(block, 'band3')).toHaveText('91–120 days');
    await expect(headerOf(block, 'band4')).toHaveText('Over 120 days');
    await expect(cellOf(v1001, 'band3')).toHaveText('600.00');
    await expect(cellOf(v1001, 'oldestDays')).toHaveText('91');
    await expect
      .poll(() => heldParameters(page))
      .toEqual({
        asOf: '2026-10-31',
        ageBy: 'invoiceDate',
      });
    expect(since(sent, before, 'apAging').map((q) => q.body.parameters)).toEqual([
      { asOf: '2026-10-31', ageBy: 'invoiceDate' },
    ]);
    // On the open-items basis a payment that settles nothing is unapplied.
    await control(block, 'basis').selectOption({ label: 'Open items' });
    await expect(cellOf(v1001, 'unapplied')).toHaveText('100.00', { timeout: 30000 });
    await expect(cellOf(v1001, 'band3')).toHaveText('700.00');
    // A group from the ERP's list; its default again is "All", which the block does not hold.
    await control(block, 'vendorGroup').selectOption({ label: 'محلي' });
    await expect(rowOf(block, 'V-1001')).toBeVisible({ timeout: 30000 });
    for (const cell of await table(block).locator('tbody td[data-field="vendorGroup"]').all()) {
      await expect(cell).toHaveText('محلي');
    }
    await control(block, 'vendorGroup').selectOption({ label: 'All' });
    await control(block, 'basis').selectOption({ label: 'Oldest first' });
    await expect
      .poll(() => heldParameters(page))
      .toEqual({
        asOf: '2026-10-31',
        ageBy: 'invoiceDate',
      });

    // Refresh asks once; nothing else does (no timer).
    await expect(cellOf(v1001, 'unapplied')).toHaveText('0.00', { timeout: 30000 });
    const settled = sent.length;
    await page.waitForTimeout(3000);
    expect(since(sent, settled, 'apAging')).toEqual([]);
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => since(sent, settled, 'apAging').length).toBe(1);
    await page.waitForTimeout(2000);
    expect(since(sent, settled, 'apAging')).toHaveLength(1);

    // Kept: loaded again and connected, the block reads the report with what it holds.
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const again = sent.length;
    const reloaded = await reconnect(page, 'alice');
    await expect(table(reloaded)).toBeVisible({ timeout: 30000 });
    await expect(control(reloaded, 'ageBy')).toHaveValue('invoiceDate');
    await expect(control(reloaded, 'asOf')).toHaveValue('10/31/2026');
    await expect(headerOf(reloaded, 'band0')).toHaveText('0–30 days');
    expect(since(sent, again, 'apAging')[0]!.body.parameters).toEqual({
      asOf: '2026-10-31',
      ageBy: 'invoiceDate',
    });
    // Cleared, the date takes its default again: today, which the block does not hold.
    await parametersOf(reloaded)
      .locator('[data-parameter="asOf"]')
      .getByRole('button', { name: 'Clear the date' })
      .click();
    await expect.poll(() => heldParameters(page)).toEqual({ ageBy: 'invoiceDate' });
    await expect(control(reloaded, 'asOf')).toHaveAttribute('placeholder', 'Today');
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
  }
});

test('stock balance’s switch and the trial balance’s period are kept; cost shows only for whom the ERP shows it, and a report is refused without its role', async ({
  page,
}) => {
  test.setTimeout(300000);
  // The refusals below are the ERP's answers, which a browser logs.
  const errors = watchAppErrors(page, [
    /status of 403 .*\/api\/connect\/Connectors\/trialBalance\/Schema$/,
    /status of 400 .*\/api\/connect\/Connectors\/trialBalance\/Query$/,
  ]);
  const scene = await erp12Scene(page, 'Stock', cloud.signer);
  try {
    let block = erpBlock(page);
    // Stock balance: as of a day, zero balances off by default, then on.
    await showData(block, REPORT_LABELS.stockBalance.en);
    for (const name of ['asOf', 'siteId', 'warehouseId', 'includeZero'] as const) {
      await expect(control(block, name)).toBeVisible();
    }
    await setDate(block, 'asOf', '2026-10-31');
    const item = table(block).locator('tbody tr[data-key="ITM-0001"]');
    await expect(item).toHaveCount(2, { timeout: 30000 });
    await expect(headerOf(block, 'cost')).toBeVisible();
    await expect(control(block, 'includeZero')).not.toBeChecked();
    await control(block, 'includeZero').click();
    await expect(item).toHaveCount(3, { timeout: 30000 });
    await expect
      .poll(() => heldParameters(page))
      .toEqual({
        asOf: '2026-10-31',
        includeZero: true,
      });
    await expect(cellOf(totalsOf(block), 'cost')).not.toHaveText('');
    await expect(cellOf(totalsOf(block), 'unitCost')).toHaveText('');

    // The trial balance over October, by profit and loss.
    await showData(block, REPORT_LABELS.trialBalance.en);
    await setDate(block, 'dateFrom', '2026-10-01');
    await setDate(block, 'dateTo', '2026-10-31');
    await expect(table(block).locator('tbody tr').first()).toHaveAttribute('data-key', '5101', {
      timeout: 30000,
    });
    await expect(cellOf(totalsOf(block), 'balance')).toHaveText('-2,000.00');
    await expect(cellOf(rowOf(block, '4101'), 'share')).toHaveText('750.00');
    await expect
      .poll(() => heldParameters(page))
      .toEqual({
        dateFrom: '2026-10-01',
        dateTo: '2026-10-31',
      });
    // A period that ends before it starts: the ERP's refusal, and no rows.
    await setDate(block, 'dateTo', '2026-09-30');
    await expect(block.getByTestId('erp-query-error')).toBeVisible({ timeout: 30000 });
    await expect(table(block)).toHaveCount(0);
    await setDate(block, 'dateTo', '2026-10-31');
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

    // Bob keeps the warehouse: the trial balance is refused him, stock balance has no cost.
    block = await reconnect(page, 'bob');
    await expect(block.getByTestId('erp-schema-error')).toContainText(
      'Your Cash Gear ERP account has no access to this data.',
      { timeout: 30000 },
    );
    await expect(table(block)).toHaveCount(0);
    await block
      .getByTestId('erp-schema-error')
      .getByLabel('Data', { exact: true })
      .selectOption({ label: REPORT_LABELS.stockBalance.en });
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await expect(headerOf(block, 'quantity')).toBeVisible();
    await expect(headerOf(block, 'cost')).toHaveCount(0);
    await expect(headerOf(block, 'unitCost')).toHaveCount(0);
    await expect(cellOf(totalsOf(block), 'quantity')).not.toHaveText('');
    await expect(totalsOf(block).locator('td[data-field="cost"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
  }
});

test('a build asking for connectors without kinds is listed no report, and a report’s query without parameters is refused', async ({
  page,
}) => {
  test.setTimeout(240000);
  const scene = await erp12Scene(page, 'Kinds', cloud.signer);
  try {
    const list = async (token: string, kinds: string | null) => {
      const answer = await fetch(
        `${ERP_API}/api/connect/Connectors${kinds === null ? '' : `?kinds=${kinds}`}`,
        { headers: { Origin: APP_ORIGIN, 'X-Connect-Session': token } },
      );
      expect(answer.status).toBe(200);
      return ((await answer.json()) as { connectors: { id: string; kind: string }[] }).connectors;
    };
    const reportsOf = (listed: { id: string; kind: string }[]) =>
      listed.filter((c) => c.kind === 'report').map((c) => c.id);
    const alice = await erpToken('alice', scene.workspaceId, scene.erpLinkId);
    // As 0.11.0 asks: its entities only.
    expect(reportsOf(await list(alice, null))).toEqual([]);
    expect((await list(alice, null)).map((c) => c.id)).toEqual([
      'vendors',
      'customers',
      'itemsOnHand',
    ]);
    expect(reportsOf(await list(alice, 'entity,report'))).toEqual([
      'apAging',
      'stockBalance',
      'trialBalance',
    ]);
    expect(
      reportsOf(
        await list(await erpToken('bob', scene.workspaceId, scene.erpLinkId), 'entity,report'),
      ),
    ).toEqual(['stockBalance']);
    expect(
      reportsOf(
        await list(await erpToken('gina', scene.workspaceId, scene.erpLinkId), 'entity,report'),
      ),
    ).toEqual(['apAging']);
    // A report asked as an entity is asked (an older build's query): refused, nothing shown.
    const older = await fetch(`${ERP_API}/api/connect/Connectors/apAging/Query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
        'X-Connect-Session': alice,
      },
      body: JSON.stringify({ filter: {}, cursor: null, pageSize: 50 }),
    });
    expect(older.status).toBe(400);
    expect(((await older.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
      'request.invalid',
    );
    // This build's picker shows the reports under their own heading.
    await showData(erpBlock(page), REPORT_LABELS.stockBalance.en);
    const select = erpBlock(page)
      .getByRole('group', { name: 'View settings' })
      .getByLabel('Data', { exact: true });
    await expect(select.locator('optgroup[label="Reports"] option')).toHaveText([
      REPORT_LABELS.apAging.en,
      REPORT_LABELS.stockBalance.en,
      REPORT_LABELS.trialBalance.en,
    ]);
  } finally {
    await scene.api.dispose();
  }
});

test('nothing stored: after each report is shown, none of its values is in any store, the document, its versions or search', async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const scene = await erp12Scene(page, 'Keeper twelve', cloud.signer);
  try {
    const block = erpBlock(page);
    const markers = await erpMarkers();
    // Each report's rows hold the ERP's made-up words: vendors', items' and accounts' names.
    await expect(table(block)).toContainText('Qorvath Lantern Trading', { timeout: 30000 });
    await showData(block, REPORT_LABELS.stockBalance.en);
    await expect(table(block)).toContainText('Qorvath olive oil 1 L');
    await showData(block, REPORT_LABELS.trialBalance.en);
    await setDate(block, 'dateFrom', '2026-10-01');
    await setDate(block, 'dateTo', '2026-10-31');
    await expect(table(block)).toContainText('Ystrelle cost of goods sold', { timeout: 30000 });
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    const device = await deviceDump(page);
    expect(found(device.build, markers), "the app's own files").toEqual([]);
    expect(device.text, 'the page is on this device').toContain('Keeper twelve page');
    expect(found(device.text, markers), device.summary.join('; ')).toEqual([]);
    const server = await serverPage(scene.api, id, 'Payables to settle.');
    const serverText = [server.json, server.updates, ...server.versions].join('\n');
    expect(found(serverText, markers)).toEqual([]);
    // The block holds only what the person chose: the report and its two dates.
    expect(server.json).toContain('trialBalance');
    expect(server.json).toContain('2026-10-01');
    for (const word of ['Qorvath', 'Ystrelle', 'زمرّدان']) {
      expect(await searchHits(scene.api, scene.workspaceId, word)).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
  }
});
