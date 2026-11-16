// The app's own store in a page of its own, for scripts/idb-torn-log.mjs --app: IndexedDbStore with
// the journal (as apps/web opens it), or without (`?journal=0`), driven from Node through
// `window.cgwTorn`. Built by Vite into target/idb-torn-app.
import {
  newOp,
  uuidv7,
  type PageRecord,
  type SectionRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';
import { IndexedDbStore, workerJournal } from '@cgw/store-web';

const withJournal = new URLSearchParams(location.search).get('journal') !== '0';
const open = () =>
  IndexedDbStore.open(indexedDB, 'cgw-torn', withJournal ? { journal: workerJournal() } : {});
const now = () => new Date().toISOString();
const update = () => {
  const data = new Uint8Array(200);
  crypto.getRandomValues(data);
  return { updateId: uuidv7(), data };
};

interface Records {
  workspace: WorkspaceRecord;
  section: SectionRecord;
  page: PageRecord;
}

/** A synced workspace with one page and two saved updates, as the server already has them. */
async function setup(): Promise<Records> {
  const store = await open();
  const workspace: WorkspaceRecord = {
    id: uuidv7(),
    name: 'Torn',
    icon: null,
    createdAt: now(),
    version: 1,
    localOnly: false,
    deletedAt: null,
  };
  const section: SectionRecord = {
    id: uuidv7(),
    workspaceId: workspace.id,
    name: 'Pages',
    orderKey: 'a0',
    visibility: 'workspace',
    version: 1,
    createdAt: now(),
  };
  const page: PageRecord = {
    id: uuidv7(),
    workspaceId: workspace.id,
    sectionId: section.id,
    parentPageId: null,
    orderKey: 'a0',
    kind: 'page',
    title: 'Torn',
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    trashedAt: null,
    trashRootId: null,
  };
  await store.applyLocalOps([
    newOp('workspace.create', workspace.id, workspace.id, workspace),
    newOp('section.create', workspace.id, section.id, section),
    newOp('page.create', workspace.id, page.id, page),
  ]);
  const base = [update(), update()];
  await store.appendDocUpdates(page.id, base);
  await store.ackDocUpdates(
    page.id,
    base.map((u, i) => ({ updateId: u.updateId, seq: i + 1 })),
  );
  await store.close();
  return { workspace, section, page };
}

/** `count` saves, one at a time, each reported complete (the store's write resolved). */
async function write(pageId: string, count: number) {
  const store = await open();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const u = update();
    await store.appendDocUpdates(pageId, [u]);
    ids.push(u.updateId);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const journal = store.journalState;
  await store.close();
  return { ids, journal };
}

/**
 * What the store holds of the page at this start, after the journal's recovery; if the page is
 * not there (Chrome deleted the store), the workspace comes back as the server would send it.
 */
async function read(records: Records) {
  const store = await open();
  const atOpen = store.journalReport;
  const hadPage = !!(await store.getPage(records.page.id));
  if (!hadPage)
    await store.applyRemote({
      workspaceId: records.workspace.id,
      workspaces: [records.workspace],
      sections: [records.section],
      pages: [records.page],
      cursor: 1,
    });
  const doc = await store.loadDoc(records.page.id);
  const unsent = await store.unsentDocUpdates(1000);
  const result = {
    hadPage,
    ids: doc.updates.map((u) => u.updateId),
    unsent: unsent.flatMap((d) => d.updates.map((u) => u.updateId)),
    atOpen,
    after: store.journalReport,
    journal: store.journalState,
  };
  await store.close();
  return result;
}

(window as unknown as { cgwTorn: unknown }).cgwTorn = { setup, write, read };
