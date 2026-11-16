// The journal (Phase 8, DECISIONS.md 2026-11-16): unsent document updates also written to a file
// of the tab's own in the Origin Private File System, so a write Chrome's IndexedDB reported
// complete and then lost (a torn LevelDB log, scripts/idb-torn-log.mjs) comes back. Here over a
// fake OPFS in Node and fake-indexeddb.
import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished } from 'vitest';
import { uuidv7, type Id, type LocalUpdate } from '@cgw/workspace';
import {
  describeLocalStore,
  op,
  pageRecord,
  sectionRecord,
  workspaceRecord,
} from '@cgw/workspace/testing';
import { done, openDatabase, request } from './idb';
import { coreJournal, type Journal } from './journal/client';
import { FakeDirectory } from './journal/fakeOpfs';
import { encodeUpdate, scan, type JournalUpdate } from './journal/format';
import { IndexedDbStore } from './store';

let channels = 0;
/** A journal over `dir`, as one tab; tabs of one test share a channel (they tell each other). */
const tab = (dir: FakeDirectory, channel: string, options: { maxLiveBytes?: number } = {}) =>
  coreJournal(dir, { channel, ...options });
const channel = () => `cgw-journal-test-${++channels}`;
const bytes = (...values: number[]) => new Uint8Array(values);
const update = (data: number[]): LocalUpdate => ({ updateId: uuidv7(), data: bytes(...data) });

/** Everything still needed across the folder's files, read as a new tab would (then let go). */
async function readAll(dir: FakeDirectory) {
  const reader = tab(dir, channel());
  const opened = await reader.open();
  // Not adopted: the files stay as they were for the test to read again.
  reader.close();
  dir.releaseAll();
  return opened!.entries;
}

async function syncedStore(name: string, journal: Journal | undefined, localOnly = false) {
  const store = await IndexedDbStore.open(indexedDB, name, journal ? { journal } : {});
  const ws = { ...workspaceRecord('Journal'), localOnly };
  const section = sectionRecord(ws.id);
  const page = pageRecord(ws.id, section.id, null, 'Alpha');
  await store.applyLocalOps([
    op('workspace.create', ws.id, ws.id, ws),
    op('section.create', ws.id, section.id, section),
    op('page.create', ws.id, page.id, page),
  ]);
  return { store, ws, section, page };
}

/** What Chrome's lost session leaves: the page's rows from `from` on gone, its log as before. */
async function loseWrites(name: string, pageId: Id, from: number) {
  const db = await openDatabase(indexedDB, name, undefined, () => {});
  const tx = db.transaction(['docLogs', 'docUpdates'], 'readwrite');
  tx.objectStore('docUpdates').delete(IDBKeyRange.bound([pageId, from], [pageId, Infinity]));
  const log = (await request(tx.objectStore('docLogs').get(pageId))) as { nextSeq: number };
  tx.objectStore('docLogs').put({ ...log, nextSeq: from });
  await done(tx);
  db.close();
}

