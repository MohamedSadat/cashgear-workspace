// The journal's files (format.ts): one per tab, `<tab id>.<generation>.cgwj` in the Origin Private
// File System's `cgw-journal` folder, written through a FileSystemSyncAccessHandle (exclusive: a
// tab's file is locked while the tab lives). Runs in a dedicated worker in the browser
// (journal.worker.ts) and in-process in tests, over the small part of the OPFS interface below.
import { FORGET, UPDATE, encodeForget, encodeUpdate, scan, type JournalUpdate } from './format';

/** FileSystemSyncAccessHandle, as far as the journal uses it (Chrome 102 to 107's async form too). */
export interface AccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number | Promise<number>;
  write(buffer: Uint8Array, options: { at: number }): number | Promise<number>;
  truncate(size: number): void | Promise<void>;
  getSize(): number | Promise<number>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface FileHandleLike {
  createSyncAccessHandle(): Promise<AccessHandle>;
  getFile?(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface DirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

export interface CoreOptions {
  /** The most a tab's file holds of updates still needed; past it, appends are skipped. */
  maxLiveBytes: number;
  /** Forgotten bytes that make the file worth writing again (with what is still needed only). */
  rewriteAfter: number;
  newId(): string;
}

export interface JournalOpen {
  tabId: string;
  /** Every update still needed in every file this tab could read, each once, in file order. */
  entries: JournalUpdate[];
  /** Files of tabs no longer open (their locks taken here, to be adopted); files of open tabs. */
  files: { own: number; dead: number; open: number; unreadable: number };
}

const NAME = /^([0-9A-Za-z-]{1,64})\.(\d+)\.cgwj$/;
const fileName = (tab: string, generation: number) => `${tab}.${generation}.cgwj`;

/** The records still needed in a file: its updates less those a later forget names. */
function stillNeeded(bytes: Uint8Array): { updates: Map<string, JournalUpdate>; valid: number } {
  const { records, valid } = scan(bytes);
  const updates = new Map<string, JournalUpdate>();
  for (const record of records)
    if (record.kind === UPDATE) updates.set(record.update.updateId, record.update);
    else if (record.kind === FORGET) for (const id of record.ids) updates.delete(id);
  return { updates, valid };
}

async function readAll(handle: AccessHandle): Promise<Uint8Array> {
  const size = await handle.getSize();
  const bytes = new Uint8Array(size);
  if (size) await handle.read(bytes, { at: 0 });
  return bytes;
}

interface Own {
  name: string;
  generation: number;
  handle: AccessHandle;
  size: number;
}

interface Held {
  offset: number;
  size: number;
  pageId: string;
  localSeq: number;
}

/**
 * What is no longer needed: updates by id; every update of a page (the page removed); a page's
 * updates up to a local sequence (a local-only page's log compacted that far).
 */
export interface Forget {
  ids?: string[];
  pages?: string[];
  upTo?: [pageId: string, localSeq: number][];
}

export class JournalCore {
  private own: Own | null = null;
  private tab = '';
  /** This tab's file: where each update still needed lies. */
  private readonly held = new Map<string, Held>();
  private heldBytes = 0;
  private forgotten = 0;
  /** Files of tabs that are gone, locked here until they are adopted. */
  private dead: { name: string; handle: AccessHandle; updates: Map<string, JournalUpdate> }[] = [];

  constructor(
    private readonly dir: DirectoryLike,
    private readonly options: CoreOptions,
  ) {}

  get tabId(): string {
    return this.tab;
  }

  /** The bytes of the updates this tab's file holds that are still needed. */
  get liveBytes(): number {
    return this.heldBytes;
  }

  async open(preferred: string | null): Promise<JournalOpen> {
    const names: string[] = [];
    for await (const name of this.dir.keys()) if (NAME.test(name)) names.push(name);
    const generations = (tab: string) =>
      names
        .map((n) => n.match(NAME)!)
        .filter((m) => m[1] === tab)
        .map((m) => Number(m[2]));
    // This tab's file: the one it had (a reload keeps the tab's id), unless another tab holds it
    // (a duplicated tab copies the id): then a file of its own.
    let tab = preferred && NAME.test(fileName(preferred, 0)) ? preferred : this.options.newId();
    let generation = Math.max(0, ...generations(tab));
    let handle: AccessHandle;
    try {
      handle = await (
        await this.dir.getFileHandle(fileName(tab, generation), { create: true })
      ).createSyncAccessHandle();
    } catch {
      tab = this.options.newId();
      generation = 0;
      handle = await (
        await this.dir.getFileHandle(fileName(tab, generation), { create: true })
      ).createSyncAccessHandle();
    }
    this.tab = tab;
    const ownName = fileName(tab, generation);
    const bytes = await readAll(handle);
    const mine = stillNeeded(bytes);
    // A torn tail (the tab ended inside a write) is cut off before anything is appended.
    if (mine.valid < bytes.length) {
      await handle.truncate(mine.valid);
      await handle.flush();
    }
    this.own = { name: ownName, generation, handle, size: mine.valid };
    // What is still needed of it is written again at the start of a fresh generation.
    await this.rewrite([...mine.updates.values()]);
    const entries = new Map<string, JournalUpdate>(
      [...mine.updates.values()].map((u) => [u.updateId, u]),
    );
    const files = { own: 1, dead: 0, open: 0, unreadable: 0 };
    for (const name of names) {
      if (name === ownName || name === this.own!.name) continue;
      let foreign: AccessHandle | null;
      try {
        foreign = await (await this.dir.getFileHandle(name)).createSyncAccessHandle();
      } catch {
        foreign = null;
      }
      let found: Map<string, JournalUpdate>;
      if (foreign) {
        // No tab holds it: a tab that is gone. Its updates still needed come into this tab's file
        // once the store has looked at them (`adopt`).
        found = stillNeeded(await readAll(foreign)).updates;
        this.dead.push({ name, handle: foreign, updates: found });
        files.dead++;
      } else {
        // An open tab's: read if the browser lets a locked file be read.
        try {
          const handle = await this.dir.getFileHandle(name);
          const file = await handle.getFile?.();
          if (!file) throw new Error('No reading a locked file here');
          found = stillNeeded(new Uint8Array(await file.arrayBuffer())).updates;
          files.open++;
        } catch {
          files.unreadable++;
          continue;
        }
      }
      for (const [id, update] of found) if (!entries.has(id)) entries.set(id, update);
    }
    return { tabId: tab, entries: [...entries.values()], files };
  }

  /**
   * Appends, then flushes; false when the file is full (nothing written). `limit`: what the file
   * may hold after it (updates it already held, written again, are not held back by the cap).
   */
  async append(updates: JournalUpdate[], limit = this.options.maxLiveBytes): Promise<boolean> {
    const own = this.own;
    if (!own) throw new Error('The journal is not open');
    const fresh = updates.filter((u) => !this.held.has(u.updateId));
    if (!fresh.length) return true;
    const records = fresh.map(encodeUpdate);
    const bytes = records.reduce((n, r) => n + r.length, 0);
    if (this.heldBytes + bytes > limit) return false;
    const all = new Uint8Array(bytes);
    let at = 0;
    for (const record of records) {
      all.set(record, at);
      at += record.length;
    }
    await own.handle.write(all, { at: own.size });
    await own.handle.flush();
    at = own.size;
    fresh.forEach((update, i) => {
      this.held.set(update.updateId, {
        offset: at,
        size: records[i].length,
        pageId: update.pageId,
        localSeq: update.localSeq,
      });
      at += records[i].length;
    });
    own.size = at;
    this.heldBytes += bytes;
    return true;
  }

  /** Forgets updates this tab's file holds (others are ignored); the file is rewritten when it pays. */
  async forget(what: Forget): Promise<void> {
    const own = this.own;
    if (!own) return;
    const mine = new Set((what.ids ?? []).filter((id) => this.held.has(id)));
    if (what.pages?.length || what.upTo?.length) {
      const pages = new Set(what.pages ?? []);
      const upTo = new Map(what.upTo ?? []);
      for (const [id, held] of this.held)
        if (pages.has(held.pageId) || held.localSeq <= (upTo.get(held.pageId) ?? -Infinity))
          mine.add(id);
    }
    if (!mine.size) return;
    const record = encodeForget([...mine]);
    await own.handle.write(record, { at: own.size });
    own.size += record.length;
    for (const id of mine) {
      const held = this.held.get(id)!;
      this.heldBytes -= held.size;
      this.forgotten += held.size;
      this.held.delete(id);
    }
    this.forgotten += record.length;
    if (this.forgotten > Math.max(this.options.rewriteAfter, this.heldBytes)) await this.compact();
  }

  /**
   * The files of tabs that are gone: the updates of theirs the store still needs (`keep`) are
   * appended to this tab's file, and their files removed.
   */
  async adopt(keep: string[]): Promise<void> {
    const wanted = new Set(keep);
    const dead = this.dead;
    this.dead = [];
    const moving: JournalUpdate[] = [];
    for (const file of dead)
      for (const [id, update] of file.updates)
        if (wanted.has(id) && !this.held.has(id)) moving.push(update);
    // Taken even past the cap, up to twice it: these are another tab's, already promised.
    if (moving.length) await this.append(moving, 2 * this.options.maxLiveBytes);
    for (const file of dead) {
      await file.handle.close();
      await this.dir.removeEntry(file.name).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const file of this.dead) await file.handle.close();
    this.dead = [];
    if (this.own) await this.own.handle.close();
    this.own = null;
  }

  /** This tab's file written again with what is still needed only (the next generation). */
  private async compact(): Promise<void> {
    const own = this.own!;
    const keep: JournalUpdate[] = [];
    const bytes = await readAll(own.handle);
    const { updates } = stillNeeded(bytes.subarray(0, own.size));
    for (const id of this.held.keys()) {
      const update = updates.get(id);
      if (update) keep.push(update);
    }
    await this.rewrite(keep);
  }

  private async rewrite(updates: JournalUpdate[]): Promise<void> {
    const old = this.own!;
    const generation = old.generation + 1;
    const name = fileName(this.tab, generation);
    const handle = await (
      await this.dir.getFileHandle(name, { create: true })
    ).createSyncAccessHandle();
    await handle.truncate(0);
    this.own = { name, generation, handle, size: 0 };
    this.held.clear();
    this.heldBytes = 0;
    this.forgotten = 0;
    if (updates.length) await this.append(updates, Infinity);
    else await handle.flush();
    // The new file is whole before the old one goes; a reader meeting both takes each update once.
    await old.handle.close();
    await this.dir.removeEntry(old.name).catch(() => undefined);
  }
}
