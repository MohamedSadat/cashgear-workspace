// The store's handle on the journal (format.ts, core.ts). In the browser the files are written by a
// dedicated worker (journal.worker.ts: FileSystemSyncAccessHandle exists only in workers); in tests
// the same core runs in-process over a fake directory (`coreJournal`). Either way calls are taken
// in order. Where the Origin Private File System or sync access handles are missing (older WebKit,
// Firefox's private windows, a worker that will not start), the journal is `off` and the store
// works as it did before Phase 8: IndexedDB alone.
import type { JournalUpdate } from './format';
import {
  JournalCore,
  type CoreOptions,
  type DirectoryLike,
  type Forget,
  type JournalOpen,
} from './core';

export type { JournalUpdate } from './format';
export type { Forget, JournalOpen } from './core';

export type JournalState =
  | { state: 'starting' }
  | { state: 'on'; tabId: string }
  /** Unavailable here, or failed (why); the store goes on with IndexedDB alone. */
  | { state: 'off'; reason: string }
  /** The tab's file is at its cap: appends are skipped until forgets bring it down. */
  | { state: 'full'; tabId: string };

export interface Journal {
  readonly state: JournalState;
  /** Opens this tab's file and reads every file it can; `off` gives nothing. */
  open(): Promise<JournalOpen | null>;
  /** Durable (written and flushed) when it resolves; resolves at once while `off` or `full`. */
  append(updates: Omit<JournalUpdate, 'at'>[]): Promise<void>;
  /** Updates no longer needed, in any tab's file (told to the other tabs too). */
  forget(what: Forget): void;
  /** After `open`: the updates of gone tabs' files still needed move into this tab's file. */
  adopt(keep: string[]): Promise<void>;
  close(): void;
}

export const JOURNAL_DIR = 'cgw-journal';
const CHANNEL = 'cgw-journal';
const TAB_KEY = 'cgw-journal-tab';
export const DEFAULTS = {
  maxLiveBytes: 64 * 1024 * 1024,
  rewriteAfter: 1024 * 1024,
};

/** The calls a journal makes of its core, wherever the core runs. */
export type JournalCall =
  | { kind: 'open'; preferred: string | null; maxLiveBytes: number; rewriteAfter: number }
  | { kind: 'append'; updates: JournalUpdate[] }
  | { kind: 'forget'; what: Forget }
  | { kind: 'adopt'; keep: string[] }
  | { kind: 'close' };

type Transport = (call: JournalCall) => Promise<unknown>;