describe('the journal file', () => {
  const entry = (n: number): JournalUpdate => ({
    pageId: 'page-1',
    updateId: `update-${n}`,
    localSeq: n,
    data: bytes(n, n + 1, n + 2),
    at: 1_700_000_000_000 + n,
  });

  it('reads back what it wrote, and stops at a torn tail', () => {
    const whole = [entry(1), entry(2)].map(encodeUpdate);
    const torn = encodeUpdate(entry(3));
    for (const cut of [1, 8, 9, 12, torn.length - 1]) {
      const file = new Uint8Array(whole[0].length + whole[1].length + cut);
      file.set(whole[0]);
      file.set(whole[1], whole[0].length);
      file.set(torn.subarray(0, cut), whole[0].length + whole[1].length);
      const { records, valid } = scan(file);
      expect(
        records.map((r) => r.kind === 1 && r.update.updateId),
        `cut ${cut}`,
      ).toEqual(['update-1', 'update-2']);
      expect(valid).toBe(whole[0].length + whole[1].length);
    }
  });

  it('stops at a record whose bytes do not match its checksum', () => {
    const records = [entry(1), entry(2), entry(3)].map(encodeUpdate);
    const file = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const record of records) file.set(record, (at += record.length) - record.length);
    file[records[0].length + 12] ^= 0xff;
    expect(scan(file).records).toHaveLength(1);
  });

  it('cuts a torn tail off before it appends, so nothing is ever written after one', async () => {
    // The tab reloads (session storage keeps its id), so it reopens its own file.
    const kept = new Map<string, string>();
    globalThis.sessionStorage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    } as unknown as Storage;
    onTestFinished(() => {
      delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    });
    const dir = new FakeDirectory();
    const name = channel();
    const first = tab(dir, name);
    await first.open();
    await first.append([{ pageId: 'p', updateId: 'u1', localSeq: 1, data: bytes(1) }]);
    // The tab ends inside its next write: half a record at the file's end.
    const [file] = [...dir.files.keys()];
    dir.tear(
      file,
      encodeUpdate({ pageId: 'p', updateId: 'u2', localSeq: 2, data: bytes(2), at: 0 }).subarray(
        0,
        11,
      ),
    );
    dir.releaseAll();
    const next = tab(dir, name);
    const opened = await next.open();
    expect(opened!.entries.map((e) => e.updateId)).toEqual(['u1']);
    await next.append([{ pageId: 'p', updateId: 'u3', localSeq: 3, data: bytes(3) }]);
    next.close();
    dir.releaseAll();
    for (const [, data] of dir.files)
      expect(scan(data.bytes).valid, 'every file reads to its end').toBe(data.bytes.length);
    expect((await readAll(dir)).map((e) => e.updateId).sort()).toEqual(['u1', 'u3']);
  });
});

