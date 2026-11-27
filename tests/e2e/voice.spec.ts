// After 0.19.0 (DECISIONS.md, 2026-11-27): a voice note, recorded from the slash menu into a file
// block that plays it. Chrome and Edge are given a fake microphone (a tone) and grant it without
// asking; the desktop app's WebView2 asks the person itself, so these run in the browsers only.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';
import { syncStatus, newAccount } from './cloud';
import { otherDevice, signedInWorkspace, signers } from './database';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});
test.skip(desktop, 'The desktop app asks for the microphone itself');

const cloud = signers();
test.afterEach(async () => {
  await cloud.close();
});

const recorder = (page: Page) =>
  page.getByRole('dialog', { name: /Record a voice note|تسجيل ملاحظة صوتية/ });

/** "Voice note" from the slash menu at a new line, recorded for about two seconds, then inserted. */
async function recordNote(page: Page, query = 'voice', check?: () => Promise<void>) {
  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${query}`);
  const menu = page.getByRole('listbox');
  await expect(menu.getByRole('option').first()).toHaveText(/Voice note|ملاحظة صوتية/);
  await page.keyboard.press('Enter');
  const dialog = recorder(page);
  await expect(dialog).toBeVisible();
  await check?.();
  await dialog.getByRole('button', { name: /^(Record|تسجيل)$/ }).click();
  await expect(dialog.getByRole('timer')).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByRole('timer')).toHaveText('0:02', { timeout: 10000 });
  await dialog.getByRole('button', { name: /^(Stop|إيقاف)$/ }).click();
  await expect(dialog.locator('audio')).toBeVisible();
  await check?.();
  await dialog.getByRole('button', { name: /^(Insert|إدراج)$/ }).click();
  await expect(dialog).toBeHidden();
}

/** The file block's player plays: muted, its time moves on. */
async function plays(page: Page) {
  const player = editor(page).locator('[data-body="file"] audio').last();
  await expect(player).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      () =>
        player.evaluate(async (audio: HTMLAudioElement) => {
          audio.muted = true;
          await audio.play().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 600));
          audio.pause();
          return audio.currentTime;
        }),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0.3);
}

test('a voice note is recorded from the slash menu into a file block that plays', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newPage(page, 'Meeting');
  await page.keyboard.type('Before the note');
  await recordNote(page);
  const block = editor(page).locator('[data-body="file"]').last();
  await expect(block.locator('.cgw-file-name')).toHaveText(
    /^Voice note \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.webm$/,
  );
  await expect(block).toHaveAttribute('data-audio', 'true');
  await plays(page);
  await waitSaved(page);

  // Kept on the device: there after a reload, and still playing.
  await page.reload();
  await expect(editor(page).locator('[data-body="file"] .cgw-file-name')).toHaveText(
    /^Voice note /,
  );
  await plays(page);

  // Cancel keeps nothing.
  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/voice');
  await expect(page.getByRole('listbox').getByRole('option').first()).toHaveText(/Voice note/);
  await page.keyboard.press('Enter');
  await recorder(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(recorder(page)).toBeHidden();
  await expect(editor(page).locator('[data-body="file"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the recorder under Axe, and in Arabic', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newPage(page, 'Axe');
  const problems: string[] = [];
  const check = (label: string) => async () => {
    const result = await new AxeBuilder({ page }).include('.cgw-dialog').withTags(WCAG).analyze();
    problems.push(
      ...result.violations.map((v) => `${label}: ${v.id} (${v.nodes[0]?.target.join(' ')})`),
    );
  };
  await recordNote(page, 'voice', check('en'));
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await recordNote(page, 'صوت', async () => {
    await check('ar')();
    // Nothing in English but what the person named.
    const text = await recorder(page).innerText();
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
  });
  expect(problems, problems.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a voice note reaches another device and plays there', async ({ page, authUrlFile }) => {
  test.setTimeout(180000);
  const errors = watchErrors(page);
  const account = await newAccount('Voice Val');
  await signedInWorkspace(page, account, 'Voice space', authUrlFile, cloud.signer);
  await newPage(page, 'Standup');
  await page.keyboard.type('Notes');
  await recordNote(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  // Uploaded and checked: no notice that it stays on this device.
  await expect(page.locator('.cgw-notice')).toHaveCount(0);

  const other = await otherDevice(page.context().browser()!, account);
  await other.page.getByRole('treeitem', { name: /Standup/ }).click({ timeout: 30000 });
  await expect(editor(other.page).locator('[data-body="file"] .cgw-file-name')).toHaveText(
    /^Voice note /,
    { timeout: 30000 },
  );
  await plays(other.page);
  await other.context.close();
  expect(errors).toEqual([]);
});
