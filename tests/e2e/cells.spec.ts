// Phase 8 (M8.3), bulk cell editing, in Chrome and Edge and on the built desktop app. Written in
// the cells stream and not run there: the parent runs it in the phase's proof, against the e2e
// server stack (scripts/server-stack.mjs --e2e) for the synced tests.
//
// - 1,000 cells pasted from Excel-shaped and from Sheet-shaped TSV (100 rows of 10 columns: 3 rows
//   made first, 97 added), the clipboard given by `page.evaluate` (a `ClipboardEvent` with its own
//   `DataTransfer`, on the table's grid as the browser sends it). Excel's cells are written as it
//   shows them in the browser's own locale (thousands, a currency, an accounting negative, the
//   short date) and a member by email; each value is read by the paste's reading and the
//   conversion table, the few cells neither reads left and counted; the server's records
//   hold them; a second device of the same person shows them; Undo takes them back there too. The
//   paste's two budgets are timed and attached (shown ≤ 500 ms, the server ≤ 5 s); bench/phase8
//   gates them (bench/phase8-cells.mjs).
// - A rectangle copied from the table read back as TSV and HTML (by the copy event, and in Chrome
//   and Edge by Ctrl+C and the system clipboard too).
// - Arabic and dark: a selection right to left, a paste and its notice in Arabic, Axe on the table
//   with a selection and the notice.
// - Board columns and gallery cards moved by the mouse keep their order after a reload.
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, watchErrors } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  APP,
  addProperty,
  fullPage,
  grid,
  newDatabase,
  newRow,
  otherDevice,
  rowOf,
  showView,
  signedInWorkspace,
  signers,
  signOutDesktop,
  treeRow,
} from './database';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The properties a paste fills after the title, as added from the table's ＋. */
const COLUMNS: [string, string][] = [
  ['Text', 'Notes'],
  ['Number', 'Amount'],
  ['Date', 'Due'],
  ['Checkbox', 'Done'],
  ['Select', 'Stage'],
  ['Multi-select', 'Tags'],
  ['URL', 'Site'],
  ['Email', 'Mail'],
  ['Person', 'Owner'],
];
const ROWS = 100;
const STAGES = ['Backlog', 'Doing', 'Done'];
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A cell as one program writes it, and the value the paste makes of it. */
interface Cell {
  text: string;
  /**
   * The stored value expected (null: no value), `{ option }` or `{ options }` by name, `{ person }`
   * (the signed-in member), or `refused`: the cell is left as it was.
   */
  value: unknown;
}
type Line = Record<string, Cell>;

/** What the device shows, as Excel and Sheet show it: by the browser's own locale. */
interface Device {
  locale: string;
  email: string;
}

/**
 * Tab-separated text as Excel writes it: what cells show in the device's locale (thousands, a
 * currency, an accounting negative, the short date), a line break in quotes, CRLF rows. A few
 * cells no reading takes (words in a number, a date in words) are left as they were.
 */