describe('the journal across tabs', () => {
  it('gives each tab a file of its own, and an update forgotten in one tab goes in the other', async () => {
    const dir = new FakeDirectory();
    const name = channel();
    const a = tab(dir, name);
    const b = tab(dir, name);
    await a.open();
    await b.open();
    expect(a.state.state === 'on' && b.state.state === 'on').toBe(true);
    expect(dir.files.size).toBe(2);
    await a.append([{ pageId: 'p', updateId: 'from-a', localSeq: 1, data: bytes(1) }]);
    await b.append([{ pageId: 'p', updateId: 'from-b', localSeq: 2, data: bytes(2) }]);
    // Tab B pushed tab A's update and the server acknowledged it: B tells A.
    b.forget({ ids: ['from-a'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.close();
    b.close();
    dir.releaseAll();
    expect((await readAll(dir)).map((e) => e.updateId)).toEqual(['from-b']);
  });

  it('takes over the file of a tab that is gone, and leaves an open tab’s alone', async () => {
    const dir = new FakeDirectory();
    const name = channel();
    const gone = tab(dir, name);
    await gone.open();
    await gone.append([{ pageId: 'p', updateId: 'from-gone', localSeq: 1, data: bytes(1) }]);
    const open = tab(dir, name);
    await open.open();
    await open.append([{ pageId: 'p', updateId: 'from-open', localSeq: 2, data: bytes(2) }]);
    // The first tab's browser process ended: its lock with it, its file left behind.
    const goneFile = [...dir.files.keys()][0];
    (dir.files.get(goneFile) as { locked: boolean }).locked = false;
    const next = tab(dir, name);
    const opened = (await next.open())!;
    expect(opened.files).toMatchObject({ dead: 1, open: 1 });
    expect(opened.entries.map((e) => e.updateId).sort()).toEqual(['from-gone', 'from-open']);
    await next.adopt(['from-gone']);
    expect(dir.files.has(goneFile)).toBe(false);
    next.close();
    open.close();
    expect((await readAll(dir)).map((e) => e.updateId).sort()).toEqual(['from-gone', 'from-open']);
  });

  it('is bounded: past its cap a tab skips the journal (IndexedDB alone) until forgets make room', async () => {
    const dir = new FakeDirectory();
    const journal = tab(dir, channel(), { maxLiveBytes: 300 });
    await journal.open();
    await journal.append([{ pageId: 'p', updateId: 'u1', localSeq: 1, data: new Uint8Array(200) }]);
    await journal.append([{ pageId: 'p', updateId: 'u2', localSeq: 2, data: new Uint8Array(200) }]);
    expect(journal.state.state).toBe('full');
    journal.forget({ ids: ['u1'] });
    await journal.append([{ pageId: 'p', updateId: 'u3', localSeq: 3, data: new Uint8Array(50) }]);
    expect(journal.state.state).toBe('on');
    journal.close();
    dir.releaseAll();
    expect((await readAll(dir)).map((e) => e.updateId)).toEqual(['u3']);
  });

  it('writes its file again once most of it is forgotten', async () => {
    const dir = new FakeDirectory();
    const journal = coreJournal(dir, { channel: channel(), rewriteAfter: 1000 });
    await journal.open();
    for (let i = 0; i < 20; i++)
      await journal.append([
        { pageId: 'p', updateId: `u${i}`, localSeq: i, data: new Uint8Array(100) },
      ]);
    journal.forget({ upTo: [['p', 17]] });
    await journal.append([{ pageId: 'p', updateId: 'last', localSeq: 20, data: bytes(1) }]);
    const sizes = Object.values(dir.sizes());
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThan(700);
    journal.close();
    dir.releaseAll();
    expect((await readAll(dir)).map((e) => e.updateId)).toEqual(['u18', 'u19', 'last']);
  });
});

describe('the store with its journal', () => {
  it('journals a save, and lets it go once the server acknowledged it', async () => {
    const dir = new FakeDirectory();
    const { store, page } = await syncedStore(`journal-${uuidv7()}`, tab(dir, channel()));
    const [a, b] = [update([1]), update([2])];
    await store.appendDocUpdates(page.id, [a, b]);
    expect(store.journalState.state).toBe('on');
    await store.ackDocUpdates(page.id, [{ updateId: a.updateId, seq: 1 }]);
    await store.close();
    dir.releaseAll();
    expect((await readAll(dir)).map((e) => e.updateId)).toEqual([b.updateId]);
  });

  it('calls a save done only once the journal has it too', async () => {
    let release!: () => void;
    const slow: Journal = {
      state: { state: 'on', tabId: 't' },
      open: async () => ({
        tabId: 't',
        entries: [],
        files: { own: 1, dead: 0, open: 0, unreadable: 0 },
      }),
      append: () => new Promise<void>((resolve) => (release = resolve)),
      forget: () => undefined,
      adopt: async () => undefined,
      close: () => undefined,
    };
    const { store, page } = await syncedStore(`journal-${uuidv7()}`, slow);
    let saved = false;
    const saving = store.appendDocUpdates(page.id, [update([1])]).then(() => (saved = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // IndexedDB committed long ago; the journal has not answered.
    expect(saved).toBe(false);
    release();
    await saving;
    expect(saved).toBe(true);
    await store.close();
  });

  it('gives back the saves Chrome lost: each at its own sequence, unsent, once', async () => {
    const dir = new FakeDirectory();
    const name = `journal-${uuidv7()}`;
    const first = await syncedStore(name, tab(dir, channel()));
    const page = first.page;
    const kept = update([1]);
    await first.store.appendDocUpdates(page.id, [kept]);
    await first.store.ackDocUpdates(page.id, [{ updateId: kept.updateId, seq: 1 }]);
    const lost = [update([2]), update([3]), update([4])];
    await first.store.appendDocUpdates(page.id, lost.slice(0, 2));
    await first.store.appendDocUpdates(page.id, lost.slice(2));
    await first.store.close();
    dir.releaseAll();
    // The session's writes are gone from IndexedDB, as Chrome drops them (local sequences 2 to 4).
    await loseWrites(name, page.id, 2);
    const next = await IndexedDbStore.open(indexedDB, name, { journal: tab(dir, channel()) });
    expect(next.journalReport).toMatchObject({ read: 3, restored: 3, waiting: 0 });
    const doc = await next.loadDoc(page.id);
    expect(doc.updates.map((u) => [u.localSeq, u.updateId, u.seq])).toEqual([
      [1, kept.updateId, 1],
      [2, lost[0].updateId, null],
      [3, lost[1].updateId, null],
      [4, lost[2].updateId, null],
    ]);
    expect([...doc.updates[3].data]).toEqual([4]);
    expect((await next.unsentDocUpdates(10))[0].updates.map((u) => u.updateId)).toEqual(
      lost.map((u) => u.updateId),
    );
    // The next save follows them; nothing is written back twice at the start after.
    await next.appendDocUpdates(page.id, [update([5])]);
    await next.close();
    dir.releaseAll();
    const again = await IndexedDbStore.open(indexedDB, name, { journal: tab(dir, channel()) });
    expect(again.journalReport).toMatchObject({ restored: 0 });
    expect((await again.loadDoc(page.id)).updates.map((u) => u.localSeq)).toEqual([1, 2, 3, 4, 5]);
    await again.close();
  });

  it('writes nothing back that a compaction or an acknowledgement covers, though no forget came', async () => {
    const dir = new FakeDirectory();
    const name = `journal-${uuidv7()}`;
    // The journal never hears a forget: as when a tab ends between a commit and its forget.
    const deaf = (journal: Journal): Journal => ({
      ...journal,
      state: journal.state,
      forget: () => undefined,
      open: () => journal.open(),
      append: (u) => journal.append(u),
      adopt: (k) => journal.adopt(k),
      close: () => journal.close(),
    });
    const inner = tab(dir, channel());
    const wrapped = deaf(inner);
    Object.defineProperty(wrapped, 'state', { get: () => inner.state });
    const { store, page } = await syncedStore(name, wrapped, true);
    await store.appendDocUpdates(page.id, [update([1]), update([2])]);
    await store.compactDoc(page.id, bytes(9, 9), 2);
    await store.close();
    dir.releaseAll();
    expect(await readAll(dir)).toHaveLength(2);
    const next = await IndexedDbStore.open(indexedDB, name, { journal: tab(dir, channel()) });
    expect(next.journalReport).toMatchObject({ read: 2, restored: 0, forgotten: 2 });
    expect((await next.loadDoc(page.id)).updates).toEqual([]);
    await next.close();
  });

  it('after Chrome deleted the store, gives the saves back once their page comes from the server', async () => {
    const dir = new FakeDirectory();
    const first = await syncedStore(`journal-${uuidv7()}`, tab(dir, channel()));
    const saved = [update([7]), update([8])];
    await first.store.appendDocUpdates(first.page.id, saved);
    await first.store.close();
    dir.releaseAll();
    // A new, empty store: what Chrome leaves after "IndexedDB recovering from a corrupted (and
    // deleted) database".
    const next = await IndexedDbStore.open(indexedDB, `journal-${uuidv7()}`, {
      journal: tab(dir, channel()),
    });
    expect(next.journalReport).toMatchObject({ read: 2, restored: 0, waiting: 2 });
    // The account's workspace comes back from the server.
    await next.applyRemote({
      workspaceId: first.ws.id,
      workspaces: [first.ws],
      sections: [first.section],
      pages: [first.page],
      cursor: 1,
    });
    expect(next.journalReport).toMatchObject({ restoredLater: 2 });
    const doc = await next.loadDoc(first.page.id);
    expect(doc.updates.map((u) => [u.updateId, u.seq])).toEqual(
      saved.map((u) => [u.updateId, null]),
    );
    // As the device's own updates to push.
    expect((await next.unsentDocUpdates(10)).map((d) => d.pageId)).toEqual([first.page.id]);
    await next.close();
  });

  it('works as before where there is no journal (no Origin Private File System)', async () => {
    const broken = coreJournal(async () => {
      throw new Error('No Origin Private File System here');
    });
    const { store, page } = await syncedStore(`journal-${uuidv7()}`, broken);
    expect(store.journalState).toMatchObject({ state: 'off' });
    expect(store.journalReport).toMatchObject({ state: 'off' });
    await store.appendDocUpdates(page.id, [update([1])]);
    expect((await store.loadDoc(page.id)).updates).toHaveLength(1);
    await store.close();
  });
});

// The whole store contract, with the journal on.
describeLocalStore('IndexedDB with the journal', () =>
  IndexedDbStore.open(indexedDB, `test-${uuidv7()}`, {
    journal: coreJournal(new FakeDirectory(), { channel: channel() }),
  }),
);
