// Phase 16 (M16.1 to M16.3): forms as people use them. A member answers a form offline in the app,
// page by page, and the row reaches the database once online, marked by its form; anyone with the
// form's link answers it on the Sites process (5290) with script off, in English and Arabic, and
// reads nothing of the database; a link switched off, then deleted, takes no answer and says so;
// an answer by the link starts the rule on "a form is answered" once and its row shows in an open
// tab; the app's form screens under Axe and in Arabic.
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { expectInRow, fullPage, grid, rowOf, showView } from './database';
import { englishIn } from './erp12';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  P,
  STAGE,
  answerFields,
  rowsByTitle,
  saveRule,
  seedForm,
} from '../../bench/phase16-seed.mjs';

test.skip(desktop, 'Seeded and read through browser profiles; the desktop runs the same views');
test.describe.configure({ mode: 'serial' });

type Api = Awaited<ReturnType<typeof apiSession>>;
type Seeded = Awaited<ReturnType<typeof seedForm>>;

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:5280';

let account: TestAccount;
let api: Api;
let seeded: Seeded;
let arabic: Seeded;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  account = await newAccount('Former');
  api = await apiSession(account);
  seeded = await seedForm(api, { name: 'Forms' });
  arabic = await seedForm(api, { name: 'نماذج', title: 'التسجيلات', language: 'ar' });
});
test.afterAll(async () => {
  await api?.dispose();
});

async function openDatabase(page: Page, view = 'Sign-up form') {
  await page.goto('/');
  await signIn(page, account, `/#/p/${seeded.databaseId}`);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30_000 });
  await expect(fullPage(page)).toBeVisible({ timeout: 30_000 });
  await showView(fullPage(page), view);
}