function excelLine(i: number, device: Device): Line {
  const amount = 1000.5 + i;
  const day = 1 + (i % 28);
  const money = (style: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(device.locale, { style: 'currency', currency: 'USD', ...style });
  return {
    Name: { text: `Excel ${i}`, value: `Excel ${i}` },
    Notes:
      i % 10 === 0
        ? { text: '"Line one\nLine two"', value: 'Line one\nLine two' }
        : { text: `Note ${i}`, value: `Note ${i}` },
    Amount:
      i % 25 === 7
        ? { text: 'about ten', value: 'refused' }
        : i % 5 === 0
          ? { text: money({}).format(amount), value: amount }
          : i % 5 === 1
            ? { text: money({ currencySign: 'accounting' }).format(-amount), value: -amount }
            : {
                text: new Intl.NumberFormat(device.locale, { minimumFractionDigits: 2 }).format(
                  amount,
                ),
                value: amount,
              },
    Due:
      i % 20 === 3
        ? { text: 'next week', value: 'refused' }
        : i % 2
          ? {
              text: new Intl.DateTimeFormat(device.locale, {
                calendar: 'gregory',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
              }).format(new Date(2026, 10, day)),
              value: { start: `2026-11-${pad(day)}` },
            }
          : { text: `2026-11-${pad(day)}`, value: { start: `2026-11-${pad(day)}` } },
    Done: i % 2 ? { text: 'TRUE', value: true } : { text: 'FALSE', value: null },
    Stage: { text: STAGES[i % 3], value: { option: STAGES[i % 3] } },
    Tags:
      i % 4 === 0
        ? { text: 'Finance, Legal', value: { options: ['Finance', 'Legal'] } }
        : { text: 'Ops', value: { options: ['Ops'] } },
    Site: { text: `https://example.com/${i}`, value: `https://example.com/${i}` },
    Mail: { text: `user${i}@example.com`, value: `user${i}@example.com` },
    // A member by email, in any case.
    Owner: {
      text: i % 2 ? device.email.toUpperCase() : device.email,
      value: { person: true },
    },
  };
}

/** Tab-separated text as Sheet writes it: Latin digits, quotes around a quote, CRLF rows. */
function sheetLine(i: number, device: Device): Line {
  return {
    Name: { text: `Sheet ${i}`, value: `Sheet ${i}` },
    Notes:
      i % 10 === 0
        ? { text: '"She said ""yes"""', value: 'She said "yes"' }
        : { text: `Sheet note ${i}`, value: `Sheet note ${i}` },
    Amount:
      i % 25 === 9
        ? { text: 'n/a', value: 'refused' }
        : i % 4 === 0
          ? // A percent on a property not formatted as one is the number as written.
            { text: `${i}%`, value: i }
          : { text: `${2000 + i}.25`, value: 2000.25 + i },
    Due:
      i % 20 === 5
        ? { text: `Dec ${1 + (i % 28)}, 2026`, value: 'refused' }
        : {
            text: `2026-12-${pad(1 + (i % 28))} 09:30`,
            value: { start: `2026-12-${pad(1 + (i % 28))}T09:30:00Z` },
          },
    Done: i % 3 ? { text: 'FALSE', value: null } : { text: 'TRUE', value: true },
    Stage: { text: STAGES[(i + 1) % 3], value: { option: STAGES[(i + 1) % 3] } },
    Tags: { text: 'Finance', value: { options: ['Finance'] } },
    Site: { text: `https://sheet.example/${i}`, value: `https://sheet.example/${i}` },
    Mail: { text: `sheet${i}@example.com`, value: `sheet${i}@example.com` },
    Owner: { text: device.email, value: { person: true } },
  };
}

const NAMES = ['Name', ...COLUMNS.map(([, name]) => name)];
const tsv = (lines: Line[]) =>
  lines.map((line) => `${NAMES.map((n) => line[n].text).join('\t')}\r\n`).join('');
const refusedIn = (lines: Line[]) =>
  lines.reduce((n, line) => n + NAMES.filter((name) => line[name].value === 'refused').length, 0);

/** Dispatches a paste on the table's grid, as the browser does on Ctrl+V; times the two budgets. */
async function paste(scope: Locator, text: string, html = '') {
  return grid(scope).evaluate(
    (el, [plain, rich]) => {
      const data = new DataTransfer();
      if (plain) data.setData('text/plain', plain);
      if (rich) data.setData('text/html', rich);
      (el as HTMLElement).focus();
      const start = performance.now();
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return start;
    },
    [text, html] as const,
  );
}

/** The clipboard a copy on the table's grid writes (the copy event, as Ctrl+C sends it). */
async function copied(scope: Locator) {
  return grid(scope).evaluate((el) => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      text: data.getData('text/plain'),
      html: data.getData('text/html'),
    };
  });
}

/** The table's first row, first cell, by the keys. */
async function firstCell(scope: Locator) {
  const g = grid(scope);
  await g.focus();
  await g.press('Control+Home');
  await g.press('ArrowDown');
  await expect(g).toHaveAttribute('aria-activedescendant', /-c0-0$/);
}

/**
 * A paste dispatched on the grid and timed in the page alone (no round trip to the test in
 * between): milliseconds from the event until every row in the window shows a title starting
 * with `prefix` and the paste's notice says what it did. Its epoch start, for the server's budget.
 */
