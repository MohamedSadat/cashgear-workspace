// Phase 12's helpers for the database grid as a screen reader gets it (grid-a11y.spec.ts, and the
// grid's screens in a11y.spec.ts and arabic.spec.ts). Chromium's own accessibility tree, read two
// ways:
//
// - CDP's `Accessibility` domain (`getFullAXTree`, and `getPartialAXTree` for one element): roles,
//   names, descriptions, levels, expanded states and the grid's active descendant.
// - What CDP does not hold, Chromium's internal tree as `chrome://accessibility` (Edge:
//   `edge://accessibility`) prints it for another tab: the grid's `ariaRowCount`, each cell's
//   `ariaCellRowIndex` (the row index a screen reader is given, after Chromium's own correction of
//   a row whose index is not above the one before it), a tree grid row's `hierarchicalLevel`,
//   `posInSet` and `setSize`. That page shows a tab's tree only while accessibility is on for every
//   tab: the specs that read it launch the browser with `--force-renderer-accessibility`
//   (`FORCE_ACCESSIBILITY`).
//
// And the table's scenes: a local database of a few hundred rows and the Tasks template grouped,
// made as a person makes them.
import type { BrowserContext, CDPSession, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor } from './helpers';
import { fullPage, grid, newDatabase, showView } from './database';
import { ar as dbAr, en as dbEn } from '../../packages/database/src/i18n/catalogues';
import { gridAr } from '../../packages/database/src/i18n/grid-ar';
import { gridEn } from '../../packages/database/src/i18n/grid-en';

/** Launch options for a spec that reads `chrome://accessibility` (Chrome and Edge). */
export const FORCE_ACCESSIBILITY = { args: ['--force-renderer-accessibility'] };

/** Rows a device queries itself (`LOCAL_ROW_LIMIT`): above it, the server answers the table. */
export const LOCAL_ROW_LIMIT = 5000;

// ---------------------------------------------------------------------------------------- CDP
export interface AxNode {
  role: string;
  name: string;
  description: string;
  /** CDP's properties by name: `level`, `expanded`, `selected`, `activedescendant`, … */
  props: Record<string, unknown>;
  backendId: number | undefined;
  ignored: boolean;
}

interface RawAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  properties?: {
    name: string;
    value: { value?: unknown; relatedNodes?: { backendDOMNodeId: number }[] };
  }[];
  backendDOMNodeId?: number;
  parentId?: string;
}

const toNode = (raw: RawAxNode): AxNode => ({
  role: String(raw.role?.value ?? ''),
  name: String(raw.name?.value ?? ''),
  description: String(raw.description?.value ?? ''),
  props: Object.fromEntries(
    (raw.properties ?? []).map((p) => [
      p.name,
      p.value.relatedNodes ? p.value.relatedNodes.map((r) => r.backendDOMNodeId) : p.value.value,
    ]),
  ),
  backendId: raw.backendDOMNodeId,
  ignored: raw.ignored,
});

/** Chromium's accessibility tree of a page, over CDP. */
export class AxTree {
  private constructor(
    readonly page: Page,
    private cdp: CDPSession,
  ) {}

  static async of(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    return new AxTree(page, cdp);
  }

  private async raw(backendNodeId: number, relatives = false): Promise<RawAxNode[]> {
    const { nodes } = (await this.cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: relatives,
    })) as { nodes: RawAxNode[] };
    return nodes;
  }

  private async backendId(selector: string): Promise<number | null> {
    const { result } = (await this.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    })) as { result: { objectId?: string } };
    if (!result.objectId) return null;
    const { node } = (await this.cdp.send('DOM.describeNode', {
      objectId: result.objectId,
    })) as { node: { backendNodeId: number } };
    return node.backendNodeId;
  }

  /** The accessibility node of the first element `selector` finds, or null. */
  async node(selector: string): Promise<AxNode | null> {
    const id = await this.backendId(selector);
    if (id === null) return null;
    const [own] = await this.raw(id);
    return own ? toNode(own) : null;
  }

  /**
   * The grid's active descendant as the tree has it, and the row it is in (itself when it is a
   * row): what a screen reader reads as the grid's focus moves.
   */
  async active(gridSelector: string): Promise<{ cell: AxNode; row: AxNode | null } | null> {
    const gridNode = await this.node(gridSelector);
    const ids = gridNode?.props.activedescendant as number[] | undefined;
    if (!ids?.length) return null;
    const nodes = await this.raw(ids[0], true);
    const own = nodes.find((n) => n.backendDOMNodeId === ids[0]);
    if (!own) return null;
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    let row: RawAxNode | undefined = own;
    while (row && row.role?.value !== 'row')
      row = row.parentId ? byId.get(row.parentId) : undefined;
    return { cell: toNode(own), row: row ? toNode(row) : null };
  }

  /** Every node of the tree that is not ignored. */
  async all(): Promise<AxNode[]> {
    const { nodes } = (await this.cdp.send('Accessibility.getFullAXTree')) as {
      nodes: RawAxNode[];
    };
    return nodes.filter((n) => !n.ignored).map(toNode);
  }

  async dispose() {
    await this.cdp.detach().catch(() => undefined);
  }
}

