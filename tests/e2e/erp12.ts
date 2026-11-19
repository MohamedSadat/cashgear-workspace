// Phase 12's ERP report blocks (INTEGRATIONS.md, "Reports"; IMPLEMENTATION_PLAN.md, M12.6) for the
// report spec, the accessibility spec and the Arabic walk: a workspace kept on an account, linked
// to the mock ERP, and a page holding an ERP block on AP aging by vendor connected as alice (an
// accounts manager: every report, with cost), its "As of" set to 2026-10-31. Made in English; each
// spec then sets its language and theme, loads the app again and walks the screens through
// `erp12Screens`: AP aging with its parameters and totals, its date's calendar open, stock balance
// with its switch on, and the trial balance over October.
import type { Browser, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { signedInWorkspace } from './database';
import {
  APP_ORIGIN,
  ERP_API,
  blockAttrs,
  connectErp,
  connectTicket,
  erpBlock,
  insertErpBlock,
  linkWorkspace,
  mockErp,
  sessionOf,
  workspaceIdOf,
  type Api,
  type ErpUser,
} from './ecosystem';
import { ar as erpAr, en as erpEn } from '../../packages/erp/src/i18n/catalogues';
import { reportsAr, reportsEn } from '../../packages/erp/src/i18n/reports';

/** The reports' labels, as the mock ERP gives them. */
export const REPORT_LABELS = {
  apAging: { en: 'AP aging by vendor', ar: 'أعمار ديون الموردين' },
  stockBalance: { en: 'Stock balance on a date', ar: 'رصيد المخزون في تاريخ' },
  trialBalance: { en: 'Trial balance', ar: 'ميزان المراجعة' },
} as const;

/** Each parameter's label, as the contract gives them. */
export const PARAMETER_LABELS = {
  asOf: { en: 'As of', ar: 'حتى تاريخ' },
  ageBy: { en: 'Aged by', ar: 'العمر حسب' },
  basis: { en: 'Basis', ar: 'الأساس' },
  vendorGroup: { en: 'Vendor group', ar: 'مجموعة الموردين' },
  siteId: { en: 'Site', ar: 'الموقع' },
  warehouseId: { en: 'Warehouse', ar: 'المخزن' },
  includeZero: { en: 'Include zero balances', ar: 'إظهار الأرصدة الصفرية' },
  dateFrom: { en: 'From', ar: 'من' },
  dateTo: { en: 'To', ar: 'إلى' },
  statement: { en: 'Statement', ar: 'القائمة' },
} as const;

export const words = (language: 'en' | 'ar') => ({
  ...(language === 'ar' ? erpAr : erpEn).erp,
  ...(language === 'ar' ? reportsAr : reportsEn),
});

export const table = (block: Locator) => block.getByTestId('erp-table');
export const parametersOf = (block: Locator) => block.getByTestId('erp-parameters');
export const totalsOf = (block: Locator) => table(block).getByTestId('erp-totals');
export const rowOf = (block: Locator, key: string) =>
  table(block).locator(`tbody tr[data-key="${key}"]`);
export const cellOf = (row: Locator, field: string) => row.locator(`td[data-field="${field}"]`);
export const headerOf = (block: Locator, field: string) =>
  table(block).locator(`thead th[data-field="${field}"]`);

/** A report parameter's control in the bar, by its label in the language shown. */
export function control(block: Locator, name: keyof typeof PARAMETER_LABELS, language = 'en') {
  const label = PARAMETER_LABELS[name][language as 'en' | 'ar'];
  const at = parametersOf(block).locator(`[data-parameter="${name}"]`);
  return name === 'includeZero'
    ? at.getByRole('switch', { name: label })
    : at.getByLabel(label, { exact: true });
}

/** Sets a date parameter as a person types it (English: M/d/yyyy), then Enter. */
export async function setDate(block: Locator, name: keyof typeof PARAMETER_LABELS, iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const input = control(block, name);
  await input.fill(`${m}/${d}/${y}`);
  await input.press('Enter');
}

/** The block's `parameters` attribute, read from the editor's own document. */
export async function heldParameters(page: Page, nth = 0): Promise<unknown> {
  const attrs = (await blockAttrs(page, 'erpView'))[nth];
  const text = attrs?.parameters;
  return typeof text === 'string' ? JSON.parse(text) : null;
}

/** Shows other data in the block, by its label (an editor's "Data" list). */
export async function showData(block: Locator, label: string, language: 'en' | 'ar' = 'en') {
  const w = words(language);
  await block
    .getByRole('group', { name: w.settings })
    .getByLabel(w.dataLabel, { exact: true })
    .selectOption({ label });
  await expect(block.getByTestId('erp-title')).toHaveText(label, { timeout: 30000 });
  await expect(table(block)).toBeVisible({ timeout: 30000 });
}

/** Every Query the page sends to the ERP, with its connector and body, as it is sent. */
export function watchQueries(page: Page) {
  const sent: { connector: string; body: Record<string, unknown> }[] = [];
  page.on('request', (request) => {
    const m = /\/api\/connect\/Connectors\/([^/]+)\/Query$/.exec(request.url());
    if (!m || request.method() !== 'POST') return;
    sent.push({
      connector: decodeURIComponent(m[1]!),
      body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
    });
  });
  return sent;
}

/** A session of an ERP user from the app's origin, as the page's own would be. */
export async function erpToken(user: ErpUser, workspaceId: string, erpLinkId: string) {
  const ticket = await connectTicket(user, workspaceId, erpLinkId);
  const redeemed = await fetch(`${ERP_API}/api/connect/Session/Redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ ticket, workspaceId }),
  });
  expect(redeemed.status).toBe(200);
  return ((await redeemed.json()) as { token: string }).token;
}

/** A report's whole answer at the ERP, with a session: what the block must show. */
export async function reportAt(token: string, connector: string, parameters: unknown) {
  const answer = await fetch(`${ERP_API}/api/connect/Connectors/${connector}/Query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN, 'X-Connect-Session': token },
    body: JSON.stringify({ filter: {}, cursor: null, pageSize: 1000, parameters }),
  });
  expect(answer.status).toBe(200);
  return (await answer.json()) as {
    records: { id: string; key: string; values: Record<string, unknown> }[];
    total: number;
    totals?: Record<string, string>;
  };
}