async function pasteTimed(scope: Locator, text: string, prefix: string) {
  return grid(scope).evaluate(
    (el, [plain, title]) =>
      new Promise<{ shown: number; epoch: number }>((resolve, reject) => {
        const data = new DataTransfer();
        data.setData('text/plain', plain);
        (el as HTMLElement).focus();
        const start = performance.now();
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
        const check = () => {
          const titles = [...el.querySelectorAll('.cgw-tbody [role="row"] .cgw-title-text')];
          const notice = el.closest('.cgw-db')?.querySelector('.cgw-db-cell-notice');
          if (
            notice?.textContent?.startsWith('Pasted:') &&
            titles.length &&
            titles.every((t) => t.textContent?.startsWith(title))
          )
            return resolve({
              shown: performance.now() - start,
              epoch: performance.timeOrigin + start,
            });
          if (performance.now() - start > 60000) return reject(new Error('The paste did not show'));
          requestAnimationFrame(check);
        };
        check();
      }),
    [text, prefix] as const,
  );
}

/** Whether the server's rows hold every value of the lines (by name, as the API reads them). */
async function serverHolds(
  api: Awaited<ReturnType<typeof apiSession>>,
  databaseId: string,
  lines: Line[],
) {
  const { rows } = await api.get(`/api/v1/databases/${databaseId}/rows?limit=500`);
  const live = rows.filter((r: { trashedAt: string | null }) => !r.trashedAt);
  if (live.length !== lines.length) return false;
  const workspaceId = live[0]?.workspaceId;
  const database = (await api.get(`/api/v1/workspaces/${workspaceId}/tree`)).databases.find(
    (d: { id: string }) => d.id === databaseId,
  );
  const prop = (name: string) => database.properties.find((p: { name: string }) => p.name === name);
  const option = (name: string, label: string) =>
    prop(name).options.find((o: { name: string }) => o.name === label)?.id;
  for (const line of lines) {
    const row = live.find((r: { title: string }) => r.title === line.Name.value);
    if (!row) return false;
    for (const name of NAMES.slice(1)) {
      const { value } = line[name];
      if (value === 'refused') continue;
      const got = row.values[prop(name).id] ?? null;
      if (value && typeof value === 'object' && 'person' in value) {
        if (!Array.isArray(got) || got.length !== 1) return false;
        continue;
      }
      const want =
        value && typeof value === 'object' && 'option' in value
          ? option(name, (value as { option: string }).option)
          : value && typeof value === 'object' && 'options' in value
            ? (value as { options: string[] }).options.map((o) => option(name, o))
            : value;
      if (JSON.stringify(got) !== JSON.stringify(want)) return false;
    }
  }
  return true;
}