/** A link's answer as a browser's form posts it, to the API (the Sites process's last step). */
async function answerByLink(token: string, fields: Record<string, string>) {
  return fetch(`${API}/api/v1/forms/${token}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

/** A browser with script off. */
async function noScript(browser: Browser, locale = 'en-US') {
  const context = await browser.newContext({ javaScriptEnabled: false, locale });
  return { context, page: await context.newPage() };
}

test('a member answers a form offline, page by page, and the row reaches the database once online', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  const form = fullPage(page);
  await expect(form.getByRole('heading', { name: 'Sign up' })).toBeVisible();
  // The form's toolbar has nothing of rows.
  await expect(form.getByRole('button', { name: 'Filter' })).toHaveCount(0);

  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(syncStatus(page)).toHaveText(/^Offline/);

  await form.getByLabel('Your name').fill('Offline Omar');
  await form.getByLabel('Email').fill('omar@example.com');
  // The Stage question shows two of its three options.
  await expect(form.getByLabel('Stage').locator('option')).toHaveText([
    'Choose…',
    'New',
    'Returning',
  ]);
  await form.getByLabel('Stage').selectOption(STAGE.fresh);
  await form.getByRole('button', { name: 'Next' }).click();
  await expect(form.getByRole('heading', { name: 'Seats' })).toBeVisible();
  // A required question: refused until answered.
  await form.getByRole('button', { name: 'Next' }).click();
  await expect(form.getByRole('alert')).toContainText('Seats: Answer this question.');
  await form.getByLabel('Seats').fill('3');
  await form.getByRole('button', { name: 'Next' }).click();
  await form.getByLabel('Notes').fill('Typed offline');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form).toContainText('We have it, thank you');

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60_000 });
  await expect
    .poll(
      async () => (await rowsByTitle(api, seeded.databaseId)).get('Offline Omar')?.formId ?? null,
      {
        timeout: 30_000,
      },
    )
    .toBe(seeded.formId);
  const row = (await rowsByTitle(api, seeded.databaseId)).get('Offline Omar');
  expect(row.values).toMatchObject({
    [P.email]: 'omar@example.com',
    [P.stage]: STAGE.fresh,
    [P.seats]: 3,
    [P.notes]: 'Typed offline',
  });
  // A member's answer is theirs (a link's is nobody's).
  expect(row.createdBy).toMatch(/^[0-9a-f-]{36}$/);
});

test('anyone with the link answers it with script off and reads nothing of the database', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await noScript(browser);
  try {
    await page.goto(seeded.url!);
    await expect(page.getByRole('heading', { name: 'Sign up', level: 1 })).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('Secret stage');
    expect(html).not.toContain('Owner');
    // Nothing typed: the browser itself keeps the page (its required questions), no script needed.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('input:invalid')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Seats' })).toHaveCount(0);
    await page.getByLabel('Your name').fill('Linked Lina');
    await page.getByLabel('Email').fill('lina@example.com');
    await page.getByLabel('Stage').selectOption(STAGE.fresh);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Seats' })).toBeVisible();
    await page.getByLabel('Seats').fill('2');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Notes').fill('From the link');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page).toHaveURL(/\/_form\/[A-Za-z0-9_-]+\/done$/);
    await expect(page.locator('main')).toContainText('We have it, thank you');
  } finally {
    await context.close();
  }
  const row = (await rowsByTitle(api, seeded.databaseId)).get('Linked Lina');
  expect(row.formId).toBe(seeded.formId);
  expect(row.createdBy).toBeNull();
  expect(row.values).toMatchObject({
    [P.email]: 'lina@example.com',
    [P.seats]: 2,
    [P.notes]: 'From the link',
  });

  // The same pages under Axe (Axe needs a script of its own; the pages have none).
  const axe = await browser.newContext();
  try {
    const page = await axe.newPage();
    await page.goto(seeded.url!);
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
    // The server's own check, drawn when a browser sends the page unanswered.
    await page.locator('form').evaluate((form) => ((form as HTMLFormElement).noValidate = true));
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('alert')).toContainText('Your name: Answer this question.');
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
    await page.goto(seeded.url! + '/done');
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
  } finally {
    await axe.close();
  }
});

test('a link in Arabic, with script off', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await noScript(browser, 'ar-SA');
  try {
    await page.goto(arabic.url!);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'التسجيل', level: 1 })).toBeVisible();
    // The link's own words, in Arabic; the person's own (the form's) beside them.
    const theirs = [
      'التسجيل',
      'أخبرنا عنك',
      'اسمك',
      'Email',
      'نراسلك بشأن هذا فقط',
      'Stage',
      'New',
      'Returning',
      'Notes',
      'Seats',
      'Cash Gear Workspace',
    ];
    const english = async () =>
      page.locator('body').evaluate((body, names) => {
        let text = body.innerText;
        for (const name of names) text = text.split(name).join(' ');
        return text.match(/[A-Za-z]{2,}/g) ?? [];
      }, theirs);
    expect(await english()).toEqual([]);
    await page.getByLabel('اسمك').fill('سارة');
    await page.getByLabel('Email').fill('sara@example.com');
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.getByRole('button', { name: 'إرسال' }).click();
    await expect(page.locator('main')).toContainText('وصلتنا إجابتك، شكرًا');
    await expect(page.getByRole('link', { name: 'أرسل إجابة أخرى' })).toBeVisible();
  } finally {
    await context.close();
  }
  expect((await rowsByTitle(api, arabic.databaseId)).get('سارة')?.formId).toBe(arabic.formId);
  // The server's own check, in Arabic (a browser sending the page unanswered).
  const scripted = await browser.newContext({ locale: 'ar-SA' });
  try {
    const page = await scripted.newPage();
    await page.goto(arabic.url!);
    await page.locator('form').evaluate((form) => ((form as HTMLFormElement).noValidate = true));
    await page.getByRole('button', { name: 'التالي' }).click();
    await expect(page.getByRole('alert')).toContainText('أجب عن هذا السؤال.');
    await expect(page.getByRole('alert')).toContainText('راجع هذه الإجابات:');
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
  } finally {
    await scripted.close();
  }
});

test('an answer by the link starts its rule once, its row shown in an open tab', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'Seen',
    trigger: { kind: 'formAnswered', viewId: seeded.formId },
    steps: [{ kind: 'set', values: { [P.notes]: 'seen by the rule' } }],
  });
  await openDatabase(page, 'Table');
  await expect(grid(fullPage(page))).toBeVisible();
  const answered = await answerByLink(seeded.token!, answerFields('Ruled Rami'));
  expect(answered.status).toBe(303);
  expect(answered.headers.get('location')).toMatch(/\/done$/);
  await expectInRow(fullPage(page), rowOf(fullPage(page), 'Ruled Rami'), 'seen by the rule');
  // Created by shows the form, not a person (the column is the table's when it is shown).
  const runs = await api.get(
    `/api/v1/databases/${seeded.databaseId}/automations/${rule.id}/runs?limit=50`,
  );
  expect(runs.runs.filter((r: { rowTitle: string }) => r.rowTitle === 'Ruled Rami')).toHaveLength(
    1,
  );
});

test('a link switched off takes no answer and says so; deleted, its address is gone', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  await fullPage(page).getByRole('button', { name: 'Share form' }).click();
  const share = page.getByRole('dialog', { name: 'Share form' });
  await expect(share.getByLabel('Link', { exact: true })).toHaveValue(seeded.url!);
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await share.getByRole('switch', { name: 'Taking answers' }).click();
  await expect(share).toContainText('Switched off');

  const { context, page: reader } = await noScript(browser);
  try {
    await reader.goto(seeded.url!);
    await expect(reader.locator('main')).toContainText('This form is not taking answers.');
    const before = (await rowsByTitle(api, seeded.databaseId)).size;
    const refused = await answerByLink(seeded.token!, answerFields('Too Late'));
    expect(refused.status).toBe(303);
    expect((await rowsByTitle(api, seeded.databaseId)).size).toBe(before);

    await share.getByRole('button', { name: 'Delete link' }).click();
    await expect(share.getByRole('button', { name: 'Make a link' })).toBeVisible();
    expect((await reader.goto(seeded.url!))?.status()).toBe(404);
    expect((await rowsByTitle(api, seeded.databaseId)).has('Too Late')).toBe(false);
  } finally {
    await context.close();
  }
  // A new link is a new address.
  await share.getByRole('button', { name: 'Make a link' }).click();
  await expect(share.getByLabel('Link', { exact: true })).not.toHaveValue(seeded.url!);
});

test("the form's screens under Axe and in Arabic", async ({ page }) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  const form = fullPage(page);
  expect(
    (await new AxeBuilder({ page }).include('.cgw-db-form').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Edit questions' }).click();
  await expect(form.getByRole('region', { name: 'Page 2' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('.cgw-db-form').withTags(WCAG).analyze()).violations,
  ).toEqual([]);

  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(fullPage(page)).toBeVisible({ timeout: 30_000 });
  await showView(fullPage(page), 'Sign-up form');
  const names = [
    'Sign-ups',
    'Sign-up form',
    'Table',
    'Sign up',
    'Tell us about you',
    'Your name',
    'We write only about this',
    'Email',
    'Stage',
    'New',
    'Returning',
    'Secret stage',
    'Seats',
    'Notes',
    'Owner',
    'Name',
    'We have it, thank you',
    'Former',
    'English',
  ];
  const block = fullPage(page).locator('.cgw-db-form');
  const none = ['.cgw-db-form-none'];
  expect(await englishIn(block, 'answer', { within: none, names })).toEqual([]);
  await fullPage(page).getByRole('button', { name: 'تحرير الأسئلة' }).click();
  expect(await englishIn(block, 'edit', { within: none, names })).toEqual([]);
});