/** A decimal as the block writes it in English: grouped, every digit kept. */
export function inEnglish(text: string): string {
  const [whole, fraction] = text.replace('-', '').split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = text.startsWith('-') && /[1-9]/.test(text) ? '-' : '';
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export interface Erp12Scene {
  api: Api;
  workspaceId: string;
  erpLinkId: string;
  names: string[];
}

/** The scene, made in English; the page left open on AP aging as of 2026-10-31. */
export async function erp12Scene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<Erp12Scene> {
  await mockErp.reset();
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  const link = await linkWorkspace(api, workspaceId, space);
  await newPage(page, `${name} page`);
  await page.keyboard.type('Payables to settle.');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  const block = erpBlock(page);
  await connectErp(page, block, 'alice');
  const picker = block.getByTestId('erp-choose');
  await expect(picker.locator('[data-kind="report"]')).toHaveCount(3);
  await picker.locator('[data-connector="apAging"]').click();
  await expect(table(block)).toBeVisible({ timeout: 30000 });
  // Every vendor's row on one page, so a vendor's is shown whatever its place.
  await block
    .getByRole('group', { name: erpEn.erp.settings })
    .getByLabel(erpEn.erp.pageSize, { exact: true })
    .selectOption('1000');
  await setDate(block, 'asOf', '2026-10-31');
  await expect.poll(() => heldParameters(page)).toEqual({ asOf: '2026-10-31' });
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return {
    api,
    workspaceId,
    erpLinkId: link.erpLinkId,
    names: [account.name, account.email, space, 'Kit Trading', 'Alice Haddad'],
  };
}

/** What the ERP block shows as its own data, for the Arabic walk: theirs. */
export const ERP12_THEIRS = [
  '.cgw-erp-table tbody',
  '.cgw-erp-table tfoot td',
  '[data-parameter="vendorGroup"] option',
  '[data-parameter="siteId"] option',
  '[data-parameter="warehouseId"] option',
];

/** The scene's report screens in the app's language now, each handed to `check` once drawn. */
export async function erp12Screens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string, block: Locator) => Promise<void>,
) {
  const w = words(language);
  const block = erpBlock(page);
  await connectErp(page, block, 'alice');
  await expect(table(block)).toBeVisible({ timeout: 30000 });
  await expect(totalsOf(block)).toBeVisible();
  await expect(headerOf(block, 'band0')).toHaveText(language === 'ar' ? 'غير مستحق' : 'Not due');
  await check('AP aging, its parameters and totals', block);
  // The date's calendar, open.
  await parametersOf(block)
    .locator('[data-parameter="asOf"]')
    .getByRole('button', { name: w.dateOpen })
    .click();
  await expect(page.getByRole('dialog', { name: w.dateCalendar })).toBeVisible();
  await check('AP aging, its date’s calendar', block);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: w.dateCalendar })).toHaveCount(0);
  // Stock balance with zero balances shown.
  await showData(block, REPORT_LABELS.stockBalance[language], language);
  await control(block, 'includeZero', language).click();
  await expect(control(block, 'includeZero', language)).toBeChecked();
  await expect(totalsOf(block)).toBeVisible({ timeout: 30000 });
  await check('Stock balance, zero balances shown', block);
  // The trial balance over its default period, then back to AP aging.
  await showData(block, REPORT_LABELS.trialBalance[language], language);
  await expect(totalsOf(block)).toBeVisible({ timeout: 30000 });
  await check('Trial balance', block);
  await showData(block, REPORT_LABELS.apAging[language], language);
}

/**
 * English of the app's own inside an ERP block in Arabic: every visible text node, label,
 * placeholder and tooltip in it outside what the ERP holds (`within`) and the names given. The
 * page-wide walk leaves a page's own content, and so its blocks, to their writer.
 */
export async function englishIn(
  block: Locator,
  screen: string,
  theirs: { within: string[]; names: string[] },
): Promise<string[]> {
  return block.evaluate(
    (root, { screen, theirs }) => {
      const keys = /\b(Cash Gear (?:Sheet|ERP|Workspace)|ERP|CSV)\b/g;
      const strip = (text: string) => {
        let out = text;
        for (const name of theirs.names) out = out.split(name).join(' ');
        return out.replace(keys, ' ');
      };
      const own = theirs.within.join(', ');
      const visible = (el: Element) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const found: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(own) || parent.closest('[aria-hidden="true"]')) continue;
        if (!visible(parent) && parent.tagName !== 'OPTION') continue;
        const text = strip(node.textContent ?? '');
        if (/[A-Za-z]{2,}/.test(text)) found.push(`${screen}: text "${node.textContent!.trim()}"`);
      }
      for (const el of root.querySelectorAll('[aria-label], [placeholder], [title]')) {
        if (el.closest(own)) continue;
        for (const name of ['aria-label', 'placeholder', 'title']) {
          const value = el.getAttribute(name);
          if (value && /[A-Za-z]{2,}/.test(strip(value)))
            found.push(`${screen}: ${name} "${value}" on <${el.tagName.toLowerCase()}>`);
        }
      }
      return found;
    },
    { screen, theirs },
  );
}
