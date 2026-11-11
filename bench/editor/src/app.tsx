// The Phase 1 budgets that need the whole app (ARCHITECTURE.md, Performance): the real
// WorkspaceApp over an IndexedDB store seeded with a 10,000-page workspace, driven by
// bench/phase1.mjs. Seeding goes through the store's own API (applyLocalOps, appendDocUpdates,
// putSearchEntry), so the app reads what it would have written itself.
import '@cashgear/ui/styles.css';
import { newDocumentUpdate, type DocJSON } from '@cgw/doc';
import { WorkspaceApp, type WorkspacePlatform } from '@cgw/shell';
import { IndexedDbStore, workerIndex } from '@cgw/store-web';
import {
  keyBetween,
  newOp,
  normaliseText,
  uuidv7,
  type Id,
  type Operation,
  type PageRecord,
} from '@cgw/workspace';
import { createRoot } from 'react-dom/client';
import { generateBlocks } from './generate';

const DATABASE = 'cgw-bench';

const platform: WorkspacePlatform = {
  kind: 'web',
  setWindowTheme: async () => {},
  openExternal: async () => {},
  openStore: () => IndexedDbStore.open(indexedDB, DATABASE, { index: workerIndex() }),
  saveFile: async () => {},
};

const WORDS_EN = [
  'invoice',
  'ledger',
  'budget',
  'report',
  'payroll',
  'customer',
  'supplier',
  'warehouse',
  'quarter',
  'forecast',
  'audit',
  'contract',
  'meeting',
  'project',
  'review',
  'account',
];
const WORDS_AR = [
  'فاتورة',
  'دفتر',
  'ميزانية',
  'تقرير',
  'رواتب',
  'عميل',
  'مورد',
  'مستودع',
  'ربع',
  'توقعات',
  'تدقيق',
  'عقد',
  'اجتماع',
  'مشروع',
  'مراجعة',
  'حساب',
];

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function sentence(random: () => number, words: number) {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    const list = random() < 0.5 ? WORDS_EN : WORDS_AR;
    out.push(list[Math.floor(random() * list.length)]);
  }
  return out.join(' ');
}

const at = () => new Date().toISOString();

function page(
  workspaceId: Id,
  sectionId: Id,
  parentPageId: Id | null,
  title: string,
  orderKey: string,
): PageRecord {
  return {
    id: uuidv7(),
    workspaceId,
    sectionId,
    parentPageId,
    orderKey,
    kind: 'page',
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: at(),
    updatedAt: at(),
    trashedAt: null,
    trashRootId: null,
  };
}

export interface Seeded {
  workspaceId: Id;
  /** Top-level pages, each with `children` pages inside. */
  parents: Id[];
  /** Pages with a 200-block document, and with a 2,000-block one. */
  big200: Id[];
  big2000: Id[];
  big5000: Id[];
  pages: number;
  seedMs: number;
}

/**
 * A workspace of `parents` top-level pages with `children` each (10 x 999 + 10 = 10,000), every page
 * in the search index with a title and a few sentences of English and Arabic, and some pages with
 * large documents.
 */