function preferredTab(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TAB_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberTab(id: string) {
  try {
    globalThis.sessionStorage?.setItem(TAB_KEY, id);
  } catch {
    // Without session storage the tab takes a new file at each start; the old one is adopted.
  }
}

class TransportJournal implements Journal {
  state: JournalState = { state: 'starting' };
  private readonly channel: BroadcastChannel | null;

  constructor(
    private readonly send: Transport,
    private readonly options: { maxLiveBytes: number; rewriteAfter: number },
    channelName = CHANNEL,
  ) {
    let channel: BroadcastChannel | null;
    try {
      channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    } catch {
      channel = null;
    }
    this.channel = channel;
    // Node's channel would keep a test's process alive (browsers have no `unref`).
    (channel as unknown as { unref?: () => void } | null)?.unref?.();
    if (channel)
      channel.onmessage = (event: MessageEvent<{ forget?: Forget }>) => {
        // Another tab no longer needs these: forgotten here if this tab's file holds them.
        if (event.data?.forget && this.on())
          void this.call({ kind: 'forget', what: event.data.forget }).catch(() => undefined);
      };
  }

  private on() {
    return this.state.state === 'on' || this.state.state === 'full';
  }

  private call(call: JournalCall): Promise<unknown> {
    return this.send(call).catch((error: unknown) => {
      this.state = { state: 'off', reason: String((error as Error)?.message ?? error) };
      throw error;
    });
  }

  async open(): Promise<JournalOpen | null> {
    try {
      const opened = (await this.call({
        kind: 'open',
        preferred: preferredTab(),
        ...this.options,
      })) as JournalOpen;
      rememberTab(opened.tabId);
      this.state = { state: 'on', tabId: opened.tabId };
      return opened;
    } catch {
      return null;
    }
  }

  async append(updates: Omit<JournalUpdate, 'at'>[]): Promise<void> {
    if (!this.on() || !updates.length) return;
    const at = Date.now();
    try {
      const written = (await this.call({
        kind: 'append',
        updates: updates.map((u) => ({ ...u, at })),
      })) as boolean;
      if (this.state.state === 'on' || this.state.state === 'full')
        this.state = { state: written ? 'on' : 'full', tabId: this.state.tabId };
    } catch (error) {
      console.warn('The journal could not be written; IndexedDB alone holds this save.', error);
    }
  }

  forget(what: Forget): void {
    if (!what.ids?.length && !what.pages?.length && !what.upTo?.length) return;
    try {
      this.channel?.postMessage({ forget: what });
    } catch {
      // No other tab is told; at their next start each file is checked against the store.
    }
    if (this.on()) void this.call({ kind: 'forget', what }).catch(() => undefined);
  }

  async adopt(keep: string[]): Promise<void> {
    if (!this.on()) return;
    await this.call({ kind: 'adopt', keep }).catch(() => undefined);
  }

  close(): void {
    this.channel?.close();
    if (this.on()) void this.send({ kind: 'close' }).catch(() => undefined);
    this.state = { state: 'off', reason: 'closed' };
  }
}

/** A journal whose core runs here, in order, over `dir` (tests; a worker's own use). */
export function coreJournal(
  dir: DirectoryLike | (() => Promise<DirectoryLike>),
  options: Partial<typeof DEFAULTS> & { channel?: string; newId?: () => string } = {},
): Journal {
  let core: JournalCore | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const merged = { ...DEFAULTS, ...options };
  const run = async (call: JournalCall): Promise<unknown> => {
    switch (call.kind) {
      case 'open': {
        const directory = typeof dir === 'function' ? await dir() : dir;
        core = new JournalCore(directory, {
          maxLiveBytes: call.maxLiveBytes,
          rewriteAfter: call.rewriteAfter,
          newId: options.newId ?? (() => crypto.randomUUID()),
        } satisfies CoreOptions);
        return core.open(call.preferred);
      }
      case 'append':
        return core!.append(call.updates);
      case 'forget':
        return core?.forget(call.what);
      case 'adopt':
        return core?.adopt(call.keep);
      case 'close':
        return core?.close();
    }
  };
  const send: Transport = (call) => {
    const next = queue.then(() => run(call));
    queue = next.catch(() => undefined);
    return next;
  };
  return new TransportJournal(send, merged, options.channel);
}

/**
 * The browser's journal: a dedicated worker over the Origin Private File System. Where workers,
 * the file system or sync access handles are missing, it opens `off`.
 */
export function workerJournal(options: Partial<typeof DEFAULTS> = {}): Journal {
  let worker: Worker | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  const send: Transport = (call) => {
    if (!worker) {
      if (typeof Worker !== 'function' || !globalThis.navigator?.storage?.getDirectory)
        return Promise.reject(new Error('No Origin Private File System here'));
      try {
        worker = new Worker(new URL('./journal.worker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      worker.onmessage = (event: MessageEvent<{ id: number; ok?: unknown; error?: string }>) => {
        const waiting = pending.get(event.data.id);
        if (!waiting) return;
        pending.delete(event.data.id);
        if (event.data.error !== undefined) waiting.reject(new Error(event.data.error));
        else waiting.resolve(event.data.ok);
      };
      worker.onerror = (event) => {
        for (const waiting of pending.values())
          waiting.reject(new Error(event.message || 'The journal worker failed'));
        pending.clear();
      };
    }
    const id = next++;
    const target = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // The update bytes are copied, not moved: the store still writes them to IndexedDB.
      target.postMessage({ ...call, id });
    });
  };
  return new TransportJournal(send, { ...DEFAULTS, ...options });
}