// ------------------------------------------------------------------- Chromium's internal tree
/** One node of Chromium's internal tree: its role, and the attributes the filter let through. */
export interface InternalNode {
  depth: number;
  role: string;
  attrs: Record<string, string>;
}

/** The attributes the specs read; everything else is left out of the page's print. */
const ALLOW = [
  'htmlId',
  'name',
  'ariaRowCount',
  'ariaColumnCount',
  'ariaCellRowIndex',
  'ariaCellColumnIndex',
  'tableRowCount',
  'hierarchicalLevel',
  'posInSet',
  'setSize',
];

/**
 * Chromium's internal accessibility tree of `page`, read from `chrome://accessibility` (or
 * `edge://accessibility`) in another tab of its context: the page is found there by a title of
 * its own, set for the read and put back after it.
 */
export async function internalTree(page: Page): Promise<InternalNode[]> {
  const context: BrowserContext = page.context();
  const mark = `grid-a11y-${Math.random().toString(36).slice(2, 10)}`;
  const title = await page.evaluate((mark) => {
    const before = document.title;
    document.title = mark;
    return before;
  }, mark);
  const internals = await context.newPage();
  try {
    const edge = /Edg\//.test(await page.evaluate(() => navigator.userAgent));
    await internals.goto(`${edge ? 'edge' : 'chrome'}://accessibility`);
    // Only these attributes are printed (a node's role always is).
    await internals.locator('#filter-allow').fill(ALLOW.join(' '));
    const entry = internals.locator('#pages > *').filter({ hasText: mark }).first();
    await expect(entry, 'chrome://accessibility lists the page under test').toBeVisible();
    await entry.locator('[id$="-showOrRefreshTree"]').click();
    let text = '';
    await expect
      .poll(
        async () => {
          text = await entry.innerText();
          return /\b(grid|treeGrid)\b/.test(text);
        },
        { message: 'chrome://accessibility shows the page’s tree' },
      )
      .toBe(true);
    return parseInternal(text);
  } finally {
    await internals.close();
    await page.evaluate((title) => (document.title = title), title).catch(() => undefined);
  }
}

/**
 * Reads the internal tree's text: `++++row name='…' ariaCellRowIndex=5 …` per node, two `+` a
 * level (`id#=12` before the role when the filter lets every attribute through).
 */