test('1,000 cells pasted from Excel and from Sheet: converted, on the server and a second device, taken back by Undo', async ({
  page,
  authUrlFile,
}, testInfo) => {
  test.setTimeout(420000);
  const errors = watchErrors(page);
  const account = await newAccount('Cell Paster');
  await signedInWorkspace(page, account, 'Cells', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Empty database', { title: 'Pasted' });
  const db = fullPage(page);
  for (const [type, name] of COLUMNS) await addProperty(page, type, name);
  // A database made from the sidebar starts with no rows: three, so the paste both changes rows
  // (and Undo gives their titles back) and adds the rest.
  const BEFORE = ['First', 'Second', 'Third'];
  for (const title of BEFORE) await newRow(page, title);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const api = await apiSession(account);
  const other = await otherDevice(
    desktop ? await cloud.signer() : page.context().browser()!,
    account,
  );
  try {
    await treeRow(other.page, 'Pasted').click({ timeout: 30000 });
    const there = fullPage(other.page);
    await expect(there.locator('.cgw-table-foot')).toHaveText('Rows: 3', { timeout: 30000 });

    // Excel and Sheet show values in the device's language, which the paste reads by.
    const device: Device = {
      locale: await page.evaluate(() => navigator.language),
      email: account.email,
    };
    for (const [program, make] of [
      ['Excel', excelLine],
      ['Sheet', sheetLine],
    ] as const) {
      const lines = Array.from({ length: ROWS }, (_, i) => make(i, device));
      await firstCell(db);
      const { shown, epoch } = await pasteTimed(db, tsv(lines), `${program} `);
      const notice = db.locator('.cgw-db-cell-notice');
      await expect(notice).toContainText('Rows added: 97.');
      await expect(notice).toContainText(
        `Values their property cannot read, left as they were: ${refusedIn(lines)}.`,
      );
      await expect(db.locator('.cgw-table-foot')).toHaveText(`Rows: ${ROWS}`);
      // The server holds every converted value: from the paste event (the page's clock, in epoch
      // milliseconds) to the first answer that holds them all.
      let held = 0;
      await expect
        .poll(
          async () => {
            const done = await serverHolds(api, databaseId, lines);
            if (done) held = Date.now();
            return done;
          },
          { timeout: 60000, intervals: [200] },
        )
        .toBe(true);
      const server = Math.round(held - epoch);
      testInfo.annotations.push({
        type: 'budget',
        description: `${program}: 1,000 cells shown in ${Math.round(shown)} ms (≤ 500), on the server in about ${server} ms (≤ 5000)`,
      });
      // The second device shows them.
      await expect(there.locator('.cgw-table-foot')).toHaveText(`Rows: ${ROWS}`, {
        timeout: 30000,
      });
      await expect(
        grid(there)
          .locator('.cgw-title-text', { hasText: `${program} 0` })
          .first(),
      ).toBeVisible();

      // Undo: the three rows have their titles back and no values; the rows added go to the trash.
      await notice.getByRole('button', { name: 'Undo' }).click();
      await expect(notice).toContainText('the rows added are in the trash');
      await expect(db.locator('.cgw-table-foot')).toHaveText('Rows: 3');
      await expect(there.locator('.cgw-table-foot')).toHaveText('Rows: 3', { timeout: 30000 });
      for (const title of BEFORE) await expect(rowOf(there, title)).toBeVisible();
      await expect
        .poll(
          async () => {
            const { rows } = await api.get(`/api/v1/databases/${databaseId}/rows?limit=500`);
            return rows
              .filter(
                (r: { trashedAt: string | null; values: object }) =>
                  !r.trashedAt && Object.keys(r.values).length === 0,
              )
              .map((r: { title: string }) => r.title)
              .sort();
          },
          { timeout: 60000, intervals: [300] },
        )
        .toEqual([...BEFORE].sort());
    }
  } finally {
    await api.dispose();
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test('a rectangle copied from the table reads back as TSV and an HTML table, the values as shown', async ({
  page,
  browserName,
}) => {
  const errors = watchErrors(page);
  await createWorkspace(page, 'Copies');
  await newDatabase(page, 'Tasks', { title: 'Copied' });
  const db = fullPage(page);
  await showView(db, 'All tasks');
  // From the first row's title across Status, Assignee and Due, down one row.
  await firstCell(db);
  const g = grid(db);
  for (let i = 0; i < 3; i++) await g.press('Shift+ArrowRight');
  await g.press('Shift+ArrowDown');
  await expect(g.locator('.cgw-tcell.is-selected')).toHaveCount(8);
  const shown = await g.evaluate((el) =>
    [2, 3].map((row) =>
      [0, 1, 2, 3].map((col) => {
        const cell = el.querySelector(`[aria-rowindex="${row}"] [data-col="${col}"]`)!;
        const title = cell.querySelector('.cgw-title-text');
        return ((title ?? cell) as HTMLElement).innerText.trim();
      }),
    ),
  );
  const got = await copied(db);
  expect(got.prevented).toBe(true);
  expect(got.text).toBe(shown.map((line) => `${line.join('\t')}\r\n`).join(''));
  expect(got.html).toContain('<table dir="ltr">');
  for (const text of shown.flat().filter(Boolean)) expect(got.html).toContain(`>${text}<`);

  // Ctrl+C itself, read from the system clipboard (the browsers; the desktop's WebView has no
  // permission prompt to grant here).
  if (!desktop) {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP })
      .catch(() => test.skip(browserName !== 'chromium', 'No clipboard permissions'));
    await g.press('Control+C');
    const system = await page.evaluate(() => navigator.clipboard.readText());
    expect(system.replace(/\r\n/g, '\n')).toBe(got.text.replace(/\r\n/g, '\n'));
  }
  expect(errors).toEqual([]);
});

test('in Arabic and dark: a selection right to left, a paste and its notice, and Axe finds nothing', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('cgw-language', 'ar');
    localStorage.setItem('cgw-theme', 'dark');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-cg-theme', 'dark');
  await page.getByLabel('اسم مساحة العمل').fill('خلايا');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
  // The Tasks template's table ("All tasks": the title, Status, Assignee, Due, Priority).
  await newDatabase(page, 'المهام', { language: 'ar' });
  const db = fullPage(page);
  await showView(db, 'كل المهام');
  await firstCell(db);
  const g = grid(db);
  // Right to left: ArrowLeft takes the next column, which is drawn to the left.
  await g.press('Shift+ArrowLeft');
  await g.press('Shift+ArrowDown');
  await expect(g.locator('.cgw-tcell.is-selected')).toHaveCount(2 * 2);
  const [title, status] = [
    (await g.locator('[aria-rowindex="2"] [data-col="0"]').boundingBox())!,
    (await g.locator('[aria-rowindex="2"] [data-col="1"]').boundingBox())!,
  ];
  expect(status.x).toBeLessThan(title.x);
  await expect(g.locator('[aria-rowindex="2"] [data-col="1"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(g).toHaveAttribute('aria-multiselectable', 'true');
  await g.press('Escape');
  // One line more than the table has rows: the last one is added. Counts are written as the
  // interface's locale writes numbers (Chrome's `ar` writes Latin digits).
  const foot = (await db.locator('.cgw-table-foot').innerText()).replace(/[٠-٩]/g, (d) =>
    String(d.charCodeAt(0) - 0x660),
  );
  const rows = Number(foot.match(/(\d+)/)![1]);
  expect(rows).toBeGreaterThan(0);
  const one = await page.evaluate(() => (1).toLocaleString('ar'));
  await firstCell(db);
  await paste(db, Array.from({ length: rows + 1 }, (_, i) => `السطر ${i + 1}\r\n`).join(''));
  const notice = db.locator('.cgw-db-cell-notice');
  await expect(notice).toContainText(`الصفوف المضافة: ${one}`);
  await expect(db.locator('.cgw-table-foot')).toContainText(String(rows + 1));
  await expect(notice.getByRole('button', { name: 'تراجع' })).toBeVisible();
  await g.press('Shift+ArrowDown');
  const found = await new AxeBuilder({ page })
    .include('.cgw-database-page')
    .withTags(WCAG)
    .analyze();
  expect(found.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(errors).toEqual([]);
});

/** Presses on `from`, moves in steps to `to` (as a hand does), and lets go. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + Math.min(12, box.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(
      start.x + ((to.x - start.x) * i) / steps,
      start.y + ((to.y - start.y) * i) / steps,
    );
  await page.mouse.up();
}

test('board columns and gallery cards moved by the mouse keep their order', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page, 'Orders');
  await newDatabase(page, 'Tasks', { title: 'Board order' });
  let db = fullPage(page);
  await showView(db, 'Board');
  // The columns (`CgKanbanBoard`'s sections) by their group keys.
  const keys = () =>
    db
      .locator('section[data-cg-kanban-column]')
      .evaluateAll((cols) => cols.map((c) => (c as HTMLElement).dataset.cgKanbanColumn));
  const before = await keys();
  // The first column's grip, dragged past the middle of the third column.
  const third = (await db.locator('section[data-cg-kanban-column]').nth(2).boundingBox())!;
  await drag(page, db.locator('[data-cg-kanban-column-grip]').first(), {
    x: third.x + third.width * 0.75,
    y: third.y + 20,
  });
  const after = [before[1], before[2], before[0], ...before.slice(3)];
  await expect.poll(keys).toEqual(after);
  await page.reload();
  db = fullPage(page);
  await showView(db, 'Board');
  await expect.poll(keys).toEqual(after);

  await newDatabase(page, 'Contacts', { title: 'Card order' });
  db = fullPage(page);
  await showView(db, 'Cards');
  const titles = () => db.locator('.cgw-gallery-grid [data-card] .cgw-card-title').allInnerTexts();
  const cards = await titles();
  expect(cards.length).toBeGreaterThanOrEqual(3);
  const last = (await db.locator('.cgw-gallery-grid [data-card]').nth(2).boundingBox())!;
  await drag(page, db.locator('.cgw-gallery-grid [data-card]').first(), {
    x: last.x + last.width * 0.75,
    y: last.y + last.height / 2,
  });
  const moved = [cards[1], cards[2], cards[0], ...cards.slice(3)];
  await expect.poll(titles).toEqual(moved);
  await page.reload();
  db = fullPage(page);
  await showView(db, 'Cards');
  await expect.poll(titles).toEqual(moved);
  expect(errors).toEqual([]);
});