async function seed(parents = 10, children = 999): Promise<Seeded> {
  const started = performance.now();
  indexedDB.deleteDatabase(DATABASE);
  const store = await IndexedDbStore.open(indexedDB, DATABASE);
  const random = seeded(7);
  const workspaceId = uuidv7();
  const sectionId = uuidv7();
  await store.applyLocalOps([
    newOp('workspace.create', workspaceId, workspaceId, {
      id: workspaceId,
      name: 'Budgets',
      icon: null,
      createdAt: at(),
      version: 1,
      localOnly: true,
      deletedAt: null,
    }),
    newOp('section.create', workspaceId, sectionId, {
      id: sectionId,
      workspaceId,
      name: 'Pages',
      orderKey: 'a0',
      visibility: 'workspace',
      version: 1,
      createdAt: at(),
    }),
  ]);
  const all: PageRecord[] = [];
  const parentIds: Id[] = [];
  let parentKey: string | null = null;
  for (let p = 0; p < parents; p++) {
    parentKey = keyBetween(parentKey, null);
    const parent = page(workspaceId, sectionId, null, `${sentence(random, 2)} ${p}`, parentKey);
    parentIds.push(parent.id);
    all.push(parent);
    let childKey: string | null = null;
    for (let c = 0; c < children; c++) {
      childKey = keyBetween(childKey, null);
      all.push(
        page(workspaceId, sectionId, parent.id, `${sentence(random, 3)} ${p}.${c}`, childKey),
      );
    }
  }
  for (let i = 0; i < all.length; i += 500) {
    const ops: Operation[] = all
      .slice(i, i + 500)
      .map((record) => newOp('page.create', workspaceId, record.id, record));
    await store.applyLocalOps(ops);
  }
  // Large documents on some children of the first parent.
  const firstChildren = all.filter((p) => p.parentPageId === parentIds[0]);
  // The session keeps four documents open: cycling through more opens each one from the store.
  const big200 = firstChildren.slice(0, 6).map((p) => p.id);
  const big2000 = firstChildren.slice(6, 11).map((p) => p.id);
  const big5000 = firstChildren.slice(11, 12).map((p) => p.id);
  const docs: [Id[], number][] = [
    [big200, 200],
    [big2000, 2000],
    [big5000, 5000],
  ];
  for (const [ids, blocks] of docs)
    for (const [i, id] of ids.entries())
      await store.appendDocUpdates(id, [
        {
          updateId: uuidv7(),
          data: newDocumentUpdate(
            id,
            generateBlocks(blocks, i % 2 ? 'ar' : 'en', i + 1) as DocJSON,
          ),
        },
      ]);
  // Every page searchable: its title and a few sentences.
  const pending: Promise<void>[] = [];
  for (const record of all) {
    pending.push(
      store.putSearchEntry({
        pageId: record.id,
        workspaceId,
        title: normaliseText(record.title),
        text: normaliseText(sentence(random, 40)),
      }),
    );
    if (pending.length >= 200) await Promise.all(pending.splice(0));
  }
  await Promise.all(pending);
  await store.close();
  return {
    workspaceId,
    parents: parentIds,
    big200,
    big2000,
    big5000,
    pages: all.length,
    seedMs: Math.round(performance.now() - started),
  };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const afterPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    }),
  );

// Keystroke to the next frame in the real app (Q19): from the keydown to the frame after the
// change is drawn. Editor work, the other half of Q19, is measured on the spike page, where the
// editor's own transactions can be timed (bench/editor/run-browser.mjs, S6).
const keys = { frame: [] as number[] };
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key.length !== 1) return;
    const start = event.timeStamp;
    void afterPaint().then(() => keys.frame.push(performance.now() - start));
  },
  true,
);

const bench = {
  seed,
  keystrokes() {
    return { frame: keys.frame.splice(0) };
  },
  mount() {
    createRoot(document.getElementById('root')!).render(<WorkspaceApp platform={platform} />);
  },
  /** Ms from asking for a page to its document painted with `blocks` top-level blocks. */
  async openPage(pageId: Id, blocks: number) {
    const started = performance.now();
    location.hash = `#/p/${pageId}`;
    for (;;) {
      await frame();
      const editor = document.querySelector('.cgw-page .cgw-editor');
      if (editor && editor.childElementCount >= blocks) break;
      if (performance.now() - started > 30_000) throw new Error('The page did not open.');
    }
    await afterPaint();
    return performance.now() - started;
  },
  /**
   * Ms from a click on a row's twisty to the row opened or closed and painted. Rows are found by
   * page id; the tree is virtualised, so only rows on screen are there.
   */
  async expand(pageId: Id, open = true) {
    const row = document.querySelector<HTMLElement>(`[role="treeitem"][data-key="${pageId}"]`);
    const twisty = row?.querySelector<HTMLElement>('.cgw-tree-twisty');
    if (!row || !twisty) throw new Error('No row ' + pageId);
    if ((row.getAttribute('aria-expanded') === 'true') === open)
      return { elapsed: 0, changed: false };
    const started = performance.now();
    twisty.click();
    await afterPaint();
    const elapsed = performance.now() - started;
    const now = document.querySelector(`[role="treeitem"][data-key="${pageId}"]`);
    return { elapsed, changed: (now?.getAttribute('aria-expanded') === 'true') === open };
  },
};

declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;