export function parseInternal(text: string): InternalNode[] {
  const nodes: InternalNode[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\+*)(?:id#=-?\d+ )?([a-zA-Z]+)((?: .*)?)$/.exec(line.trim());
    // The tab's title and switches print above its tree, whose root has no `+`.
    if (!match || (!match[1] && match[2] !== 'rootWebArea')) continue;
    const attrs: Record<string, string> = {};
    for (const [, key, raw] of match[3].matchAll(/(\w+)=('(?:[^'\\]|\\.)*'|\([^)]*\)|\S+)/g))
      attrs[key] = raw.startsWith("'") ? raw.slice(1, -1) : raw;
    nodes.push({ depth: match[1].length / 2, role: match[2], attrs });
  }
  return nodes;
}

/** What Chromium gives a screen reader for the table on screen: its count, and each row's index. */
export interface InternalGrid {
  role: string;
  name: string;
  rowCount: number;
  /** By the row's or the cell's `id`: the cell's row index (a row: its first cell's). */
  rowIndexOf(id: string): number | null;
  /** A row's `aria-level`, `aria-posinset` and `aria-setsize` as Chromium has them. */
  treeOf(id: string): { level: number; posInSet: number; setSize: number } | null;
}

/** The table's grid in Chromium's internal tree (the first grid or tree grid named `name`). */
export async function internalGrid(page: Page, name: string | RegExp): Promise<InternalGrid> {
  const nodes = await internalTree(page);
  const at = nodes.findIndex(
    (n) =>
      (n.role === 'grid' || n.role === 'treeGrid') &&
      (typeof name === 'string' ? n.attrs.name === name : name.test(n.attrs.name ?? '')),
  );
  if (at < 0) throw new Error(`No grid named ${name} in Chromium's tree`);
  const grid = nodes[at];
  const inside: InternalNode[] = [];
  for (let i = at + 1; i < nodes.length && nodes[i].depth > grid.depth; i++) inside.push(nodes[i]);
  const byId = (id: string) => inside.findIndex((n) => n.attrs.htmlId === id);
  const cellAfter = (i: number) => {
    // A row's first cell (the next node one level down that holds a cell's row index).
    for (let j = i + 1; j < inside.length && inside[j].depth > inside[i].depth; j++)
      if (inside[j].attrs.ariaCellRowIndex) return inside[j];
    return null;
  };
  return {
    role: grid.role,
    name: grid.attrs.name ?? '',
    rowCount: Number(grid.attrs.ariaRowCount ?? NaN),
    rowIndexOf(id) {
      const i = byId(id);
      if (i < 0) return null;
      const node = inside[i];
      const cell = node.role === 'row' ? cellAfter(i) : node;
      return cell?.attrs.ariaCellRowIndex ? Number(cell.attrs.ariaCellRowIndex) : null;
    },
    treeOf(id) {
      const i = byId(id);
      if (i < 0) return null;
      const { hierarchicalLevel, posInSet, setSize } = inside[i].attrs;
      return hierarchicalLevel
        ? { level: Number(hierarchicalLevel), posInSet: Number(posInSet), setSize: Number(setSize) }
        : null;
    },
  };
}

// ---------------------------------------------------------------------------------- the scenes
/** The live region a table says its edits and selections through. */
export const tableSaid = (db: Locator) => db.locator('.cgw-db-table [data-cg-live-announcer]');

/** `rows` lines of a CSV file: Name ("Item 0001", …) and Size (a number). */
export const csvRows = (rows: number) => {
  const lines = ['Name,Size'];
  for (let i = 1; i <= rows; i++) lines.push(`Item ${String(i).padStart(4, '0')},${i}`);
  return lines;
};

/** Gives the chooser a CSV file and imports it, from a dialog "Import CSV" that is open. */
async function importFile(page: Page, lines: string[], name: string) {
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a CSV file' }).click();
  await (
    await chooser
  ).setFiles({
    name: `${name}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(lines.join('\r\n') + '\r\n'),
  });
  await expect(dialog).toContainText(`${name}.csv: ${lines.length - 1} rows`);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText(`Imported rows: ${lines.length - 1}`, { timeout: 120000 });
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(dialog).toHaveCount(0);
}

/**
 * A local database of `rows` rows, from "Import a CSV file as a new database" in the sidebar
 * (under the limit a device queries itself), opened on its page. Its table is named
 * "`name`: table".
 */
export async function localDatabase(page: Page, rows: number, name = 'Ledger') {
  await page.locator('[data-action="new-database"]').first().click();
  await page
    .getByRole('menuitem', { name: 'Import a CSV file as a new database', exact: true })
    .click();
  await importFile(page, csvRows(rows), name);
  const db = fullPage(page);
  await expect(grid(db)).toHaveAttribute('aria-rowcount', String(rows + 1), { timeout: 60000 });
  return db;
}

/**
 * Rows imported into the database on screen from its view options' "Import CSV…" (above
 * `LOCAL_ROW_LIMIT` the server imports them, as database-sync.spec.ts does).
 */
export async function importInto(page: Page, db: Locator, rows: number, name: string) {
  await db.getByRole('button', { name: /^View options/ }).click();
  await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
  await importFile(page, csvRows(rows), name);
}

/** The Tasks template's "All tasks" view, grouped by `property` from the toolbar's Group. */
export async function groupedTasks(page: Page, property: string) {
  await newDatabase(page, 'Tasks');
  const db = fullPage(page);
  await showView(db, 'All tasks');
  await db.getByRole('button', { name: 'Group', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Group' })
    .getByRole('combobox', { name: 'Group by' })
    .selectOption({ label: property });
  await page.keyboard.press('Escape');
  await expect(db.getByRole('button', { name: `Group: ${property}` })).toBeVisible();
  await expect(db.locator('[role="treegrid"].cgw-grid')).toBeVisible();
  return db;
}

// ------------------------------------------------- the grid's screens (Axe and the Arabic walk)
/** The shell's "New database" in the sidebar's ▦ menu. */
const NEW_DATABASE = { en: 'New database', ar: 'قاعدة بيانات جديدة' };

/**
 * A local workspace in `language` with the Tasks template (its rows, properties and views in that
 * language) and a fifth view, a table grouped by Priority: the grid's screens' scene.
 */
export async function gridScene(page: Page, language: 'en' | 'ar') {
  const t = (language === 'ar' ? dbAr : dbEn).database;
  await page.goto('/');
  await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
  await page.reload();
  await page
    .locator('#cgw-workspace-name, input')
    .first()
    .fill(language === 'ar' ? 'جدول' : 'Grid');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
  await page.locator('[data-action="new-database"]').first().click();
  await page.getByRole('menuitem', { name: NEW_DATABASE[language], exact: true }).click();
  const picker = page.getByRole('dialog', { name: t.templates.title });
  await picker.getByRole('radio', { name: new RegExp(`^${t.templates.tasks.name}`) }).check();
  await picker.getByRole('button', { name: t.templates.create, exact: true }).click();
  const db = page.locator('.cgw-database-page .cgw-db');
  await expect(db).toBeVisible();
  await db.getByRole('button', { name: t.views.add }).click();
  await page.getByRole('menuitem', { name: t.viewType.table, exact: true }).click();
  await expect(db.getByRole('tab')).toHaveCount(5);
  await expect(db.getByRole('tab').nth(4)).toHaveAttribute('aria-selected', 'true');
  await db.getByRole('button', { name: t.toolbar.group, exact: true }).click();
  await page
    .getByRole('dialog', { name: t.group.title })
    .getByRole('combobox', { name: t.group.by })
    .selectOption({ label: t.templates.tasks.priority });
  await page.keyboard.press('Escape');
  await expect(db.locator('[role="treegrid"].cgw-grid')).toBeVisible();
  return { url: page.url(), language };
}

/**
 * The grid's screens, on the scene's database page in its language (`visit` is called on each):
 * the table with a row's cell active; a title being edited (said in the live region), then
 * cancelled; the tree grid with a group's header active, then collapsed; its first "New" line
 * reached (said).
 */
export async function gridScreens(
  page: Page,
  language: 'en' | 'ar',
  visit: (screen: string) => Promise<void>,
) {
  const words = language === 'ar' ? gridAr : gridEn;
  const db = page.locator('.cgw-database-page .cgw-db');
  const said = tableSaid(db);
  const tabs = db.getByRole('tab');
  await expect(tabs).toHaveCount(5);

  // The template's table ("All tasks"): a row's cell active.
  await tabs.nth(1).click();
  const table = db.locator('[role="grid"].cgw-grid');
  await expect(table.locator('.cgw-tbody [role="row"]').first()).toBeVisible();
  await table.focus();
  await page.keyboard.press('ArrowDown');
  await expect(table).toHaveAttribute('aria-activedescendant', /-c1-0$/);
  await visit('grid');
  await page.keyboard.press('Enter');
  await expect(table.locator('.cgw-inline-editor')).toBeFocused();
  await expect(said).toHaveText(new RegExp(`^${words.editing.split('{{')[0]}`));
  await visit('grid, a title being edited');
  await page.keyboard.press('Escape');
  await expect(said).toHaveText(new RegExp(`^${words.cancelled.split('{{')[0]}`));
  await visit('grid, an edit cancelled');

  // The grouped table: a tree grid, its first group's header active, then collapsed.
  await tabs.nth(4).click();
  const tree = db.locator('[role="treegrid"].cgw-grid');
  await expect(tree.locator('.cgw-trow-group').first()).toBeVisible();
  await tree.focus();
  await expect(tree).toHaveAttribute('aria-activedescendant', /-i0$/);
  await visit('tree grid');
  await page.keyboard.press(language === 'ar' ? 'ArrowRight' : 'ArrowLeft');
  await expect(tree.locator('.cgw-trow-group').first()).toHaveAttribute('aria-expanded', 'false');
  await visit('tree grid, a group collapsed');
  await page.keyboard.press(language === 'ar' ? 'ArrowLeft' : 'ArrowRight');
  await expect(tree.locator('.cgw-trow-group').first()).toHaveAttribute('aria-expanded', 'true');
  // Down to the first group's New line: no row of the grid, said in the live region.
  for (let i = 0; i < 20; i++) {
    const kind = await tree.evaluate((el) => {
      const id = el.getAttribute('aria-activedescendant');
      return id ? 'line' : 'new';
    });
    if (kind === 'new') break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(tree).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(said).toHaveText(new RegExp(`^${words.newRowIn.split('{{')[0]}`));
  await visit('tree grid, a New line');
}
