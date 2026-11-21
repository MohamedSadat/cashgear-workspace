// The sync engine (SYNC_DESIGN.md, The sync loop): the same in the browser and on the desktop,
// over a LocalStore and a SyncApi. One pass, per synced workspace of the signed-in account:
//   0. upload assets the server lacks (before the operations that may name them: a cover, a
//      row's files);
//   1. push the outbox, oldest first, and take the server's answers into the mirror;
//   2. push document updates not yet sent, in batches the server takes (at most 200 updates and
//      4 MB a request, an update over 1 MB alone), each settled before the next;
//   3. pull the change feed until it has no more (the whole tree when the feed has been pruned
//      past this device's cursor), and resync any subtree access changed on;
//   4. pull documents this device holds whose server head moved, then a bounded number of pinned
//      pages it does not hold yet (Phase 12: and of pinned databases' rows' documents), by the
//      batch route, a hundred pages a request;
//   5. repair pages whose own updates the worker refused (their whole state, which carries what
//      the refused ones referred to), then compare a few pages' state hashes with the server's,
//      and repair those that differ.
// Phase 4 (databases): after the feed, the rows of databases this device holds in full and has
// not fetched yet come by their own route (at most 4 requests of 1,000 rows a pass, the next pass
// soon while some remain); the feed keeps held rows fresh after that; pins hold the databases in
// them; rows' documents are pulled and pushed as pages' are. Phase 12: a pinned database holds
// each of its rows' documents too (up to 5,000), fetched as pinned pages are.
// Failures back off exponentially with jitter, capped at 5 minutes and never shorter than the
// server's `Retry-After`; a timer that fires far later than it was set for (the machine slept)
// runs a pass at once with the backoff reset. A 401 pauses the loop until the user signs in
// again. Nothing waiting is ever discarded: what the server will not take is set aside (the
// store's quarantine, which the shell makes recovered pages of) or kept in the corrupt area, and
// the user is told.
//
// Phase 6 (real time, `realtime.1`): with a hub connection open (`setRealtime`), the followed
// workspaces' feeds say when they move (a pass then, so the periodic one slows to 30 s), the pages
// the shell has open (`live`) are joined, a save of one (`saved`) goes through the hub at once, and
// the hub's frames bring others' validated updates as they land: a frame that continues from this
// device's cursor is taken as a pull's answer would be; a gap, another epoch or an incomplete one
// makes the page pull over HTTP. A page's pushes, through the hub or in a pass, never overlap, nor
// do its pulls and frames. With the connection gone or never made, the engine is Phase 3's.
import { LOCAL_ROW_LIMIT, type DatabaseRecord } from '../db/types';
import { uuidv7, type Id } from '../ids';
import { uploadOps } from '../remote';
import {
  STORE_SCHEMA_VERSION,
  type AssetRecord,
  type DbHold,
  type EntityRecord,
  type EntityType,
  type LocalStore,
  type Operation,
  type OperationType,
  type OpResult,
  type PageRecord,
  type PinRecord,
  type RemoteBatch,
  type RowRecord,
  type StoredDoc,
  type StoredUpdate,
  type WorkspaceRecord,
} from '../types';
import {
  DOCS_PULL_PAGES,
  OfflineError,
  SyncHttpError,
  dependsOnCreate,
  type Account,
  type DocCodec,
  type DocPull,
  type DocsPullItem,
  type DocStateHash,
  type QueryAnswer,
  type QueryRequest,
  type ServerChange,
  type ServerTree,
  type SyncApi,
} from './api';
import {
  REALTIME_LIMITS,
  type AccessRevoked,
  type ChangesAvailable,
  type JoinedPage,
  type RealtimeState,
  type RealtimeTransport,
  type RelayFrame,
} from './realtime';

export type SyncState = 'localOnly' | 'signedOut' | 'offline' | 'syncing' | 'synced' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** Operations and document updates waiting to be sent. */
  waiting: number;
  /** When the last full pass finished, ISO. */
  lastSynced: string | null;
}

/** What the engine tells the app; the shell turns notices into messages. */
export type SyncEvent =
  /** Records changed from the server: read the mirror again. */
  | { kind: 'mirror'; workspaceId: Id }
  /** Updates pulled for a page: an open document applies them. */
  | { kind: 'doc'; pageId: Id; updates: Uint8Array[] }
  /** A page's document was replaced (an epoch change, edit access lost): reopen it. */
  | { kind: 'docReset'; pageId: Id }
  | { kind: 'members'; workspaceId: Id }
  | {
      kind: 'notice';
      code: string;
      workspaceId: Id;
      pageId?: Id;
      /**
       * Phase 8: for an operation the server refused, which one (its type, and for an update the
       * fields it set), so the message can name what was undone (`access.denied`).
       */
      refused?: RefusedOp;
    }
  /** Pending quarantine entries exist: make recovered pages of them. */
  | { kind: 'recover'; workspaceId: Id }
  /** Pins or the pages held here changed: redraw what is available offline. */
  | { kind: 'offline'; workspaceId: Id }
  /** Rows of a database changed here, or its hold did (a fetch moved on): read them again. */
  | { kind: 'rows'; workspaceId: Id; databaseId: Id }
  /** Phase 6: the feed said a page's comments changed; an open comments list reads them again. */
  | { kind: 'comments'; workspaceId: Id; pageId: Id }
  /** Phase 6: the person's inbox changed (a notification made or read). */
  | { kind: 'notifications'; workspaceId: Id };

/** How much of a database this device keeps (`holdProgress`). */
export interface HoldProgress {
  /** The hold, or null when the device keeps none of the database's rows. */
  hold: DbHold | null;
  /** Rows of the database this device holds, trashed rows and templates left out. */
  held: number;
  /** Rows the server has, as it last said (`rowCount`); the device's own count while local. */
  total: number;
  /** Every row is here and the feed keeps them fresh: the database is queried on this device. */
  local: boolean;
}

export interface SyncOptions {
  /** How often a pass runs while nothing else triggers one. */
  intervalMs?: number;
  /** The same while the hub's connection is open (its feed news runs passes): 30 s. */
  liveIntervalMs?: number;
  /** For tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  /** Wall-clock milliseconds, for tests: a timer that fires far too late means the machine slept. */
  now?: () => number;
  /** Pages a batch pull of documents asks for (default and most 100). */
  pinBatch?: number;
  /** Batch pulls a pass makes for what pins cover and the device does not hold (default 2). */
  pinRequests?: number;
  /** Rows a request of a database's rows asks for (default 1,000), and requests a pass (4). */
  rowsPage?: number;
  rowsRequests?: number;
}

/** How much of a workspace is kept on this device for offline use. */
export interface OfflineProgress {
  /** The workspace's pins. */
  pins: PinRecord[];
  /** Live pages the pins cover: pinned pages, and every page under a subtree pin. */
  pinned: number;
  /** Of those, the pages whose document this device holds. */
  held: number;
  /** Pinned pages still to fetch. */
  toFetch: number;
  /** Every page of the workspace this device holds, pinned or only opened (rows' pages too). */
  available: number;
  /**
   * Phase 12: the documents pinned databases hold, each row's that has one on the server (its
   * templates', and up to `PIN_ROW_DOCS` rows' a database, in its row order).
   */
  rows: number;
  /** Of those, the documents this device holds. */
  rowsHeld: number;
  /** Rows' documents still to fetch. */
  rowsToFetch: number;
}

const MAX_BACKOFF = 5 * 60_000;
/** The longest a timer is set for: a long wait is a chain of these, so a sleep shows. */
const TICK = 15_000;
/** A timer this much later than it was set for means the machine slept (or the clock jumped). */
const SLEEP_GAP = 90_000;
/** The next pass after one that left work for later (an outbox, pinned pages to fetch). */
const SOON = 100;
const POOL_LOW = 4;
const POOL_FILL = 8;
const EMPTY_UPDATE = new Uint8Array([0, 0]);

/** The server's limits on a document push (SYNC_DESIGN.md, What the server checks). */
export const PUSH_LIMITS = {
  updates: 200,
  bytes: 4 * 1024 * 1024,
  /** Larger than this, an update goes alone (the server refuses it, and only it). */
  alone: 1024 * 1024,
};
/** Unsent updates read at a time, and how many such reads a pass makes before it yields. */
const PUSH_READ = 200;
const PUSH_ROUNDS = 10;
/** Batch pulls a pass makes for what pins cover (Phase 12), each of `DOCS_PULL_PAGES` pages. */
const PIN_REQUESTS = 2;
/** Batch pulls a pass makes for held pages whose head moved. */
const MOVED_REQUESTS = 10;
/** With no batch route (an older server), pinned pages pulled one by one a pass (Phase 3's). */
const PIN_SINGLES = 24;
const PIN_PARALLEL = 4;
/** How long the pins' fetch waits after a 429 or 503 that named no `Retry-After`. */
const PIN_WAIT = 60_000;
/** A pinned database holds at most this many rows' documents (and its templates'). */
export const PIN_ROW_DOCS = LOCAL_ROW_LIMIT;
/** State-hash checks a pass makes, and passes a check waits for the server to catch up. */
const CHECKS_PER_PASS = 4;
const CHECK_TRIES = 20;
/** Waiting updates counted for the status (a long outbox shows at least this many). */
const WAITING_CAP = 5000;
/**
 * Read whole when an account's data is to be removed: the waiting count's cap could hide what
 * still waits. Not larger: IndexedDB's `getAll` takes a 32-bit count.
 */
const REMOVE_CAP = 1_000_000;

/** Rows a request of a database's rows asks for, and such requests a pass makes. */
const ROWS_PAGE = 1000;
const ROWS_REQUESTS = 4;

/** The periodic pass while the hub's connection is open. */
const LIVE_INTERVAL = 30_000;
/**
 * A pass the hub's news runs (a feed that moved, access lost) comes no sooner after the last: while
 * others type, every push moves the feed, and a device reads it at most once a second (Phase 3
 * polled every 1.5 s); a rename still shows within a second.
 */
const WAKE_SPACING = 1000;
/** What one push through the hub carries: a batch the hub takes; anything more goes over HTTP. */
const LIVE_LIMITS = {
  updates: REALTIME_LIMITS.pushUpdates,
  bytes: REALTIME_LIMITS.pushBytes,
  alone: REALTIME_LIMITS.pushBytes,
};
/** Refusals of a push through the hub that mean what the same refusal over HTTP means. */
const LIVE_REFUSALS = new Set([
  'doc.epochMismatch',
  'access.denied',
  'not.found',
  'page.gone',
  'client.tooOld',
]);

/** Operations that change a page's whole subtree. */
const SUBTREE_OPS = new Set(['page.move', 'page.trash', 'page.restore', 'page.delete']);

const PAGE_OPS: OperationType[] = [
  'page.create',
  'page.update',
  'page.move',
  'page.trash',
  'page.restore',
  'page.delete',
];
/** The operations whose answers carry each kind of record the feed and the tree bring. */
const CARRIES: Record<LaterType, ReadonlySet<OperationType>> = {
  page: new Set(PAGE_OPS),
  row: new Set([...PAGE_OPS, 'row.update']),
  database: new Set(['db.update']),
};

type LaterType = 'page' | 'row' | 'database';
type Later =
  | { type: 'page'; record: PageRecord }
  | { type: 'row'; record: RowRecord }
  | { type: 'database'; record: DatabaseRecord };

const poolKey = (workspaceId: Id) => `sync:yjsPool:${workspaceId}`;
const registeredKey = (workspaceId: Id) => `sync:yjsRegistered:${workspaceId}`;
const refusedKey = (workspaceId: Id) => `sync:refused:${workspaceId}`;

/**
 * This device's own updates of a page that the worker refused, until a repair carries them to the
 * server (`noteRefusals`, `repairRefused`). Kept as a preference per workspace, written before the
 * cursor moves past the answer that told of them, so a stop at any moment loses nothing.
 */
interface Refusal {
  /** Refused updates (ids) whose content no repair has brought to the server yet. */
  updates: Id[];
  /**
   * The repair sent for them: its update's id, the refused updates it carries, and the sequence
   * the server gave it (null until the answer came: it is sent again under the same id).
   */
  repair: { updateId: Id; covers: Id[]; seq: number | null } | null;
}
type Refusals = Record<Id, Refusal>;

/** The signed-in account (no credential), for a start with no network. */
export const ACCOUNT_PREF = 'sync:account';

const partsOf = (doc: StoredDoc) => [
  ...(doc.snapshot ? [doc.snapshot] : []),
  ...doc.updates.map((u) => u.data),
];

/** A page's unsent updates in batches the server takes, in log order. */
export function pushBatches(updates: StoredUpdate[], limits = PUSH_LIMITS): StoredUpdate[][] {
  const out: StoredUpdate[][] = [];
  let batch: StoredUpdate[] = [];
  let bytes = 0;
  for (const update of updates) {
    const size = update.data.byteLength;
    if (size > limits.alone) {
      if (batch.length) out.push(batch);
      out.push([update]);
      batch = [];
      bytes = 0;
      continue;
    }
    if (batch.length && (batch.length >= limits.updates || bytes + size > limits.bytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(update);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** Strings in code-unit order, as the database's row order compares them (db/query.ts). */
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The pinned pages that are databases' pages. */
function pinnedDatabases(pages: PageRecord[], pinned: ReadonlySet<Id>): Id[] {
  return pages.filter((p) => p.kind === 'database' && pinned.has(p.id)).map((p) => p.id);
}

export class SyncEngine {
  private account: Account | null = null;
  /** Whose changes the status counts while signed out (the cached or last account). */
  private known: Account | null = null;
  private running = false;
  private current: Promise<void> | null = null;
  private stopped = true;
  private again = false;
  private timer: unknown = null;
  /** When the scheduled pass is due, and when and for how long the timer was set (wall clock). */
  private due = 0;
  private armedAt = 0;
  private armedFor = 0;
  private failures = 0;
  /** No pass before this (the server's `Retry-After`), wall clock. */
  private notBefore = 0;
  /** A pass left work for later: the next comes soon. */
  private backlog = false;
  /**
   * A live push finished while a pass ran: the pass may have counted its updates as waiting just
   * before they were acknowledged, so the status is counted again when the pass ends.
   */
  private recount = false;
  private storeChecked = false;
  private status_: SyncStatus = { state: 'signedOut', waiting: 0, lastSynced: null };
  /** Reports started, and the latest one shown: one that finishes after a later one is dropped. */
  private reportsStarted = 0;
  private reportShown = 0;
  private readonly listeners = new Set<(event: SyncEvent) => void>();
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  /** Session Yjs client ids, one per workspace (Q9). */
  private readonly sessionIds = new Map<Id, number>();
  /** Pages to pull on the next pass: opened, or their head moved. */
  private readonly wanted = new Set<Id>();
  /** Pages whose pushes the server will not take (too old a client): not retried this session. */
  private readonly heldBack = new Set<Id>();
  /** Pages this session pushed updates to, until the server's record of them is seen. */
  private readonly edited = new Set<Id>();
  /** State-hash checks to make, with the passes each has waited. */
  private readonly checks = new Map<Id, number>();
  /** Pages checked on opening this session (once a session each). */
  private readonly opened = new Set<Id>();
  /** Pages whose failed repair was reported this session. */
  private readonly repairReported = new Set<Id>();
  /** Refused updates waiting for a repair, per workspace, once read from the store. */
  private readonly refusals = new Map<Id, Refusals>();
  /** Quarantine entries already told of; null until the first pass has read them. */
  private seen: Set<Id> | null = null;
  /** Something may have been set aside (or pending entries remain): look after the pass. */
  private quarantineDirty = true;
  /** Workspaces whose held pages changed in this pass. */
  private readonly heldChanged = new Set<Id>();
  /**
   * Phase 12: pages a batch pull refused (not found, gone, not readable): not asked for again until
   * the feed or a tree brings their record anew.
   */
  private readonly pullRefused = new Set<Id>();
  /**
   * Pinned databases whose rows' documents were all held when last read: not read whole again
   * until their hold or record changes, or a row that changed since lacks its document.
   */
  private readonly rowDocsHeld = new Set<Id>();
  /** Rows of those databases that came since (the feed, a fetch, a query), by database. */
  private readonly rowDocsChanged = new Map<Id, Map<Id, RowRecord>>();
  /** No batch pull for what pins cover before this (the server's `Retry-After`), wall clock. */
  private pinsNotBefore = 0;
  /** False once the server refused the batch route (an older one): pages go one by one. */
  private batchPull = true;
  /** Workspaces where a tree operation on a subtree was answered: the mirror is checked after the feed. */
  private readonly reconcile = new Set<Id>();
  private mine = new Set<Id>();
  /** `report` read which workspaces sync (`mine`), none perhaps, since the last change of it. */
  private mineRead = false;
  private passes = 0;
  /** Requests for databases' rows this pass has made. */
  private rowRequests = 0;
  /**
   * Records the feed or the tree brought while only operations whose answers carry something else
   * waited on them (a visit, a favourite, a page operation on a database's page): the store keeps
   * the local record while anything waits, and no answer brings this one back, so it is taken
   * once nothing waits, unless something newer came meanwhile. Keyed by type and id.
   */
  private readonly later = new Map<string, Later>();

  // Real time (Phase 6) ------------------------------------------------------------------------------
  private realtime: RealtimeTransport | null = null;
  private offRealtime: (() => void)[] = [];
  /** Bumped whenever the hub's connection (or the account) changes: older answers are dropped. */
  private connection = 0;
  /** Pages the shell has open, and those of them joined on this connection. */
  private readonly livePages = new Set<Id>();
  private readonly joined = new Map<Id, JoinedPage>();
  private readonly joining = new Set<Id>();
  /** The workspaces followed on this connection, as a key (sorted ids). */
  private followed = '';
  /** Each page's chain: its pushes (live or a pass's), pulls and frames run one at a time. */
  private readonly pageChains = new Map<Id, Promise<void>>();
  /** Pages with a live push waiting to start: saves meanwhile ride on it. */
  private readonly liveQueued = new Set<Id>();
  /** Updates sent through the hub since this pass began (a pass that read them skips them). */
  private readonly sentLive = new Set<Id>();
  /** No push through the hub before this (it asked to be left alone), wall clock. */
  private liveNotBefore = 0;
  private readonly joinListeners = new Set<(pageId: Id, joined: boolean) => void>();
  /** Work outside passes (frames, live pushes, joins): `idle` waits for it too. */
  private readonly background = new Set<Promise<void>>();
  private lastPassAt = 0;

  constructor(
    private readonly store: LocalStore,
    private readonly api: SyncApi,
    private readonly codec: DocCodec,
    private readonly options: SyncOptions = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // Lifecycle --------------------------------------------------------------------------------------

  get status(): SyncStatus {
    return this.status_;
  }

  get signedIn(): Account | null {
    return this.account;
  }

  /**
   * The account this device is signed in as, also while a 401 pauses it (the session ended
   * elsewhere: its changes still wait for it); null only once it signs out, or the server says no
   * one is signed in. Its synced workspaces are the ones shown here.
   */
  get remembered(): Account | null {
    return this.account ?? this.known;
  }

  /**
   * Signs the engine in (after `me()` answered, or with `cachedAccount()` when there is no
   * network: then `offline` says so at once) or out. Signing in keeps the account (never a
   * credential) for the next start; signing out forgets it, and keeps everything local.
   */
  setAccount(account: Account | null, options: { offline?: boolean } = {}) {
    this.account = account;
    this.known = account;
    this.mine = new Set();
    this.mineRead = false;
    this.sessionIds.clear();
    const kept: Account | null = account && {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      deviceId: account.deviceId,
    };
    void this.store
      .setPref(ACCOUNT_PREF, kept)
      .catch((error: unknown) => console.warn('Could not keep the account:', error));
    // What was joined was this account's: joined again as the new one (or not at all).
    this.dropJoins();
    if (account && this.connected) this.track(this.rejoin(this.connection));
    if (account) {
      this.failures = 0;
      // The account's workspaces are listed at its first pass (one removed from this device at a
      // sign-out comes back at once), not up to ten passes later.
      this.passes = 0;
      if (options.offline) void this.report('offline');
      else {
        // Signed in: "Syncing" at once, not the start's "Signed out" until the first pass ends
        // (about 200 ms at one desktop start in five, Phase 8's kill test); the count follows.
        if (this.status_.state === 'signedOut') {
          this.status_ = { ...this.status_, state: 'syncing' };
          for (const listener of this.statusListeners) listener(this.status_);
        }
        void this.report('syncing', false);
      }
      this.kick(0);
    } else void this.report('signedOut');
  }

  /** The account last signed in on this device, for a start with no network; null if none. */
  async cachedAccount(): Promise<Account | null> {
    const value = await this.store.getPref<Account | null>(ACCOUNT_PREF);
    if (!value || typeof value.id !== 'string' || typeof value.email !== 'string') return null;
    return {
      id: value.id,
      email: value.email,
      displayName: value.displayName ?? '',
      deviceId: value.deviceId ?? null,
    };
  }

  /**
   * What of an account's synced workspaces still waits to be sent from this device: operations,
   * document updates (rows' too), refused updates being repaired, and pages set aside and not
   * recovered yet. A sign-out that removes the account's data asks this first.
   */
  async accountWaiting(accountId: Id): Promise<number> {
    const { ids, pages } = await this.accountHoldings(accountId);
    if (!ids.size) return 0;
    let waiting = 0;
    for (const id of ids) {
      waiting += (await this.store.nextOutboxBatch(REMOVE_CAP, id)).length;
      for (const refusal of Object.values(await this.refusalsOf(id)))
        waiting += refusal.updates.length;
    }
    for (const doc of await this.store.unsentDocUpdates(REMOVE_CAP))
      if (pages.has(doc.pageId)) waiting += doc.updates.length;
    for (const entry of await this.store.quarantine(null))
      if (ids.has(entry.workspaceId) && entry.status === 'pending') waiting += 1;
    return waiting;
  }

  /**
   * Removes an account's synced workspaces from this device (a sign-out that asks for it): their
   * records, documents, files and search entries go as a lost workspace's do, and what was set
   * aside from them is dismissed. Only once the account is signed out here (a pass could pull them
   * back) and nothing of theirs waits to be sent: otherwise nothing is removed and the answer
   * counts what waits. "On this device only" workspaces are never touched.
   */
  async removeAccountData(accountId: Id): Promise<{ removed: Id[]; waiting: number }> {
    if (this.account?.id === accountId) throw new Error('Sign the account out before removing it');
    // A pass still running finishes first, so nothing it writes lands after the removal.
    await (this.current ?? Promise.resolve());
    const waiting = await this.accountWaiting(accountId);
    if (waiting) return { removed: [], waiting };
    const { ids } = await this.accountHoldings(accountId);
    for (const id of ids) {
      await this.store.applyRemote({ workspaceId: id, deleteWorkspace: true });
      this.refusals.delete(id);
    }
    for (const entry of await this.store.quarantine(null))
      if (ids.has(entry.workspaceId) && entry.status !== 'dismissed')
        await this.store.settleQuarantine(entry.id, 'dismissed');
    this.mine = new Set();
    this.mineRead = false;
    for (const id of ids) this.emit({ kind: 'mirror', workspaceId: id });
    return { removed: [...ids], waiting: 0 };
  }

  /** An account's synced workspaces on this device, and every page and row of them. */
  private async accountHoldings(accountId: Id): Promise<{ ids: Set<Id>; pages: Set<Id> }> {
    const snapshot = await this.store.readMirror(null);
    const ids = new Set(
      snapshot.workspaces.filter((w) => !w.localOnly && w.accountId === accountId).map((w) => w.id),
    );
    const pages = new Set(snapshot.pages.filter((p) => ids.has(p.workspaceId)).map((p) => p.id));
    for (const database of snapshot.databases)
      if (ids.has(database.workspaceId))
        for (const row of await this.store.readRows(database.id)) pages.add(row.id);
    return { ids, pages };
  }

  start() {
    this.stopped = false;
    this.kick(0);
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  /**
   * A local change: nothing is "synced" while it waits, so the status says so at once (a pass
   * starts only after the change settles), and a pass comes soon unless the loop is backing off
   * (offline: the network's return kicks it).
   */
  changed() {
    this.waitingOne();
    if (this.failures === 0) this.kick();
  }

  /** One more change waits: the status says so at once. */
  private waitingOne() {
    const state = this.status_.state;
    if (state === 'synced' || state === 'offline' || (state === 'signedOut' && this.known)) {
      this.status_ = {
        ...this.status_,
        state: state === 'synced' ? 'syncing' : state,
        waiting: this.status_.waiting + 1,
      };
      for (const listener of this.statusListeners) listener(this.status_);
    }
  }

  /**
   * A pass now, awaited (after one already running): what was written here is on the server when
   * it returns, unless the network or the server failed (the status says which).
   */
  async syncNow(): Promise<void> {
    while (this.current) await this.current;
    this.clear();
    await this.run();
  }

  /** Resolves when no pass is running and nothing else is under way (frames, live pushes, joins). */
  async idle(): Promise<void> {
    for (;;) {
      while (this.current) await this.current;
      if (!this.background.size) return;
      await Promise.allSettled([...this.background]);
    }
  }

  /** Keeps work outside passes where `idle` sees it; what fails is logged, never thrown. */
  private track(work: Promise<unknown>) {
    const done: Promise<void> = work.then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
          console.warn('Real-time sync failed:', error);
      },
    );
    this.background.add(done);
    void done.then(() => this.background.delete(done));
  }

  /**
   * A pass soon: after a local change, when the network returns, on focus, when a page opens. The
   * server's `Retry-After` is still honoured.
   */
  kick(delayMs = 300) {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(delayMs);
  }

  /**
   * A pass within `delayMs`, never later than one already due (a stream of news must not keep
   * putting it off), and not while the loop backs off.
   */
  private soon(delayMs: number) {
    if (this.stopped || this.failures) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const at = Math.max(this.now() + delayMs, this.notBefore);
    if (this.timer === null || this.due > at) this.schedule(delayMs);
  }

  on(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  private emit(event: SyncEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private notice(code: string, workspaceId: Id, pageId?: Id, refused?: RefusedOp) {
    this.emit({
      kind: 'notice',
      code,
      workspaceId,
      ...(pageId ? { pageId } : {}),
      ...(refused ? { refused } : {}),
    });
  }

  private clear() {
    if (this.timer !== null)
      (this.options.clearTimer ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  /** The next pass in `delayMs` (not before `Retry-After`), as a chain of short timers. */
  private schedule(delayMs: number) {
    this.clear();
    const now = this.now();
    this.due = Math.max(now + delayMs, this.notBefore);
    this.arm(now);
  }

  private arm(now: number) {
    const wait = Math.max(0, Math.min(this.due - now, TICK));
    this.armedAt = now;
    this.armedFor = wait;
    this.timer = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(
      () => this.fire(),
      wait,
    );
  }

  private fire() {
    this.timer = null;
    if (this.stopped) return;
    const now = this.now();
    if (now - this.armedAt - this.armedFor > SLEEP_GAP) {
      // Far later than set: the machine slept. What waited is due now, and the backoff restarts.
      this.failures = 0;
      void this.run();
      return;
    }
    if (now >= this.due) void this.run();
    else this.arm(now);
  }

  /** The status, counted from the store; `pass` false: not the end of a pass (`lastSynced` stays). */
  private async report(state: SyncState, pass = true) {
    // Reports read the store, so they can finish out of order: the sign-out a start begins with
    // must not land after the sign-in that follows it and say "Signed out" while signed in.
    const order = ++this.reportsStarted;
    const owner = this.account ?? this.known;
    // Read once until the account or an upload changes it, even when none syncs: the read takes
    // every record on the device, and a device of local workspaces made it at every pass.
    if (!this.mine.size && !this.mineRead) {
      const workspaces = (await this.store.readMirror(null)).workspaces.filter(
        (w) => !w.localOnly && !w.deletedAt && (!owner || w.accountId === owner.id),
      );
      this.mine = new Set(workspaces.map((w) => w.id));
      this.mineRead = true;
    }
    const ops = this.mine.size
      ? (await this.store.nextOutboxBatch(WAITING_CAP)).filter((op) =>
          this.mine.has(op.workspaceId),
        ).length
      : 0;
    const docs = (await this.store.unsentDocUpdates(WAITING_CAP))
      // A page held back (this build is too old for it) waits for an update, not for a pass.
      .filter((d) => !this.heldBack.has(d.pageId))
      .reduce((n, d) => n + d.updates.length, 0);
    // Refused updates are not on the server until their repair is: they wait too.
    let refused = 0;
    for (const workspaceId of this.mine)
      for (const refusal of Object.values(await this.refusalsOf(workspaceId)))
        refused += refusal.updates.length;
    const waiting = ops + docs + refused;
    if (order < this.reportShown) return;
    this.reportShown = order;
    this.status_ = {
      // A pass that ends with changes waiting (made while it ran) has not synced them.
      state: state === 'synced' && waiting > 0 ? 'syncing' : state,
      waiting,
      lastSynced: state === 'synced' && pass ? this.iso() : this.status_.lastSynced,
    };
    for (const listener of this.statusListeners) listener(this.status_);
  }

  private run(): Promise<void> {
    if (this.running || this.stopped) return this.current ?? Promise.resolve();
    this.running = true;
    this.again = false;
    this.backlog = false;
    this.lastPassAt = this.now();
    const pass = this.runPass().finally(() => {
      this.running = false;
      this.current = null;
      this.afterPass();
      if (this.recount) {
        this.recount = false;
        // "Synced" as soon as nothing waits, not at the next pass (30 s while connected).
        if (!this.liveQueued.size && this.status_.state === 'syncing')
          void this.report('synced', false);
      }
    });
    this.current = pass;
    return pass;
  }

  private retryAfter = 0;

  private async runPass() {
    this.retryAfter = 0;
    try {
      await this.syncOnce();
      this.failures = 0;
    } catch (error) {
      this.failures++;
      if (error instanceof SyncHttpError && error.status === 401) {
        // The session ended: paused until the user signs in again; nothing is discarded, and the
        // status still counts what waits for the account.
        this.account = null;
        await this.report('signedOut');
      } else await this.report(error instanceof OfflineError ? 'offline' : 'error');
      if (error instanceof SyncHttpError && error.retryAfterMs) {
        this.retryAfter = error.retryAfterMs;
        this.notBefore = this.now() + error.retryAfterMs;
      }
      if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
        console.warn('Sync failed:', error);
      // The hub may answer while HTTP did not: what it should follow and join still is.
      if (this.connected && this.account) this.track(this.afterPassLive(this.connection));
    }
  }

  private afterPass() {
    if (this.stopped) return;
    // While the hub's connection is open its news runs passes; the timer is only a safety net.
    const base = this.connected
      ? (this.options.liveIntervalMs ?? LIVE_INTERVAL)
      : (this.options.intervalMs ?? 1500);
    const delay = this.failures
      ? Math.max(
          this.retryAfter,
          Math.min(MAX_BACKOFF, 1000 * 2 ** (this.failures - 1)) *
            (0.5 + (this.options.random ?? Math.random)()),
        )
      : this.again
        ? 50
        : this.backlog
          ? SOON
          : base;
    if (this.account || this.again) this.schedule(delay);
  }

  // One pass ---------------------------------------------------------------------------------------

  async syncOnce(): Promise<void> {
    const account = this.account;
    if (!account) {
      await this.report('signedOut');
      return;
    }
    if (!this.storeChecked) {
      // A store newer than this build is refused when it opens; should one get here, nothing is
      // sent from it (the shell asks the user to update).
      if ((await this.store.schemaVersion()) > STORE_SCHEMA_VERSION) {
        await this.report('error');
        this.stop();
        return;
      }
      this.storeChecked = true;
    }
    let held = await this.syncedWorkspaces(account);
    this.mine = new Set(held.map((w) => w.id));
    this.rowRequests = 0;
    // Whatever went through the hub before now is marked sent in the store, so this pass's reads
    // leave it out; what goes through it during the pass is kept here to be left out too.
    this.sentLive.clear();
    await this.report(this.status_.state === 'offline' ? 'offline' : 'syncing');
    if (!this.seen) this.seen = new Set((await this.store.quarantine(null)).map((e) => e.id));
    try {
      // Workspaces the account gained or lost on another device, now and then.
      if (this.passes++ % 10 === 0) {
        const server = await this.api.listWorkspaces();
        const known = new Set(held.map((w) => w.id));
        const there = new Set(server.map((w) => w.id));
        for (const workspace of server)
          if (!known.has(workspace.id)) await this.firstSync(workspace.id, account);
        for (const workspace of held)
          if (!there.has(workspace.id)) await this.lose(workspace.id, false);
        held = await this.syncedWorkspaces(account);
        this.mine = new Set(held.map((w) => w.id));
      }
      for (const workspace of held) {
        try {
          // Files first: the server takes a cover or a row's file only once it holds the bytes, so
          // an operation naming a file sent before them is refused and the file lost.
          await this.uploadAssets(workspace);
          await this.pushOutbox(workspace, account);
          await this.pushDocs(workspace);
          await this.pullChanges(workspace, account);
          await this.reconcileTree(workspace.id, account);
          const mirror = await this.store.readMirror(workspace.id);
          const pinned = await this.pinnedPages(workspace.id, mirror.pages);
          await this.holdPinned(workspace, mirror.pages, mirror.databases, pinned);
          await this.fetchRows(workspace, mirror.databases);
          await this.pullDocs(workspace, mirror.pages, pinned);
          await this.fetchPinned(workspace, mirror.pages, pinned);
          await this.repairRefused(workspace);
          await this.runChecks(workspace);
        } catch (error) {
          // The workspace is gone for this account: forget it here, as another device's removal would.
          if (
            error instanceof SyncHttpError &&
            error.status === 404 &&
            error.code === 'not.found'
          ) {
            await this.lose(workspace.id, true);
            continue;
          }
          throw error;
        } finally {
          if (this.heldChanged.delete(workspace.id))
            this.emit({ kind: 'offline', workspaceId: workspace.id });
        }
      }
    } finally {
      await this.lookAtQuarantine().catch((error: unknown) =>
        console.warn('Could not read the quarantine:', error),
      );
    }
    await this.report('synced');
    // The workspaces this pass found are followed, and open pages not joined yet (made here and
    // only now on the server, say) are joined.
    if (this.connected) this.track(this.afterPassLive(this.connection));
  }

  private async lose(workspaceId: Id, notice: boolean) {
    await this.store.applyRemote({ workspaceId, deleteWorkspace: true });
    this.quarantineDirty = true;
    this.emit({ kind: 'mirror', workspaceId });
    if (notice) this.notice('workspace.lost', workspaceId);
  }

  private async syncedWorkspaces(account: Account): Promise<WorkspaceRecord[]> {
    return (await this.store.readMirror(null)).workspaces.filter(
      (w) => !w.localOnly && w.accountId === account.id && !w.deletedAt,
    );
  }

  /** A workspace this device does not hold yet: its whole tree, then the feed from its cursor. */
  private async firstSync(workspaceId: Id, account: Account) {
    const tree = await this.api.tree(workspaceId, null);
    await this.applyBatch({
      ...treeBatch(workspaceId, tree, account, null),
      cursor: tree.cursor,
    });
    this.emit({ kind: 'mirror', workspaceId });
  }

  /**
   * A remote batch into the store. Records it brings while only operations whose answers carry
   * something else wait on them are kept to be taken later (`later`); the rows events say which
   * databases' rows it changed.
   */
  private async applyBatch(batch: RemoteBatch) {
    const workspaceId = batch.workspaceId;
    await this.noteLater(batch);
    const touched = new Set([
      ...(batch.rows ?? []).map((r) => r.databaseId),
      ...(batch.holds ?? []).map((h) => h.databaseId),
      ...(batch.databases ?? []).map((d) => d.id),
    ]);
    // A row delete names no database: every held one is read again.
    const removed = !!batch.deleteRows?.length;
    this.noteRowDocs(batch, removed);
    await this.store.applyRemote(batch);
    if (!touched.size && !removed) return;
    for (const hold of await this.store.dbHolds(workspaceId))
      if (removed || touched.has(hold.databaseId))
        this.emit({ kind: 'rows', workspaceId, databaseId: hold.databaseId });
  }

  /**
   * What a batch means for the pinned databases' rows' documents (`fetchPinned`): a row that came
   * may have a document this device lacks, so it is looked at; a database whose hold or record
   * changed (a row made or removed elsewhere moves its count), or a row removed, is read whole.
   */
  private noteRowDocs(batch: RemoteBatch, removed: boolean) {
    if (removed) {
      this.rowDocsHeld.clear();
      this.rowDocsChanged.clear();
      return;
    }
    for (const row of batch.rows ?? []) {
      if (!this.rowDocsHeld.has(row.databaseId)) continue;
      let changed = this.rowDocsChanged.get(row.databaseId);
      if (!changed) this.rowDocsChanged.set(row.databaseId, (changed = new Map()));
      changed.set(row.id, row);
    }
    for (const id of [
      ...(batch.holds ?? []).map((h) => h.databaseId),
      ...(batch.databases ?? []).map((d) => d.id),
    ]) {
      this.rowDocsHeld.delete(id);
      this.rowDocsChanged.delete(id);
    }
  }

  /** What waits in a workspace's outbox, by entity: the types of operation on each. */
  private async waiting(workspaceId: Id): Promise<Map<Id, Set<OperationType>>> {
    const out = new Map<Id, Set<OperationType>>();
    for (const op of await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId)) {
      let types = out.get(op.entityId);
      if (!types) out.set(op.entityId, (types = new Set()));
      types.add(op.type);
    }
    return out;
  }

  /** Notes the records of a batch the store will skip and no answer will bring back (`later`). */
  private async noteLater(batch: RemoteBatch) {
    const records: Later[] = [
      ...(batch.pages ?? []).map((record) => ({ type: 'page' as const, record })),
      ...(batch.rows ?? []).map((record) => ({ type: 'row' as const, record })),
      ...(batch.databases ?? []).map((record) => ({ type: 'database' as const, record })),
    ];
    if (!records.length) return;
    const waiting = await this.waiting(batch.workspaceId);
    for (const later of records) {
      const key = `${later.type}:${later.record.id}`;
      const types = waiting.get(later.record.id);
      if (!types || [...types].some((t) => CARRIES[later.type].has(t))) this.later.delete(key);
      else this.later.set(key, later);
    }
  }

  /** Records kept for later whose operations have all been answered: taken now, unless stale. */
  private async retake(workspaceId: Id) {
    const mine = [...this.later].filter(([, l]) => l.record.workspaceId === workspaceId);
    if (!mine.length) return;
    const waiting = await this.waiting(workspaceId);
    const batch: RemoteBatch = { workspaceId, pages: [], rows: [], databases: [] };
    const databases = new Map(
      (await this.store.readMirror(workspaceId)).databases.map((d) => [d.id, d]),
    );
    for (const [key, later] of mine) {
      if (waiting.has(later.record.id)) continue;
      this.later.delete(key);
      if (later.type === 'database') {
        const local = databases.get(later.record.id);
        if (local && local.version <= later.record.version) batch.databases!.push(later.record);
        continue;
      }
      const local = await this.store.getPage(later.record.id);
      if (!local || local.version > later.record.version) continue;
      if (later.type === 'row') batch.rows!.push(later.record);
      else batch.pages!.push(later.record);
    }
    if (!batch.pages!.length && !batch.rows!.length && !batch.databases!.length) return;
    await this.applyBatch(batch);
    this.emit({ kind: 'mirror', workspaceId });
  }

  // Quarantine --------------------------------------------------------------------------------------

  /** Sets a page's unsent edits aside (to become a recovered page) and tells the user why. */
  private async setAside(workspaceId: Id, pageId: Id, reason: string) {
    const entry = await this.store.setAsideDoc(pageId, reason);
    if (entry) this.seen?.add(entry.id);
    this.quarantineDirty = true;
    this.notice(reason, workspaceId, pageId);
  }

  /**
   * After a pass that may have set something aside: entries the store set aside on the server's
   * word (a remote delete, a lost subtree) are told of as `page.removed`, and while any entry is
   * pending the shell is asked to make recovered pages (`recover`), pass after pass.
   */
  private async lookAtQuarantine() {
    if (!this.quarantineDirty || !this.seen) return;
    const pending = new Set<Id>();
    for (const entry of await this.store.quarantine(null)) {
      if (entry.status !== 'pending') continue;
      pending.add(entry.workspaceId);
      if (this.seen.has(entry.id)) continue;
      this.seen.add(entry.id);
      if (entry.reason === 'page.removed')
        this.notice('page.removed', entry.workspaceId, entry.pageId);
    }
    for (const workspaceId of pending) this.emit({ kind: 'recover', workspaceId });
    this.quarantineDirty = pending.size > 0;
  }

  // 1. Operations ----------------------------------------------------------------------------------

  private async pushOutbox(workspace: WorkspaceRecord, account: Account) {
    for (;;) {
      const ops = await this.store.nextOutboxBatch(100, workspace.id);
      if (!ops.length) return;
      const answers: OpResult[] = [];
      const rest = [];
      for (const op of ops) {
        if (op.type === 'workspace.create') {
          const created = await this.api.createWorkspace({
            id: op.payload.id,
            name: op.payload.name,
            icon: op.payload.icon,
          });
          answers.push({
            opId: op.opId,
            status: 'applied',
            entityType: 'workspace',
            entity: { ...created, accountId: account.id },
          });
        } else rest.push(op);
      }
      if (rest.length)
        answers.push(...(await this.api.pushOps(workspace.id, account.deviceId, rest)));
      // A create the server holds already was sent twice: it is taken as made, unsaid, and what
      // was refused only for following it stays in the outbox for the next push.
      const { held, again } = sentTwice(ops, answers);
      const results = again.size ? answers.filter((r) => !again.has(r.opId)) : answers;
      // A refusal can remove a page here (the server has none): its unsent edits are set aside.
      if (results.some((r) => r.status === 'rejected' || r.entity === null))
        this.quarantineDirty = true;
      const rows = new Set<Id>();
      for (const result of results) {
        // An answer is newer than anything kept for later.
        if (result.entity && result.entityType && isLaterType(result.entityType))
          this.later.delete(`${result.entityType}:${(result.entity as { id: Id }).id}`);
        if (result.entityType === 'row' && result.entity)
          rows.add((result.entity as RowRecord).databaseId);
      }
      const reach = await this.reachOfRefused(workspace.id, ops, results);
      await this.store.settleOps(results);
      await this.takeBackReach(workspace.id, reach);
      for (const databaseId of rows)
        this.emit({ kind: 'rows', workspaceId: workspace.id, databaseId });
      // A refused tree operation changed a whole subtree locally: take the server's subtree back.
      // (A row has no subtree: its answer is all there is of it.)
      const subtrees = new Set<Id>();
      for (const result of results) {
        const op = ops.find((o) => o.opId === result.opId);
        if (!op || !SUBTREE_OPS.has(op.type) || result.entityType === 'row') continue;
        this.reconcile.add(workspace.id);
        if (result.status === 'rejected' && result.entity && !held.has(op.opId))
          subtrees.add(op.entityId);
      }
      for (const root of subtrees) await this.resync(workspace.id, root, account);
      for (const result of results) {
        if (result.notice) this.notice(result.notice, workspace.id, entityPage(result.entity));
        if (result.status === 'rejected' && result.error && !held.has(result.opId))
          this.notice(
            result.error.code,
            workspace.id,
            entityPage(result.entity),
            refusedOp(ops.find((o) => o.opId === result.opId)),
          );
      }
      this.emit({ kind: 'mirror', workspaceId: workspace.id });
      // What was sent again goes at once: the create it followed has left the outbox.
      if (ops.length < 100 && !again.size) return;
    }
  }

  /**
   * What refused operations changed here beyond their own entity, which the server's answer does
   * not bring back: a row's values (or a row made with values) kept relations two-way on other
   * held rows, of its database and of those its relations point into; a database's change
   * converted its held rows (a type change) and added reverse properties to other databases.
   * Read before the answers are taken (the local records still say which databases).
   */
  private async reachOfRefused(
    workspaceId: Id,
    ops: { opId: Id; type: OperationType; entityId: Id; payload: unknown }[],
    results: OpResult[],
  ): Promise<{ rows: Set<Id>; records: Set<Id> }> {
    const reach = { rows: new Set<Id>(), records: new Set<Id>() };
    const refused = results.filter((r) => r.status === 'rejected');
    if (!refused.length) return reach;
    const databases = new Map(
      (await this.store.readMirror(workspaceId)).databases.map((d) => [d.id, d]),
    );
    const targets = (databaseId: Id) =>
      (databases.get(databaseId)?.properties ?? []).flatMap((p) =>
        p.type === 'relation' && p.relation ? [p.relation.databaseId] : [],
      );
    for (const result of refused) {
      const op = ops.find((o) => o.opId === result.opId);
      if (!op) continue;
      let databaseId: Id | null = null;
      if (op.type === 'row.update') {
        const row = await this.store.getPage(op.entityId);
        databaseId = row?.kind === 'row' ? (row as RowRecord).databaseId : null;
      } else if (op.type === 'page.create') {
        const page = op.payload as { kind?: string; parentPageId?: Id | null };
        if (page.kind === 'row') databaseId = page.parentPageId ?? null;
        else if (page.kind === 'database')
          for (const target of targets(op.entityId))
            if (target !== op.entityId) reach.records.add(target);
      } else if (op.type === 'db.update') {
        reach.rows.add(op.entityId);
        const given = (op.payload as { properties?: { relation?: { databaseId: Id } }[] })
          .properties;
        for (const def of given ?? [])
          if (def.relation && def.relation.databaseId !== op.entityId)
            reach.records.add(def.relation.databaseId);
      }
      if (!databaseId) continue;
      reach.rows.add(databaseId);
      for (const target of targets(databaseId)) reach.rows.add(target);
    }
    return reach;
  }

  /**
   * Takes back what refused operations reached (`reachOfRefused`): the rows of full holds come
   * again (the fetch after the feed, this pass), and other databases' records from their trees.
   */
  private async takeBackReach(workspaceId: Id, reach: { rows: Set<Id>; records: Set<Id> }) {
    for (const databaseId of reach.rows) {
      const hold = await this.store.dbHold(databaseId);
      if (!hold || hold.mode !== 'full') continue;
      await this.store.holdDatabase({ ...hold, complete: false, after: null });
    }
    for (const databaseId of reach.records) {
      if (!(await this.store.getPage(databaseId))) continue;
      let tree;
      try {
        tree = await this.api.tree(workspaceId, databaseId);
      } catch (error) {
        if (error instanceof SyncHttpError && (error.status === 404 || error.status === 410))
          continue;
        throw error;
      }
      const databases = tree.databases.filter((d) => d.id === databaseId);
      if (databases.length) await this.applyBatch({ workspaceId, databases });
    }
  }

  // 2. Document updates ----------------------------------------------------------------------------

  private async pushDocs(workspace: WorkspaceRecord) {
    // Updates of pages that cannot go now (another workspace's, held back, not created on the
    // server yet) are read again each round: the read is widened by as many, so they never crowd
    // out the rest.
    let skipped = 0;
    for (let round = 0; round < PUSH_ROUNDS; round++) {
      // A page whose creation has not reached the server yet waits for it: its push would be 404.
      // (Made between this pass's push of the outbox and now; the next pass sends both.)
      const creating = await this.creating(workspace.id);
      const limit = skipped + PUSH_READ;
      const unsent = await this.store.unsentDocUpdates(limit);
      let read = 0;
      skipped = 0;
      for (const doc of unsent) {
        read += doc.updates.length;
        const page =
          this.heldBack.has(doc.pageId) || creating.has(doc.pageId)
            ? null
            : await this.store.getPage(doc.pageId);
        if (!page || page.workspaceId !== workspace.id) {
          skipped += doc.updates.length;
          continue;
        }
        await this.pushPage(workspace.id, page, doc.updates);
      }
      if (read < limit) return;
    }
    // More waits than one pass sends: the next pass comes soon and goes on from here.
    this.backlog = true;
  }

  /** A page's unsent updates, batch by batch; each batch's answer is kept before the next goes. */
  private pushPage(workspaceId: Id, page: PageRecord, all: StoredUpdate[]): Promise<boolean> {
    return this.onPage(page.id, () => this.pushPageNow(workspaceId, page, all, false));
  }

  /**
   * Pushes a page's updates, over HTTP or (`live`) through the hub. True when nothing more of
   * them is to be sent now; false, through the hub only, when some are left for a pass over HTTP
   * (more than one push's worth, an update over the hub's 1 MB, the connection gone, a refusal
   * that is not the page's own, such as 429 or 500).
   */
  private async pushPageNow(
    workspaceId: Id,
    page: PageRecord,
    all: StoredUpdate[],
    live: boolean,
  ): Promise<boolean> {
    // Sent through the hub after this pass read them: nothing to send again.
    all = all.filter((u) => !this.sentLive.has(u.updateId));
    if (!all.length) return true;
    const ids = [...new Set(all.flatMap((u) => this.codec.clientIds(u.data)))];
    const refused = await this.register(workspaceId, ids);
    let updates = all;
    if (refused.size) {
      // Written as an id another person holds here: the server would refuse it. Kept aside.
      const bad = updates.filter((u) => this.codec.clientIds(u.data).some((id) => refused.has(id)));
      await this.store.quarantineUpdates(
        page.id,
        bad.map((u) => u.localSeq),
        'yjs.clientTaken',
      );
      this.notice('doc.clientTaken', workspaceId, page.id);
      updates = updates.filter((u) => !bad.includes(u));
    }
    if (!updates.length) return true;
    let cursor = await this.store.docCursor(page.id);
    const epoch = cursor?.epoch ?? page.docEpoch ?? 0;
    const queue = pushBatches(updates, live ? LIVE_LIMITS : PUSH_LIMITS);
    while (queue.length) {
      const batch = queue.shift()!;
      const request = {
        epoch,
        clientSchemaVersion: this.codec.schemaVersion,
        updates: batch.map((u) => ({ updateId: u.updateId, data: u.data })),
      };
      try {
        let answer;
        if (live) {
          // The hub takes at most 1 MB a push: a larger update goes over HTTP, in a pass.
          if (batch.reduce((n, u) => n + u.data.byteLength, 0) > LIVE_LIMITS.bytes) return false;
          if (!this.realtime) return false;
          answer = await this.realtime.pushDoc(page.id, request);
        } else answer = await this.api.pushDoc(page.id, request);
        await this.store.ackDocUpdates(page.id, answer.acks);
        if (live) for (const u of batch) this.sentLive.add(u.updateId);
        this.edited.add(page.id);
        // The page is now held here: later heads are pulled for it.
        if (!cursor) {
          await this.store.applyRemoteDocUpdates(page.id, { epoch, headSeq: 0, updates: [] });
          cursor = { epoch, headSeq: 0 };
        }
        // A backlog goes over HTTP, in a pass.
        if (live && queue.length) return false;
      } catch (error) {
        if (live && !(error instanceof SyncHttpError && LIVE_REFUSALS.has(error.code))) {
          // Not the page's own refusal (the connection went, the hub is busy or failed, a size it
          // will not take): a pass sends it over HTTP, which says what the server makes of it.
          if (error instanceof SyncHttpError && error.retryAfterMs)
            this.liveNotBefore = this.now() + error.retryAfterMs;
          if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
            console.warn('A push through the hub failed:', error);
          return false;
        }
        if (!(error instanceof SyncHttpError)) throw error;
        if (error.code === 'limit.size' && batch.length > 1) {
          // Over the request's limit after all: one at a time, so only a too-large one is refused.
          queue.unshift(...batch.map((u) => [u]));
          continue;
        }
        if (await this.refusedPush(workspaceId, page, error, batch)) return true;
      }
    }
    return true;
  }

  /**
   * What a refused push means (SYNC_DESIGN.md, Across the two models; Epoch change). True when
   * the page's other batches are not to be sent.
   */
  private async refusedPush(
    workspaceId: Id,
    page: PageRecord,
    error: SyncHttpError,
    batch: StoredUpdate[],
  ): Promise<boolean> {
    switch (error.code) {
      case 'doc.epochMismatch':
        // The server replaced the document's history: unsent edits are set aside (a recovered
        // page), and the page is pulled again from the start of the new epoch.
        await this.setAside(workspaceId, page.id, 'doc.epochMismatch');
        await this.resetDoc(page);
        return true;
      case 'access.denied':
        // Edit access went while offline: the edits become a recovered page, and the page is
        // what the server holds.
        await this.setAside(workspaceId, page.id, 'access.denied');
        await this.resetDoc(page);
        return true;
      case 'not.found':
        // Read access went too: the edits are set aside; the feed's revoke removes the page.
        await this.setAside(workspaceId, page.id, 'access.denied');
        return true;
      case 'page.gone':
        // Deleted for good on the server: the edits become a recovered page.
        await this.setAside(workspaceId, page.id, 'page.gone');
        return true;
      case 'limit.size':
        await this.store.quarantineUpdates(
          page.id,
          batch.map((u) => u.localSeq),
          error.code,
        );
        this.notice(error.code, workspaceId, page.id);
        return false;
      case 'client.tooOld':
        // The page needs a newer app: its edits stay here, unsent, and the page is read-only.
        this.heldBack.add(page.id);
        this.notice(error.code, workspaceId, page.id);
        return true;
      default:
        throw error;
    }
  }

  /**
   * The page's log emptied (the empty update stands as sent) so it is pulled from the start. Only
   * what was read here gives way: an update written meanwhile stays, to be sent. Refused updates
   * still waiting for a repair cannot have one at the new epoch: they are kept aside first.
   */
  private async resetDoc(page: PageRecord) {
    const pageId = page.id;
    const waiting = (await this.refusalsOf(page.workspaceId))[pageId];
    if (waiting) await this.abandonRefusal(page, waiting.updates);
    const doc = await this.store.loadDoc(pageId);
    const upTo = doc.updates.reduce((n, u) => Math.max(n, u.localSeq), doc.snapshotCovers);
    const updateId = uuidv7();
    await this.store.replaceDoc(pageId, { updateId, data: EMPTY_UPDATE }, upTo);
    await this.store.ackDocUpdates(pageId, [{ updateId, seq: 0 }]);
    this.wanted.add(pageId);
    this.emit({ kind: 'docReset', pageId });
  }

  /** Registers the ids this device wrote with, once each; returns those another user holds. */
  private async register(workspaceId: Id, ids: number[]): Promise<Set<number>> {
    const known = new Set((await this.store.getPref<number[]>(registeredKey(workspaceId))) ?? []);
    const missing = ids.filter((id) => !known.has(id));
    if (!missing.length) return new Set();
    const answer = await this.api.yjsClients(workspaceId, { register: missing });
    for (const id of answer.registered) known.add(id);
    await this.store.setPref(registeredKey(workspaceId), [...known]);
    return new Set(answer.refused);
  }

  /**
   * The Yjs client id this session writes a workspace's documents as: one the server issued to
   * this device (unique in the workspace), or a random one registered when it is pushed.
   */
  async clientIdFor(workspaceId: Id): Promise<number | undefined> {
    // Asked for every document written (an import writes a thousand): once chosen, the session's
    // id is the answer without reading the workspace's records again (a workspace that syncs
    // never goes back to local-only; every workspace made local has a new id).
    const existing = this.sessionIds.get(workspaceId);
    if (existing !== undefined) return existing;
    const workspace = (await this.store.readMirror(workspaceId)).workspaces[0];
    if (!workspace || workspace.localOnly) return undefined;
    const pool = (await this.store.getPref<number[]>(poolKey(workspaceId))) ?? [];
    let id: number | undefined;
    if (pool.length) {
      // A random one, so two tabs starting together rarely take the same.
      id = pool.splice(Math.floor((this.options.random ?? Math.random)() * pool.length), 1)[0];
      await this.store.setPref(poolKey(workspaceId), pool);
    } else id = 1 + Math.floor((this.options.random ?? Math.random)() * 0xfffffffe);
    this.sessionIds.set(workspaceId, id);
    if (pool.length < POOL_LOW && this.account)
      void this.refillPool(workspaceId).catch(() => undefined);
    return id;
  }

  private async refillPool(workspaceId: Id) {
    const answer = await this.api.yjsClients(workspaceId, { issue: POOL_FILL });
    const pool = (await this.store.getPref<number[]>(poolKey(workspaceId))) ?? [];
    await this.store.setPref(poolKey(workspaceId), [...pool, ...answer.issued]);
    const known = new Set((await this.store.getPref<number[]>(registeredKey(workspaceId))) ?? []);
    for (const id of answer.issued) known.add(id);
    await this.store.setPref(registeredKey(workspaceId), [...known]);
  }

  // 3. The change feed -----------------------------------------------------------------------------

  private async pullChanges(workspace: WorkspaceRecord, account: Account) {
    let cursor = await this.store.syncCursor(workspace.id);
    if (cursor === null) {
      await this.firstSync(workspace.id, account);
      return;
    }
    await this.retake(workspace.id);
    let resynced = false;
    for (;;) {
      let page;
      try {
        page = await this.api.changes(workspace.id, cursor, 500);
      } catch (error) {
        if (
          !resynced &&
          error instanceof SyncHttpError &&
          error.status === 410 &&
          error.code === 'feed.expired'
        ) {
          // This device was away longer than the feed keeps changes: the whole tree, with its
          // cursor, replaces the mirror; the outbox stays, and is sent as ever.
          cursor = await this.fullResync(workspace.id, account);
          resynced = true;
          continue;
        }
        throw error;
      }
      const roots = new Set<Id>();
      const batch = batchOf(workspace.id, page.changes, account, roots, (event) =>
        this.emit(event),
      );
      batch.cursor = page.cursor;
      await this.beforeRemote(workspace.id, batch.pages ?? [], batch.rows ?? []);
      if (batch.deletePages?.length || batch.deleteRows?.length || batch.deleteWorkspace)
        this.quarantineDirty = true;
      await this.applyBatch(batch);
      if (page.changes.length) this.emit({ kind: 'mirror', workspaceId: workspace.id });
      for (const root of roots) {
        await this.resync(workspace.id, root === workspace.id ? null : root, account);
        // What the account may see of the databases under it changed: their rows come again.
        await this.refetchHolds(workspace.id, root);
      }
      cursor = page.cursor;
      if (!page.more) return;
    }
  }

  /** Holds of databases at or under `root` (the workspace's id: every one) are fetched again. */
  private async refetchHolds(workspaceId: Id, root: Id) {
    const holds = await this.store.dbHolds(workspaceId);
    if (!holds.length) return;
    const pages = new Map((await this.store.readMirror(workspaceId)).pages.map((p) => [p.id, p]));
    const under = (id: Id) => {
      if (root === workspaceId) return true;
      const seen = new Set<Id>();
      for (let p = pages.get(id); p && !seen.has(p.id); p = pages.get(p.parentPageId ?? '')) {
        if (p.id === root) return true;
        seen.add(p.id);
      }
      return false;
    };
    for (const hold of holds) {
      if (!under(hold.databaseId) || (hold.mode === 'full' && !hold.complete && !hold.after))
        continue;
      await this.store.holdDatabase({ ...hold, complete: false, after: null });
      this.emit({ kind: 'rows', workspaceId, databaseId: hold.databaseId });
    }
  }

  /**
   * Before the server's records of pages are taken: pages whose head moved are pulled, and a page
   * this session edited that the server has in the trash is told of (its edits are there on
   * restore).
   */
  private async beforeRemote(workspaceId: Id, pages: PageRecord[], rows: RowRecord[] = []) {
    if (!pages.length && !rows.length) return;
    const heads = await this.store.docCursors(workspaceId);
    for (const p of [...pages, ...rows]) {
      // Its record came anew (a grant, a move, its head): a pull refused before is asked again.
      this.pullRefused.delete(p.id);
      const held = heads[p.id];
      if (held && ((p.docHeadSeq ?? 0) > held.headSeq || (p.docEpoch ?? 0) !== held.epoch))
        this.wanted.add(p.id);
      if (!this.edited.delete(p.id) || !p.trashedAt) continue;
      const local = await this.store.getPage(p.id);
      if (local && !local.trashedAt) this.notice('page.trashed', workspaceId, p.id);
    }
  }

  /** The feed has been pruned past this device's cursor: the whole tree, cursor included. */
  private async fullResync(workspaceId: Id, account: Account): Promise<number> {
    const tree = await this.api.tree(workspaceId, null);
    await this.beforeRemote(workspaceId, tree.pages);
    this.quarantineDirty = true;
    await this.applyBatch({
      ...treeBatch(workspaceId, tree, account, null),
      cursor: tree.cursor,
    });
    // Changes to rows the feed no longer holds: every held database's rows come again (a full
    // fetch also removes held rows the server no longer has).
    await this.refetchHolds(workspaceId, workspaceId);
    this.emit({ kind: 'mirror', workspaceId });
    return tree.cursor;
  }

  /**
   * The scoped resync: what the server holds of a subtree (or the whole tree) replaces it here.
   * When a page under the root here is not under it there (moved away, or gone), only the whole
   * tree says which: a scoped replace would remove a page that was only moved (and set its unsent
   * edits aside), so the whole tree replaces the mirror instead.
   */
  private async resync(workspaceId: Id, root: Id | null, account: Account) {
    let tree = await this.api.tree(workspaceId, root);
    if (root !== null && (await this.leftOut(workspaceId, root, tree.pages))) {
      root = null;
      tree = await this.api.tree(workspaceId, null);
    }
    await this.beforeRemote(workspaceId, tree.pages);
    this.quarantineDirty = true;
    await this.applyBatch(treeBatch(workspaceId, tree, account, root));
    this.emit({ kind: 'mirror', workspaceId });
  }

  /**
   * After a subtree operation was answered (and the feed read): the local planner changed the
   * pages under the root as it saw them, and the server those under it as it saw them. A page
   * changed here that the server did not change gets no feed change, so a tree the server cannot
   * hold (a page in the trash under a root that is not, or not above it; a page under a trashed
   * parent that is not trashed; a page in another section than its parent) means the whole tree
   * is taken again.
   */
  private async reconcileTree(workspaceId: Id, account: Account) {
    if (!this.reconcile.has(workspaceId)) return;
    const pages = (await this.store.readMirror(workspaceId)).pages;
    const pending = new Set(
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId)).map((op) => op.entityId),
    );
    if (impossibleTree(pages, pending)) await this.resync(workspaceId, null, account);
    this.reconcile.delete(workspaceId);
  }

  /** Whether a page under `root` here (not made here and still unsent) is missing from `pages`. */
  private async leftOut(workspaceId: Id, root: Id, pages: PageRecord[]): Promise<boolean> {
    const sent = new Set(pages.map((p) => p.id));
    const local = (await this.store.readMirror(workspaceId)).pages;
    const here = new Set(local.map((p) => p.id));
    const creating = await this.creating(workspaceId);
    const children = new Map<Id, Id[]>();
    for (const page of local)
      if (page.parentPageId) {
        const list = children.get(page.parentPageId) ?? [];
        list.push(page.id);
        children.set(page.parentPageId, list);
      }
    const queue = [root];
    const seen = new Set<Id>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!sent.has(id) && !creating.has(id) && here.has(id)) return true;
      queue.push(...(children.get(id) ?? []));
    }
    return false;
  }

  // 4. Documents -----------------------------------------------------------------------------------

  /**
   * Pulls one page now (it is being opened); resolves when this device holds what the server has.
   * The first opening in a session also checks the page's state hash (in a pass, soon).
   */
  async pullPage(pageId: Id): Promise<void> {
    const page = await this.store.getPage(pageId);
    if (!page || !this.account) return;
    // Before the first pass knows the workspace syncs, or while the page's creation is still on
    // its way: the server has nothing to give yet (and a 404 would be logged). A pass pulls it.
    if (!this.mine.has(page.workspaceId) || (await this.creating(page.workspaceId)).has(pageId)) {
      this.wanted.add(pageId);
      this.kick();
      return;
    }
    await this.pullDoc(page);
    if (this.heldChanged.delete(page.workspaceId))
      this.emit({ kind: 'offline', workspaceId: page.workspaceId });
    if (!this.opened.has(pageId)) {
      this.opened.add(pageId);
      this.checks.set(pageId, 0);
      this.kick();
    }
  }

  /**
   * The document layer found updates still pending after its retry (SYNC_DESIGN.md, Pending
   * updates): the page's state hash is compared with the server's soon, and repaired if they differ.
   */
  suspect(pageId: Id) {
    this.checks.set(pageId, 0);
    this.repairReported.delete(pageId);
    this.kick();
  }

  /** Pages made here whose `page.create` still waits in the outbox: not on the server yet. */
  private async creating(workspaceId: Id): Promise<Set<Id>> {
    return new Set(
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId))
        .filter((op) => op.type === 'page.create')
        .map((op) => op.entityId),
    );
  }

  /**
   * Held pages whose head moved, and pages asked for: one alone by its own route, more by the
   * batch route (Phase 12), at most `MOVED_REQUESTS` requests a pass (the next pass soon while
   * some remain).
   */
  private async pullDocs(workspace: WorkspaceRecord, pages: PageRecord[], pinned: Set<Id>) {
    const heads = await this.store.docCursors(workspace.id);
    const creating = await this.creating(workspace.id);
    // Rows are not in the mirror's pages: a held row whose head moved (the feed, a fetch or a
    // query said so) or that was asked for is in `wanted`, and read on its own.
    const known = new Set(pages.map((p) => p.id));
    const rows: PageRecord[] = [];
    for (const id of this.wanted) {
      if (known.has(id)) continue;
      const row = await this.store.getPage(id);
      if (!row) this.wanted.delete(id);
      else if (row.kind === 'row' && row.workspaceId === workspace.id) rows.push(row);
    }
    const due: { page: PageRecord; after: number }[] = [];
    const moved = new Set<Id>();
    for (const page of [...pages, ...rows]) {
      if (creating.has(page.id)) continue;
      const held = heads[page.id];
      if (held && ((page.docHeadSeq ?? 0) > held.headSeq || (page.docEpoch ?? 0) !== held.epoch))
        moved.add(page.id);
      if (!this.wanted.has(page.id) && (!moved.has(page.id) || this.pullRefused.has(page.id)))
        continue;
      due.push({ page, after: held?.headSeq ?? 0 });
    }
    if (!due.length) return;
    const { added, left } = await this.pullMany(workspace.id, due, MOVED_REQUESTS, Infinity);
    if (left) this.backlog = true;
    // A pinned page refreshed with others' edits: its state is checked against the server's.
    for (const [id, count] of added)
      if (count && moved.has(id) && pinned.has(id) && !this.checks.has(id)) this.checks.set(id, 0);
  }

  /**
   * Pulls pages (`after`: the cursor each is asked from). One alone, or all with no batch route,
   * by the page's own route (`singles` of them, four at a time); more by the batch route (Phase
   * 12): `DOCS_PULL_PAGES` a request, at most `requests` requests, a page the answer deferred
   * asked again first. Each answered page is taken in its own turn, four at a time. Returns how
   * many updates each page lacked, and how many pages are left for a later pass.
   */
  private async pullMany(
    workspaceId: Id,
    asked: { page: PageRecord; after: number }[],
    requests: number,
    singles: number,
  ): Promise<{ added: Map<Id, number>; left: number }> {
    const size = Math.max(1, Math.min(DOCS_PULL_PAGES, this.options.pinBatch ?? DOCS_PULL_PAGES));
    const added = new Map<Id, number>();
    let queue = asked;
    let made = 0;
    const alone = asked.length === 1;
    while (queue.length) {
      if (!this.batchPull || alone) {
        const now = queue.slice(0, singles);
        queue = queue.slice(now.length);
        await this.inTurns(now, async ({ page }) => {
          added.set(page.id, await this.pullDoc(page));
        });
        break;
      }
      if (made++ >= requests) break;
      const batch = queue.slice(0, size);
      const items = await this.askBatch(workspaceId, batch);
      // No batch route after all: the same pages, one by one.
      if (!items) continue;
      queue = queue.slice(batch.length);
      const byId = new Map(items.map((item) => [item.pageId, item]));
      const again = new Set<Id>();
      await this.inTurns(batch, async ({ page, after }) => {
        const item = byId.get(page.id);
        const pull = item?.pull;
        if (!item || (!pull && item.status === 0)) again.add(page.id);
        else if (!pull) this.refusedPull(page, item.status);
        else
          added.set(page.id, await this.onPage(page.id, () => this.takeBatched(page, after, pull)));
      });
      queue = [...batch.filter(({ page }) => again.has(page.id)), ...queue];
    }
    return { added, left: queue.length };
  }

  /**
   * One request of the batch route, or null when the server will not take it: an older server has
   * no such route (its 404 must not read as the workspace gone, which would remove it here), and
   * one that refuses the request would refuse it every pass. Pages then go one by one this session.
   */
  private async askBatch(
    workspaceId: Id,
    batch: { page: PageRecord; after: number }[],
  ): Promise<DocsPullItem[] | null> {
    try {
      return await this.api.pullDocs(
        workspaceId,
        batch.map(({ page, after }) => ({ pageId: page.id, after })),
      );
    } catch (error) {
      if (!(error instanceof SyncHttpError) || ![400, 404, 405].includes(error.status)) throw error;
      console.warn('The batch pull was refused; pulling pages one by one:', error.code);
      this.batchPull = false;
      return null;
    }
  }

  /**
   * A batch's answer for one page, in the page's own turn, as `pullDocNow` takes its first answer.
   * A page whose cursor moved since it was asked (a frame, an opening), or of another epoch, is
   * pulled by its own route instead, which knows what to do with either.
   */
  private async takeBatched(page: PageRecord, after: number, pull: DocPull): Promise<number> {
    const cursor = await this.store.docCursor(page.id);
    if ((cursor?.headSeq ?? 0) !== after || (cursor && cursor.epoch !== pull.epoch))
      return this.pullDocNow(page);
    this.wanted.delete(page.id);
    let added = await this.takePull(page, pull, !cursor, after, after);
    if (pull.more) added += await this.pullDocNow(page);
    return added;
  }

  /**
   * A page the batch route refused: nothing to take, as the page's own route's 404 and 410 give
   * nothing; one not found, gone or not readable is not asked for again until its record comes
   * anew (`beforeRemote`). Any other refusal is asked again in a later pass.
   */
  private refusedPull(page: PageRecord, status: number) {
    this.wanted.delete(page.id);
    if (status === 403 || status === 404 || status === 410) this.pullRefused.add(page.id);
  }

  /** `fn` over `items`, four at a time; the first failure stops what has not started, then is thrown. */
  private async inTurns<T>(items: T[], fn: (item: T) => Promise<void>) {
    let failure: unknown = null;
    let next = 0;
    const worker = async () => {
      while (next < items.length && failure === null) {
        try {
          await fn(items[next++]);
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PIN_PARALLEL, items.length) }, worker));
    if (failure !== null) throw failure;
  }

  /** Pulls a page until it holds the server's head; returns how many updates it lacked. */
  private pullDoc(page: PageRecord): Promise<number> {
    return this.onPage(page.id, () => this.pullDocNow(page));
  }

  /** `pullDoc` inside the page's chain. */
  private async pullDocNow(page: PageRecord): Promise<number> {
    this.wanted.delete(page.id);
    let cursor = await this.store.docCursor(page.id);
    let added = 0;
    for (;;) {
      let pull: DocPull;
      try {
        pull = await this.api.pullDoc(page.id, cursor?.headSeq ?? 0);
      } catch (error) {
        if (error instanceof SyncHttpError && (error.status === 404 || error.status === 410))
          return added;
        throw error;
      }
      if (cursor && pull.epoch !== cursor.epoch) {
        // A hard restore on the server: start again from the new epoch, edits set aside.
        await this.setAside(page.workspaceId, page.id, 'doc.epochMismatch');
        await this.resetDoc(page);
        this.wanted.delete(page.id);
        cursor = null;
        continue;
      }
      const after = cursor?.headSeq ?? 0;
      added += await this.takePull(page, pull, !cursor, after, after);
      cursor = { headSeq: pull.cursor, epoch: pull.epoch };
      if (!pull.more) return added;
    }
  }

  /**
   * A pull's answer into the store: what was refused, then the updates this device lacks and its
   * cursor. `after` is where the answer starts (0 for a repair's), `held` this device's cursor
   * before it. Returns how many updates were new here.
   */
  private async takePull(
    page: PageRecord,
    pull: DocPull,
    first: boolean,
    after: number,
    held: number,
  ): Promise<number> {
    await this.noteRefusals(page, { after, upTo: pull.headSeq, rejected: pull.rejected }, held);
    const updates = [];
    if (pull.snapshot)
      updates.push({
        seq: pull.snapshot.upToSeq,
        data: await this.api.fetchBytes(pull.snapshot.url),
      });
    updates.push(...pull.updates);
    const added = await this.store.applyRemoteDocUpdates(page.id, {
      epoch: pull.epoch,
      headSeq: pull.cursor,
      updates,
    });
    if (first) this.heldChanged.add(page.workspaceId);
    if (added.length)
      this.emit({ kind: 'doc', pageId: page.id, updates: added.map((u) => u.data) });
    return added.length;
  }

  // 4a. Refused updates ----------------------------------------------------------------------------

  /** The workspace's refused updates waiting for a repair, read from the store once. */
  private async refusalsOf(workspaceId: Id): Promise<Refusals> {
    const known = this.refusals.get(workspaceId);
    if (known) return known;
    const read = (await this.store.getPref<Refusals>(refusedKey(workspaceId))) ?? {};
    // Another read may have finished first: it is the one kept.
    const kept = this.refusals.get(workspaceId) ?? read;
    this.refusals.set(workspaceId, kept);
    return kept;
  }

  /**
   * A page's waiting refusal replaced (or, null, removed). Read from the store again first: every
   * tab has its own engine over the one store, and keeps the others' pages.
   */
  private async setRefusal(workspaceId: Id, pageId: Id, refusal: Refusal | null) {
    const all = (await this.store.getPref<Refusals>(refusedKey(workspaceId))) ?? {};
    if (refusal) all[pageId] = refusal;
    else delete all[pageId];
    await this.store.setPref(refusedKey(workspaceId), all);
    this.refusals.set(workspaceId, all);
  }

  /**
   * What a pull's answer or a hub frame says of this device's own updates, read before its updates
   * are stored and the cursor moves past them (so a stop then reads the answer again). Own updates
   * the worker refused are not set aside: they wait for a repair (`repairRefused`) that sends the
   * page's whole state, which carries whatever they referred to and the server lacked (Phase 6's
   * compaction bug: a snapshot held a key no update carried, and everything typed after it was
   * refused). A repair sent for them is decided once the answer's validated head passes it: valid,
   * its refused updates are on the server; refused too, the server will not take what this device
   * holds, and they are kept aside as a refusal always was (`abandonRefusal`).
   *
   * `after` is where the answer starts and `upTo` its validated head (every update up to it is
   * decided); `held` is this device's cursor before it: a refused update at or below it was told of
   * before (a repair's pull lists the page's refusals again from the start).
   */
  private async noteRefusals(
    page: PageRecord,
    answer: { after: number; upTo: number; rejected: Id[] },
    held: number,
  ) {
    const waiting = (await this.refusalsOf(page.workspaceId))[page.id] ?? null;
    if (!waiting && !answer.rejected.length) return;
    const rejected = new Set(answer.rejected);
    let fresh: Id[] = [];
    if (rejected.size) {
      const known = new Set(waiting?.updates ?? []);
      fresh = (await this.store.loadDoc(page.id)).updates
        .filter(
          (u) =>
            rejected.has(u.updateId) && !known.has(u.updateId) && (u.seq === null || u.seq > held),
        )
        .map((u) => u.updateId);
    }
    const repair = waiting?.repair ?? null;
    const decided =
      repair !== null &&
      repair.seq !== null &&
      repair.seq > answer.after &&
      repair.seq <= answer.upTo;
    if (waiting && repair && decided && rejected.has(repair.updateId)) {
      await this.abandonRefusal(page, [...waiting.updates, ...fresh]);
      return;
    }
    if (!fresh.length && !decided) return;
    const carried = new Set(decided && repair ? repair.covers : []);
    const updates = [...(waiting?.updates ?? []).filter((id) => !carried.has(id)), ...fresh];
    const next = { updates, repair: decided ? null : repair };
    await this.setRefusal(page.workspaceId, page.id, updates.length || next.repair ? next : null);
    if (fresh.length) {
      // Not on the server after all: the status says so, and a pass sends the repair.
      this.waitingOne();
      this.soon(SOON);
    } else if (!updates.length) await this.recountSoon();
  }

  /**
   * Sends a repair for every page of the workspace whose refused updates wait for one, each in the
   * page's own turn. A repair answered waits for the worker's word (`noteRefusals`) while the
   * device's cursor is below it; past it with no word (another tab took that answer), it is asked
   * again, and the server's answer for the same id says.
   */
  private async repairRefused(workspace: WorkspaceRecord) {
    for (const pageId of Object.keys(await this.refusalsOf(workspace.id))) {
      const page = await this.store.getPage(pageId);
      if (page) await this.onPage(pageId, () => this.sendRepair(page));
      // Removed here meanwhile: its log went with it.
      else await this.setRefusal(workspace.id, pageId, null);
    }
  }

  /**
   * The repair for a page's refused updates: this device's whole state as one update by the repair
   * route, as a state-hash repair sends it (the worker takes from it only what it adds, so other
   * people's structs in it are no forgery), and the page from the start. Sent again under the same
   * id while no answer came (the server keeps the first and answers with its sequence). What no
   * repair can carry (a reader's, over the 1 MB an update may be, a page gone or no longer
   * editable) is kept aside as before.
   */
  private async sendRepair(page: PageRecord) {
    const waiting = (await this.refusalsOf(page.workspaceId))[page.id];
    if (!waiting) return;
    const cursor = await this.store.docCursor(page.id);
    const sent = waiting.repair?.seq ?? null;
    if (sent !== null && cursor && cursor.headSeq < sent) return;
    const parts = partsOf(await this.store.loadDoc(page.id));
    const reader =
      this.heldBack.has(page.id) ||
      page.access === 'view' ||
      page.access === 'comment' ||
      page.access === 'none';
    let data: Uint8Array | null = null;
    try {
      if (cursor && parts.length && !reader) data = this.codec.merge(parts);
    } catch (error) {
      // A log that does not merge cannot be sent whole (the document layer moves such updates
      // aside when it opens the page); a pass that failed on it would fail for ever.
      console.warn('Could not merge a page for its repair:', error);
    }
    if (!cursor || !data || data.byteLength > PUSH_LIMITS.alone) {
      await this.abandonRefusal(page, waiting.updates);
      return;
    }
    let repair = waiting.repair;
    if (!repair) {
      // Kept before it goes: a stop before the answer sends it again under the same id.
      repair = { updateId: uuidv7(), covers: [...waiting.updates], seq: null };
      await this.setRefusal(page.workspaceId, page.id, { ...waiting, repair });
    }
    let answer;
    try {
      answer = await this.api.repairDoc(page.id, {
        epoch: cursor.epoch,
        clientSchemaVersion: this.codec.schemaVersion,
        update: { updateId: repair.updateId, data },
      });
    } catch (error) {
      if (!(error instanceof SyncHttpError)) throw error;
      if (error.code === 'doc.epochMismatch') {
        // The pull takes the new epoch, and its reset keeps these aside with the page's edits.
        this.wanted.add(page.id);
        return;
      }
      if (![403, 404, 410, 413, 426].includes(error.status)) throw error;
      await this.abandonRefusal(page, waiting.updates);
      return;
    }
    const now = (await this.refusalsOf(page.workspaceId))[page.id];
    if (now?.repair?.updateId === repair.updateId && answer.ack)
      await this.setRefusal(page.workspaceId, page.id, {
        ...now,
        repair: { ...repair, seq: answer.ack.seq },
      });
    await this.takePull(page, answer.pull, false, 0, cursor.headSeq);
    if (answer.pull.more) await this.pullDocNow(page);
  }

  /**
   * Refused updates no repair can carry: kept aside in the store's corrupt area, as every refusal
   * was before (the page's history has them), and the user told.
   */
  private async abandonRefusal(page: PageRecord, ids: Id[]) {
    const refused = new Set(ids);
    const bad = (await this.store.loadDoc(page.id)).updates
      .filter((u) => refused.has(u.updateId))
      .map((u) => u.localSeq);
    if (bad.length) {
      await this.store.quarantineUpdates(page.id, bad, 'doc.refused');
      this.notice('doc.refused', page.workspaceId, page.id);
    }
    await this.setRefusal(page.workspaceId, page.id, null);
    await this.recountSoon();
  }

  /** Something stopped waiting outside the count a pass makes: "Synced" as soon as nothing does. */
  private async recountSoon() {
    if (this.status_.state !== 'syncing') return;
    if (this.running) this.recount = true;
    else await this.report('synced', false);
  }

  // 4b. Pins ---------------------------------------------------------------------------------------

  /** Keeps a page (and, with `subtree`, every page under it, later ones too) on this device. */
  async pin(pageId: Id, subtree = false): Promise<void> {
    const page = await this.store.getPage(pageId);
    if (!page) throw new Error('No such page');
    await this.store.pin({ workspaceId: page.workspaceId, pageId, subtree, pinnedAt: this.iso() });
    this.rowDocsHeld.clear();
    this.rowDocsChanged.clear();
    this.emit({ kind: 'offline', workspaceId: page.workspaceId });
    this.kick(0);
  }

  /**
   * Stops keeping a page (and a database's rows' documents) for offline use: nothing more is
   * fetched for it, and what is held stays, as an opened page's does.
   */
  async unpin(pageId: Id): Promise<void> {
    const page = await this.store.getPage(pageId);
    await this.store.unpin(pageId);
    this.rowDocsHeld.clear();
    this.rowDocsChanged.clear();
    if (page) this.emit({ kind: 'offline', workspaceId: page.workspaceId });
  }

  /** The pin that keeps a page offline: its own, or a subtree pin above it; null if none. */
  async pinOf(pageId: Id): Promise<{ pin: PinRecord; inherited: boolean } | null> {
    const page = await this.store.getPage(pageId);
    if (!page) return null;
    const pins = new Map((await this.store.pins(page.workspaceId)).map((p) => [p.pageId, p]));
    const own = pins.get(pageId);
    if (own) return { pin: own, inherited: false };
    const mirror = await this.store.readMirror(page.workspaceId);
    const byId = new Map(mirror.pages.map((p) => [p.id, p]));
    const seen = new Set<Id>();
    for (let p = byId.get(page.parentPageId ?? ''); p && !seen.has(p.id);) {
      seen.add(p.id);
      const pin = pins.get(p.id);
      if (pin?.subtree) return { pin, inherited: true };
      p = p.parentPageId ? byId.get(p.parentPageId) : undefined;
    }
    return null;
  }

  /**
   * What the shell shows of offline use: pins, how many pinned pages are held, what remains, and
   * the same of pinned databases' rows' documents (Phase 12).
   */
  async offlineProgress(workspaceId: Id): Promise<OfflineProgress> {
    const mirror = await this.store.readMirror(workspaceId);
    const pinned = await this.pinnedPages(workspaceId, mirror.pages);
    const held = new Set(await this.store.heldPages(workspaceId));
    let have = 0;
    for (const id of pinned) if (held.has(id)) have++;
    let rows = 0;
    let rowsHeld = 0;
    for (const id of pinnedDatabases(mirror.pages, pinned))
      for (const row of await this.rowDocs(id)) {
        rows++;
        if (held.has(row.id)) rowsHeld++;
      }
    return {
      pins: await this.store.pins(workspaceId),
      pinned: pinned.size,
      held: have,
      toFetch: pinned.size - have,
      available: held.size,
      rows,
      rowsHeld,
      rowsToFetch: rows - rowsHeld,
    };
  }

  /** Pages of the workspace that open with no network: those whose document this device holds. */
  async availableOffline(workspaceId: Id): Promise<Set<Id>> {
    return new Set(await this.store.heldPages(workspaceId));
  }

  /** Live pages the workspace's pins cover: pinned pages and every page under a subtree pin. */
  private async pinnedPages(workspaceId: Id, pages: PageRecord[]): Promise<Set<Id>> {
    const pins = await this.store.pins(workspaceId);
    const out = new Set<Id>();
    if (!pins.length) return out;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const children = new Map<Id, PageRecord[]>();
    for (const page of pages)
      if (page.parentPageId) {
        const list = children.get(page.parentPageId) ?? [];
        list.push(page);
        children.set(page.parentPageId, list);
      }
    for (const pin of pins) {
      const root = byId.get(pin.pageId);
      if (!root || root.trashedAt) continue;
      out.add(root.id);
      if (!pin.subtree) continue;
      const queue = [root.id];
      while (queue.length)
        for (const child of children.get(queue.shift()!) ?? [])
          if (!child.trashedAt && !out.has(child.id)) {
            out.add(child.id);
            queue.push(child.id);
          }
    }
    return out;
  }

  /**
   * What pins cover and this device does not hold: pinned pages first, then pinned databases'
   * rows' documents (Phase 12, `rowDocs`), by the batch route, at most `PIN_REQUESTS` requests a
   * pass (the next pass soon while some remain). After a 429 or 503 the pins wait out the server's
   * `Retry-After` while the rest of the loop goes on: what is typed still syncs.
   */
  private async fetchPinned(workspace: WorkspaceRecord, pages: PageRecord[], pinned: Set<Id>) {
    if (!pinned.size || this.now() < this.pinsNotBefore) return;
    const held = new Set(await this.store.heldPages(workspace.id));
    const creating = await this.creating(workspace.id);
    const missing = (id: Id) => !held.has(id) && !creating.has(id) && !this.pullRefused.has(id);
    const todo: PageRecord[] = pages.filter((p) => pinned.has(p.id) && missing(p.id));
    for (const id of pinnedDatabases(pages, pinned)) {
      const changed = [...(this.rowDocsChanged.get(id)?.values() ?? [])];
      this.rowDocsChanged.delete(id);
      if (this.rowDocsHeld.has(id)) {
        // Every row's document was held: only a row that changed since can lack one. A database
        // held in part is read whole on any change (a row moved can bring another under the cap).
        const lacking = changed.some(
          (r) => !r.trashedAt && (r.docHeadSeq ?? 0) > 0 && missing(r.id),
        );
        if (!lacking && (!changed.length || (await this.store.dbHold(id))?.mode === 'full'))
          continue;
        this.rowDocsHeld.delete(id);
      }
      const rows = (await this.rowDocs(id)).filter((r) => missing(r.id));
      if (!rows.length) this.rowDocsHeld.add(id);
      todo.push(...rows);
    }
    if (!todo.length) return;
    try {
      const { left } = await this.pullMany(
        workspace.id,
        todo.map((page) => ({ page, after: 0 })),
        this.options.pinRequests ?? PIN_REQUESTS,
        PIN_SINGLES,
      );
      if (left) this.backlog = true;
    } catch (error) {
      if (!(error instanceof SyncHttpError) || (error.status !== 429 && error.status !== 503))
        throw error;
      this.pinsNotBefore = this.now() + (error.retryAfterMs ?? PIN_WAIT);
    } finally {
      this.heldChanged.add(workspace.id);
    }
  }

  /**
   * The rows of a pinned database whose documents it holds (Phase 12): every live row with a
   * document on the server, in the database's row order, its templates first and then at most
   * `PIN_ROW_DOCS` rows. A database above `LOCAL_ROW_LIMIT` rows is held in part, so these are of
   * the rows this device holds (those its views' queries returned): the first of them in order.
   */
  private async rowDocs(databaseId: Id): Promise<RowRecord[]> {
    const rows = (await this.store.readRows(databaseId))
      .filter((r) => !r.trashedAt && (r.docHeadSeq ?? 0) > 0)
      .sort((a, b) => ordinal(a.orderKey, b.orderKey) || ordinal(a.id, b.id));
    return [
      ...rows.filter((r) => r.isTemplate),
      ...rows.filter((r) => !r.isTemplate).slice(0, PIN_ROW_DOCS),
    ];
  }

  // 4c. Databases ----------------------------------------------------------------------------------

  /**
   * Keeps a database's rows on this device: what a view showing it asks for. A database at most
   * `LOCAL_ROW_LIMIT` rows is held in full (every row fetched, a pass soon, then kept fresh by
   * the feed, and queried here); a larger one partially (the rows its queries return are kept).
   * A hold that exists is left as it is. Returns the hold.
   */
  async holdDatabase(databaseId: Id): Promise<DbHold> {
    const existing = await this.store.dbHold(databaseId);
    if (existing) return existing;
    const page = await this.store.getPage(databaseId);
    if (!page || page.kind !== 'database') throw new Error('No such database');
    const mirror = await this.store.readMirror(page.workspaceId);
    const database = mirror.databases.find((d) => d.id === databaseId);
    // Nothing to fetch for a local workspace's database: every row is here.
    const local = mirror.workspaces[0]?.localOnly ?? true;
    const hold = this.newHold(page.workspaceId, databaseId, database, local);
    await this.store.holdDatabase(hold);
    this.emit({ kind: 'rows', workspaceId: page.workspaceId, databaseId });
    if (!hold.complete) this.kick(0);
    return hold;
  }

  private newHold(
    workspaceId: Id,
    databaseId: Id,
    database: DatabaseRecord | undefined,
    complete = false,
  ): DbHold {
    const full = !database || database.rowCount <= LOCAL_ROW_LIMIT;
    return {
      databaseId,
      workspaceId,
      mode: full ? 'full' : 'partial',
      complete: full && complete,
      after: null,
      heldAt: this.iso(),
    };
  }

  /** How much of a database this device holds, for a view's "loading rows" and its local flag. */
  async holdProgress(databaseId: Id): Promise<HoldProgress> {
    const hold = await this.store.dbHold(databaseId);
    const page = await this.store.getPage(databaseId);
    const database = page
      ? (await this.store.readMirror(page.workspaceId)).databases.find((d) => d.id === databaseId)
      : undefined;
    const rows = hold ? await this.store.readRows(databaseId) : [];
    return {
      hold,
      held: rows.filter((r) => !r.trashedAt && !r.isTemplate).length,
      total: database?.rowCount ?? 0,
      local: !!hold && hold.mode === 'full' && hold.complete,
    };
  }

  /**
   * The server's query of a database this device does not hold in full (a view of a large
   * database, a relation picker's search). The rows it returns are kept when the database is
   * held (a partial hold is this cache), so they show offline. Throws `OfflineError` offline.
   * Phase 9: the answer is returned before its rows are kept (a view draws them without waiting
   * for the store's write of 500 rows); they are kept one answer at a time, in the order answered
   * (`kept()` waits for them).
   */
  async queryDatabase(databaseId: Id, request: QueryRequest): Promise<QueryAnswer> {
    if (!this.account) throw new SyncHttpError(401, 'auth.required');
    const answer = await this.api.query(databaseId, request);
    if (answer.rows.length) this.keepQueried(databaseId, answer.rows);
    return answer;
  }

  private keeping: Promise<void> = Promise.resolve();

  private keepQueried(databaseId: Id, rows: RowRecord[]) {
    this.keeping = this.keeping
      .then(async () => {
        const page = await this.store.getPage(databaseId);
        if (!page || !(await this.store.dbHold(databaseId))) return;
        await this.beforeRemote(page.workspaceId, [], rows);
        await this.applyBatch({ workspaceId: page.workspaceId, rows });
      })
      .catch((error: unknown) => console.warn('Rows a query answered were not kept:', error));
  }

  /** Every query's rows kept that were answered so far (tests; a close). */
  kept(): Promise<void> {
    return this.keeping;
  }

  /**
   * Pinned pages hold the databases among them, in full when small; from Phase 12 their rows'
   * documents too (`fetchPinned`).
   */
  private async holdPinned(
    workspace: WorkspaceRecord,
    pages: PageRecord[],
    databases: DatabaseRecord[],
    pinned: Set<Id>,
  ) {
    if (!pinned.size) return;
    const kinds = new Map(pages.map((p) => [p.id, p.kind]));
    const records = new Map(databases.map((d) => [d.id, d]));
    let held: Set<Id> | null = null;
    for (const id of pinned) {
      if (kinds.get(id) !== 'database') continue;
      held ??= new Set((await this.store.dbHolds(workspace.id)).map((h) => h.databaseId));
      if (held.has(id)) continue;
      await this.store.holdDatabase(this.newHold(workspace.id, id, records.get(id)));
      held.add(id);
      this.heldChanged.add(workspace.id);
      this.emit({ kind: 'rows', workspaceId: workspace.id, databaseId: id });
    }
  }

  /**
   * After the feed: a hold follows its database's size (a full one whose `rowCount` passes
   * `LOCAL_ROW_LIMIT` becomes partial; a partial one at or below it becomes full, to fetch), and
   * full holds not complete fetch their rows by id, at most `ROWS_REQUESTS` requests a pass (the
   * next pass comes soon while some remain). Each page of rows is written with the hold's new
   * `after` in one batch; rows held here in the page's range the server did not return (gone
   * while this device was not told, as after the feed's retention) go, unless something waits on
   * them.
   */
  private async fetchRows(workspace: WorkspaceRecord, databases: DatabaseRecord[]) {
    const holds = await this.store.dbHolds(workspace.id);
    if (!holds.length) return;
    const records = new Map(databases.map((d) => [d.id, d]));
    let creating: Set<Id> | null = null;
    for (const held of holds) {
      const database = records.get(held.databaseId);
      if (!database) continue;
      const big = database.rowCount > LOCAL_ROW_LIMIT;
      let hold = held;
      if (held.mode === 'full' && big) hold = { ...held, mode: 'partial', complete: false };
      else if (held.mode === 'partial' && !big)
        hold = { ...held, mode: 'full', complete: false, after: null };
      if (hold.mode === 'partial') {
        // Its rows are those its queries returned, kept as they were.
        if (hold !== held) await this.applyBatch({ workspaceId: workspace.id, holds: [hold] });
        continue;
      }
      if (hold.complete) continue;
      // Not on the server yet: made here, so its rows are here too.
      creating ??= await this.creating(workspace.id);
      if (creating.has(hold.databaseId)) continue;
      while (!hold.complete) {
        if (this.rowRequests >= (this.options.rowsRequests ?? ROWS_REQUESTS)) {
          this.backlog = true;
          if (hold !== held) await this.applyBatch({ workspaceId: workspace.id, holds: [hold] });
          return;
        }
        this.rowRequests++;
        const from = hold.after;
        let page;
        try {
          page = await this.api.rows(hold.databaseId, from, this.options.rowsPage ?? ROWS_PAGE);
        } catch (error) {
          // Gone, or out of reach for this account: the feed's delete or revoke says what goes.
          if (error instanceof SyncHttpError && (error.status === 404 || error.status === 410))
            break;
          throw error;
        }
        hold = { ...hold, after: page.next, complete: page.next === null };
        const stale = await this.staleRows(workspace.id, hold.databaseId, from, page);
        await this.beforeRemote(workspace.id, [], page.rows);
        if (stale.length) this.quarantineDirty = true;
        await this.applyBatch({
          workspaceId: workspace.id,
          rows: page.rows,
          deleteRows: stale,
          holds: [hold],
        });
      }
    }
  }

  /**
   * Rows held here in a fetched page's range (after `from`, up to its `next`) that the server did
   * not return and nothing waits on: gone on the server while this device was not told. None when
   * the page is not in the order this device compares ids in (it then removes nothing).
   */
  private async staleRows(
    workspaceId: Id,
    databaseId: Id,
    from: Id | null,
    page: { rows: RowRecord[]; next: Id | null },
  ): Promise<Id[]> {
    const ids = page.rows.map((r) => r.id);
    const ordered = ids.every((id, i) => (i === 0 ? from === null || id > from : id > ids[i - 1]));
    if (!ordered || (page.next !== null && ids.length && ids.at(-1)! > page.next)) return [];
    const sent = new Set(ids);
    const held = (await this.store.readRows(databaseId)).filter(
      (r) =>
        (from === null || r.id > from) &&
        (page.next === null || r.id <= page.next) &&
        !sent.has(r.id),
    );
    if (!held.length) return [];
    const waiting = await this.waiting(workspaceId);
    return held.filter((r) => !waiting.has(r.id)).map((r) => r.id);
  }

  // 5. Repair --------------------------------------------------------------------------------------

  private async runChecks(workspace: WorkspaceRecord) {
    let made = 0;
    for (const [pageId, tries] of [...this.checks]) {
      const page = await this.store.getPage(pageId);
      if (!page) {
        this.checks.delete(pageId);
        continue;
      }
      if (page.workspaceId !== workspace.id) continue;
      if (made++ >= CHECKS_PER_PASS) return;
      const outcome = await this.check(page);
      if (outcome === 'done' || (outcome === 'wait' && tries + 1 >= CHECK_TRIES))
        this.checks.delete(pageId);
      else if (outcome === 'wait') this.checks.set(pageId, tries + 1);
      else if (outcome === 'verify') this.checks.set(pageId, 0);
      // 'later': edits wait to be sent; the check comes once they are, at no cost of a try.
    }
  }

  /**
   * Compares the page's state hash with the server's at the same head (SYNC_DESIGN.md, Repair):
   * `done` when settled, `wait` while the server catches up (its hash not ready, the heads not
   * equal yet), `later` while edits wait to be sent, `verify` after a repair (the next check says
   * whether it helped).
   */
  private async check(page: PageRecord): Promise<'done' | 'wait' | 'later' | 'verify'> {
    const cursor = await this.store.docCursor(page.id);
    if (!cursor) return 'done';
    // Refused updates wait for their own repair; the check comes once they are settled.
    if ((await this.refusalsOf(page.workspaceId))[page.id]) return 'later';
    const doc = await this.store.loadDoc(page.id);
    if (doc.updates.some((u) => u.seq === null)) return 'later';
    let state: DocStateHash;
    try {
      state = await this.api.docStateHash(page.id);
    } catch (error) {
      if (error instanceof SyncHttpError && [403, 404, 410].includes(error.status)) return 'done';
      throw error;
    }
    if (state.epoch !== cursor.epoch || state.upToSeq > cursor.headSeq) {
      // The server moved on: the pull comes first.
      this.wanted.add(page.id);
      return 'wait';
    }
    if (state.hash === null || state.upToSeq < cursor.headSeq) return 'wait';
    // What was read must still be what the device holds at that head.
    const now = await this.store.docCursor(page.id);
    if (!now || now.headSeq !== cursor.headSeq || now.epoch !== cursor.epoch) return 'wait';
    const local = await this.codec.stateHash(partsOf(doc));
    const prior = await this.store.repairState(page.id);
    const repaired = prior && prior.epoch === state.epoch && prior.repairs > 0 ? prior : null;
    if (local === state.hash) {
      await this.store.setRepairState({
        pageId: page.id,
        epoch: state.epoch,
        checkedSeq: state.upToSeq,
        at: this.iso(),
        repairs: 0,
      });
      if (repaired) this.notice('doc.repaired', page.workspaceId, page.id);
      return 'done';
    }
    if (repaired) {
      // The repair is not in the server's validated head yet.
      if (state.upToSeq < repaired.checkedSeq) return 'wait';
      // A repair was made at this epoch and did not help: reported, not retried.
      if (!this.repairReported.has(page.id)) {
        this.repairReported.add(page.id);
        this.notice('doc.repairFailed', page.workspaceId, page.id);
      }
      return 'done';
    }
    return (await this.repair(page, state, doc)) ? 'verify' : 'wait';
  }

  /**
   * Sends the device's full state (when the account may edit) and takes the server's from the
   * start. False when it could not be made now (the epoch moved; the page is gone).
   */
  private async repair(page: PageRecord, state: DocStateHash, doc: StoredDoc): Promise<boolean> {
    const parts = partsOf(doc);
    const reader =
      this.heldBack.has(page.id) ||
      page.access === 'view' ||
      page.access === 'comment' ||
      page.access === 'none';
    let update: { updateId: Id; data: Uint8Array } | null = null;
    if (!reader && parts.length) {
      const data = this.codec.merge(parts);
      // The server takes at most 1 MB in one update: a larger state only pulls.
      if (data.byteLength <= PUSH_LIMITS.alone) update = { updateId: uuidv7(), data };
    }
    const request = { epoch: state.epoch, clientSchemaVersion: this.codec.schemaVersion };
    let answer;
    try {
      answer = await this.api.repairDoc(page.id, { ...request, update });
    } catch (error) {
      if (!(error instanceof SyncHttpError)) throw error;
      if (error.status === 404 || error.status === 410) return false;
      if (error.code === 'doc.epochMismatch') {
        this.wanted.add(page.id);
        return false;
      }
      if (!update || ![403, 413, 426].includes(error.status)) throw error;
      // It may not send (or not this much): the pull alone.
      update = null;
      answer = await this.api.repairDoc(page.id, { ...request, update });
    }
    await this.takePull(page, answer.pull, false, 0, state.upToSeq);
    if (answer.pull.more) await this.pullDoc(page);
    await this.store.setRepairState({
      pageId: page.id,
      epoch: state.epoch,
      // Where the repair shows: the head that holds the device's state, or (a reader) this one.
      checkedSeq: answer.ack?.seq ?? state.upToSeq,
      at: this.iso(),
      repairs: 1,
    });
    return true;
  }

  // 0. Assets --------------------------------------------------------------------------------------

  private async uploadAssets(workspace: WorkspaceRecord) {
    const pending = (await this.store.pendingAssets(20)).filter(
      (a) => a.workspaceId === workspace.id,
    );
    for (const asset of pending) await this.uploadAsset(asset);
  }

  private async uploadAsset(asset: AssetRecord) {
    const bytes = await this.store.getAssetBytes(asset.id);
    if (!bytes) return;
    try {
      const ticket = await this.api.assetTicket(asset.workspaceId, {
        id: asset.id,
        fileName: asset.fileName,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
      });
      await this.api.putBytes(ticket.uploadUrl, ticket.headers, bytes);
      await this.api.completeAsset(asset.id);
      await this.store.markAssetUploaded(asset.id);
    } catch (error) {
      if (
        error instanceof SyncHttpError &&
        (error.code === 'asset.typeNotAllowed' || error.code === 'limit.size')
      ) {
        // The server will never take it: it stays on this device, and the user is told.
        await this.store.markAssetUploaded(asset.id);
        this.notice(error.code, asset.workspaceId);
        return;
      }
      throw error;
    }
  }

  // 6. Real time (Phase 6) ---------------------------------------------------------------------------

  /**
   * The hub's transport (the shell's SignalR client, a test's in-memory hub), or null for none.
   * The engine follows its state: connected, it joins and listens; disconnected, it is Phase 3's.
   */
  setRealtime(transport: RealtimeTransport | null) {
    for (const off of this.offRealtime) off();
    this.offRealtime = [];
    this.dropJoins();
    this.realtime = transport;
    if (!transport) return;
    this.offRealtime.push(
      transport.on('state', (state) => this.onRealtimeState(state)),
      transport.on('updates', (frame) => this.onFrame(frame)),
      transport.on('changesAvailable', (change) => this.onChangesAvailable(change)),
      transport.on('accessRevoked', (revoked) => this.onAccessRevoked(revoked)),
    );
    if (transport.state === 'connected') this.onRealtimeState('connected');
  }

  /** Whether the hub's connection is open now. */
  private get connected(): boolean {
    return this.realtime?.state === 'connected';
  }

  /**
   * The shell opened (`open`) or closed a page: an open one is joined on the hub while it is
   * connected, so others' edits arrive as they land and its saves go out at once (`saved`).
   */
  live(pageId: Id, open: boolean) {
    if (open) {
      this.livePages.add(pageId);
      if (this.connected) this.track(this.joinLive(pageId, this.connection));
      return;
    }
    this.livePages.delete(pageId);
    if (this.unjoin(pageId) && this.connected && this.realtime)
      this.track(this.realtime.leavePage(pageId));
  }

  /**
   * Told when a page is joined on the hub (presence may be sent for it from then on) and when it
   * no longer is (left, access lost, the connection gone); returns its off.
   */
  onJoined(listener: (pageId: Id, joined: boolean) => void): () => void {
    this.joinListeners.add(listener);
    return () => void this.joinListeners.delete(listener);
  }

  /** Whether the page is joined on the hub now. */
  isJoined(pageId: Id): boolean {
    return this.connected && this.joined.has(pageId);
  }

  private tellJoined(pageId: Id, joined: boolean) {
    for (const listener of [...this.joinListeners]) {
      try {
        listener(pageId, joined);
      } catch (error) {
        console.error('A join listener failed:', error);
      }
    }
  }

  /** The page is no longer joined; true when it was. */
  private unjoin(pageId: Id): boolean {
    if (!this.joined.delete(pageId)) return false;
    this.tellJoined(pageId, false);
    return true;
  }

  /**
   * An open page's document was saved. A page joined on the hub sends its new updates through it
   * at once; anything else is a local change like any (a pass soon, over HTTP).
   */
  saved(pageId: Id) {
    if (
      !this.account ||
      !this.connected ||
      !this.joined.has(pageId) ||
      this.heldBack.has(pageId) ||
      this.now() < this.liveNotBefore
    ) {
      this.changed();
      return;
    }
    this.waitingOne();
    this.queueLive(pageId);
  }

  /** Forgets what was joined (the connection or the account changed). */
  private dropJoins() {
    this.connection++;
    for (const pageId of [...this.joined.keys()]) this.unjoin(pageId);
    this.joining.clear();
    this.followed = '';
  }

  private onRealtimeState(state: RealtimeState) {
    if (state === 'connected') {
      this.dropJoins();
      if (this.account) this.track(this.rejoin(this.connection));
      return;
    }
    if (state !== 'disconnected') return;
    this.dropJoins();
    // Exactly Phase 3 again: the next pass within 1.5 s (the timer may be set for the live 30 s),
    // not at once, so a recycle's clients do not all pass together; what a live push in flight
    // left asks for its own pass (`queueLive`).
    const base = this.options.intervalMs ?? 1500;
    if (this.timer !== null && this.due - this.now() > base) this.soon(base);
  }

  /**
   * After a (re)connect: the synced workspaces followed and the open pages joined again, each
   * caught up at once if it moved meanwhile; a pass only when a feed moved or something waits,
   * else the periodic pass goes back to the live interval.
   */
  private async rejoin(generation: number) {
    // Connected before the first pass knew which workspaces sync: the store says.
    if (!this.mine.size && this.account)
      this.mine = new Set((await this.syncedWorkspaces(this.account)).map((w) => w.id));
    const behind = await this.followWorkspaces(generation, true);
    await Promise.all([...this.livePages].map((pageId) => this.joinLive(pageId, generation)));
    if (generation !== this.connection) return;
    // A pass already running covers what waits; a feed ahead of this device needs another.
    if (behind) this.soon(0);
    else if (this.running) return;
    else if (this.status_.state !== 'synced' || this.status_.waiting > 0) this.soon(0);
    else if (this.timer !== null && !this.backlog && !this.again && !this.failures) {
      const at = this.lastPassAt + (this.options.liveIntervalMs ?? LIVE_INTERVAL);
      if (at > this.due) this.schedule(at - this.now());
    }
  }

  /**
   * Follows the synced workspaces (at most 50) unless they are followed already. Returns whether
   * one's feed is ahead of this device (or not read yet).
   */
  private async followWorkspaces(generation: number, force = false): Promise<boolean> {
    const realtime = this.realtime;
    if (!realtime || !this.account || !this.connected || generation !== this.connection)
      return false;
    const ids = [...this.mine].sort().slice(0, REALTIME_LIMITS.workspaces);
    const key = ids.join(',');
    if (!ids.length || (!force && key === this.followed)) return false;
    const answers = await realtime.joinWorkspaces(ids);
    if (generation !== this.connection) return false;
    this.followed = key;
    let behind = false;
    for (const answer of answers) {
      const cursor = await this.store.syncCursor(answer.workspaceId);
      if (cursor === null || answer.seq > cursor) behind = true;
    }
    return behind;
  }

  /** Joins an open page, and catches it up at once if the server's head is past this device's. */
  private async joinLive(pageId: Id, generation: number) {
    const realtime = this.realtime;
    if (!realtime || !this.account || !this.connected || generation !== this.connection) return;
    if (this.joined.has(pageId) || this.joining.has(pageId)) return;
    if (this.joined.size >= REALTIME_LIMITS.pages) return;
    const page = await this.store.getPage(pageId);
    if (!page || !this.mine.has(page.workspaceId)) return;
    this.joining.add(pageId);
    let joined: JoinedPage;
    try {
      joined = await realtime.joinPage(pageId);
    } catch (error) {
      // Not on the server yet (made here), not readable, or the connection went: not joined; a
      // later pass tries again.
      if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError)) throw error;
      return;
    } finally {
      if (generation === this.connection) this.joining.delete(pageId);
    }
    if (generation !== this.connection) return;
    if (!this.livePages.has(pageId)) {
      // Closed while it was being joined.
      this.track(realtime.leavePage(pageId));
      return;
    }
    this.joined.set(pageId, joined);
    this.tellJoined(pageId, true);
    const cursor = await this.store.docCursor(pageId);
    if (cursor && (joined.epoch !== cursor.epoch || joined.headSeq > cursor.headSeq))
      this.track(this.framePull(pageId));
    // What waits to be sent goes now.
    if ((await this.store.unsentDocUpdates(PUSH_READ)).some((d) => d.pageId === pageId))
      this.queueLive(pageId);
  }

  /** After a pass, while connected: newly synced workspaces followed, open pages joined. */
  private async afterPassLive(generation: number) {
    await this.followWorkspaces(generation);
    await Promise.all([...this.livePages].map((pageId) => this.joinLive(pageId, generation)));
  }

  /** A live push for the page, unless one waits already (it will read what this save wrote). */
  private queueLive(pageId: Id) {
    if (this.liveQueued.has(pageId)) return;
    this.liveQueued.add(pageId);
    this.track(
      this.onPage(pageId, async () => {
        this.liveQueued.delete(pageId);
        let done = false;
        try {
          done = await this.pushLive(pageId);
        } finally {
          // Left for a pass (or failed): sent over HTTP soon, as any local change is.
          if (!done) this.soon(SOON);
        }
        if (done && !this.liveQueued.size && this.status_.state === 'syncing') {
          if (this.running) this.recount = true;
          else await this.report('synced', false);
        }
      }),
    );
  }

  /** The page's unsent updates through the hub; false when some are left for a pass. */
  private async pushLive(pageId: Id): Promise<boolean> {
    if (!this.account || !this.connected || !this.joined.has(pageId)) return false;
    if (this.now() < this.liveNotBefore) return false;
    const page = await this.store.getPage(pageId);
    if (!page || this.heldBack.has(pageId)) return true;
    const unsent = await this.store.unsentDocUpdates(PUSH_READ);
    const mine = unsent.find((d) => d.pageId === pageId);
    if (!mine) {
      // Nothing of this page among what was read: nothing waits, unless others' crowd it out.
      return unsent.reduce((n, d) => n + d.updates.length, 0) < PUSH_READ;
    }
    return this.pushPageNow(page.workspaceId, page, mine.updates, true);
  }

  /** A frame from the hub, taken in the page's turn. */
  private onFrame(frame: RelayFrame) {
    if (!this.account) return;
    this.track(this.onPage(frame.pageId, () => this.takeFrame(frame)));
  }

  /**
   * A frame for a page this device holds: one that continues from this device's cursor (same
   * epoch, `after` at or below it, complete) is taken as a pull's answer; anything else (a gap,
   * another epoch, rows the server could not read) means the page is pulled over HTTP. A frame
   * that brings nothing new (a duplicate, one overtaken) changes nothing.
   */
  private async takeFrame(frame: RelayFrame) {
    const cursor = await this.store.docCursor(frame.pageId);
    if (!cursor) return;
    if (frame.epoch !== cursor.epoch || !frame.complete || frame.after > cursor.headSeq) {
      await this.framePull(frame.pageId, true);
      return;
    }
    if (frame.cursor <= cursor.headSeq && !frame.rejected.length) return;
    const page = await this.store.getPage(frame.pageId);
    if (!page) return;
    await this.noteRefusals(
      page,
      { after: frame.after, upTo: frame.cursor, rejected: frame.rejected },
      cursor.headSeq,
    );
    const added = await this.store.applyRemoteDocUpdates(page.id, {
      epoch: frame.epoch,
      headSeq: frame.cursor,
      updates: frame.updates.filter((u) => u.seq > cursor.headSeq),
    });
    if (added.length)
      this.emit({ kind: 'doc', pageId: page.id, updates: added.map((u) => u.data) });
  }

  /** The page over HTTP now, as a pass would; if that fails, the next pass pulls it. */
  private async framePull(pageId: Id, inChain = false) {
    const page = await this.store.getPage(pageId);
    if (!page || !this.account) return;
    try {
      await (inChain ? this.pullDocNow(page) : this.pullDoc(page));
    } catch (error) {
      this.wanted.add(pageId);
      this.soon(SOON);
      throw error;
    }
    if (this.heldChanged.delete(page.workspaceId))
      this.emit({ kind: 'offline', workspaceId: page.workspaceId });
  }

  /** A followed workspace's feed moved past this device's cursor: a pass now. */
  private onChangesAvailable(change: ChangesAvailable) {
    if (!this.account || !this.mine.has(change.workspaceId)) return;
    this.track(
      (async () => {
        const cursor = await this.store.syncCursor(change.workspaceId);
        if (cursor !== null && change.seq <= cursor) return;
        this.wake();
      })(),
    );
  }

  /** The hub took a page (or a workspace) from this connection: a pass reads what changed. */
  private onAccessRevoked(revoked: AccessRevoked) {
    if (!this.account) return;
    if (revoked.pageId) this.unjoin(revoked.pageId);
    else {
      for (const [pageId, joined] of [...this.joined])
        if (joined.workspaceId === revoked.workspaceId) this.unjoin(pageId);
      this.followed = '';
    }
    this.wake();
  }

  /** A pass at once for the hub's news, but not sooner than `WAKE_SPACING` after the last. */
  private wake() {
    this.soon(Math.max(0, this.lastPassAt + WAKE_SPACING - this.now()));
  }

  /** Runs `fn` after everything queued for the page before it: its pushes, pulls and frames. */
  private onPage<T>(pageId: Id, fn: () => Promise<T>): Promise<T> {
    const run = (this.pageChains.get(pageId) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.pageChains.set(pageId, tail);
    void tail.then(() => {
      if (this.pageChains.get(pageId) === tail) this.pageChains.delete(pageId);
    });
    return run;
  }

  // Upload of a local workspace (M2.3) ----------------------------------------------------------

  /**
   * Sends a local-only workspace to the account, intact: its id, sections, pages (ids, tree,
   * order, trash), favourites, documents and assets. The workspace is made on the server first;
   * then each page's log becomes one update holding all of it; then the outbox is replaced by the
   * workspace's records as creates, and the loop sends the rest.
   */
  async upload(workspaceId: Id): Promise<void> {
    const account = this.account;
    if (!account) throw new SyncHttpError(401, 'auth.required');
    const current = await this.store.readMirror(workspaceId);
    const workspace = current.workspaces[0];
    if (!workspace) throw new Error('No such workspace');
    if (!workspace.localOnly) return;
    const { replaced, snapshot, rows } = await this.uploadState(workspaceId);
    await this.api.createWorkspace({
      id: workspace.id,
      name: workspace.name,
      icon: workspace.icon,
    });
    const ids = new Set<number>();
    for (const page of [...snapshot.pages, ...rows]) {
      const doc = await this.store.loadDoc(page.id);
      const parts = partsOf(doc);
      if (!parts.length) continue;
      const merged = parts.length === 1 ? parts[0] : this.codec.merge(parts);
      for (const id of this.codec.clientIds(merged)) ids.add(id);
      const upTo = Math.max(doc.snapshotCovers, ...doc.updates.map((u) => u.localSeq));
      await this.store.replaceDoc(page.id, { updateId: uuidv7(), data: merged }, upTo);
    }
    const refused = ids.size ? await this.registerAll(workspaceId, [...ids]) : new Set<number>();
    if (refused.size) throw new Error('A Yjs client id of this workspace is taken on the server');
    const ops = uploadOps(
      workspace,
      snapshot.sections,
      snapshot.pages,
      snapshot.favourites,
      uuidv7,
      {
        databases: snapshot.databases ?? [],
        views: snapshot.views ?? [],
        rows,
      },
    );
    await this.store.beginUpload(workspaceId, account.id, ops, replaced);
    // Its databases stay held, whole: every row is here and the feed keeps them fresh.
    for (const database of snapshot.databases ?? []) {
      const hold = await this.store.dbHold(database.id);
      if (!hold || hold.mode !== 'full' || !hold.complete)
        await this.store.holdDatabase({
          ...this.newHold(workspaceId, database.id, database, true),
          mode: 'full',
          complete: true,
        });
    }
    this.mine = new Set();
    this.mineRead = false;
    this.emit({ kind: 'mirror', workspaceId });
    this.kick(0);
  }

  /**
   * The records an upload sends, with its databases' rows (Phase 4), and the operations they stand
   * for, which the upload's creates replace. Anything written later (a page made at the same time,
   * a key typed into an open page) is not replaced, and is sent after them. The two are read apart,
   * so an operation written between them would be both in the records and kept: a first run's page,
   * made while its workspace went to the account, was created twice, and what followed it refused.
   * They are read again until the outbox is the same after the records as before them.
   */
  private async uploadState(workspaceId: Id) {
    const outbox = async () =>
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId)).map((op) => op.opId);
    let replaced = await outbox();
    for (let tries = 1; ; tries++) {
      const snapshot = await this.store.readMirror(workspaceId);
      const rows: RowRecord[] = [];
      for (const database of snapshot.databases ?? [])
        rows.push(...(await this.store.readRows(database.id)));
      const after = await outbox();
      const same = after.length === replaced.length && after.every((id, i) => id === replaced[i]);
      // Still changing after a few reads (a title typed into at that moment): what was written
      // meanwhile is sent twice, and a create the server holds already is taken as made.
      if (same || tries >= UPLOAD_READS) return { replaced, snapshot, rows };
      replaced = after;
    }
  }

  private async registerAll(workspaceId: Id, ids: number[]): Promise<Set<number>> {
    const refused = new Set<number>();
    for (let i = 0; i < ids.length; i += 1000)
      for (const id of await this.register(workspaceId, ids.slice(i, i + 1000))) refused.add(id);
    return refused;
  }
}

/** Enough to read a workspace's whole outbox. */
const OUTBOX_ALL = 1_000_000;

/** How many times an upload reads its records before it takes them as they are. */
const UPLOAD_READS = 5;

const isLaterType = (type: EntityType): type is LaterType =>
  type === 'page' || type === 'row' || type === 'database';

/**
 * A push's creates the server already held (`held`, by operation): sent twice, it refused the
 * second with the very entity it made. And the operations it refused only because they followed
 * one (`again`): `not.found` with no entity, on that entity or under it (`dependsOnCreate`); kept
 * nowhere on the server, they are decided afresh when sent again. A create refused for good
 * (an answer with no entity) and what follows it are neither.
 */
function sentTwice(
  ops: readonly Operation[],
  results: readonly OpResult[],
): { held: Set<Id>; again: Set<Id> } {
  const held = new Set<Id>();
  const again = new Set<Id>();
  const made = new Set<Id>();
  const answers = new Map(results.map((r) => [r.opId, r]));
  for (const op of ops) {
    const answer = answers.get(op.opId);
    if (answer?.status !== 'rejected') continue;
    if (op.type.endsWith('.create') && (answer.entity as { id?: Id } | null)?.id === op.entityId) {
      held.add(op.opId);
      made.add(op.entityId);
    } else if (
      made.size &&
      !answer.entity &&
      answer.error?.code === 'not.found' &&
      dependsOnCreate(op, made)
    )
      again.add(op.opId);
  }
  return { held, again };
}

/** A refused operation, as a notice names it: its type, and the fields an update set. */
export interface RefusedOp {
  type: Operation['type'];
  fields?: string[];
}

function refusedOp(op: Operation | undefined): RefusedOp | undefined {
  if (!op) return undefined;
  if (!op.type.endsWith('.update')) return { type: op.type };
  const payload = op.payload as { values?: Record<string, unknown> } & Record<string, unknown>;
  // A row's update names its properties' ids; the rest name their record's fields.
  return {
    type: op.type,
    fields: Object.keys(op.type === 'row.update' ? (payload.values ?? {}) : payload),
  };
}

/** The page a notice about an entity points at: the page, the row, the database's page. */
function entityPage(entity: EntityRecord | null | undefined): Id | undefined {
  if (!entity) return undefined;
  if ('pageId' in entity) return entity.pageId;
  if ('sectionId' in entity) return entity.id;
  // A view points at its database; a database is its page.
  if ('databaseId' in entity) return entity.databaseId;
  if ('properties' in entity) return entity.id;
  return undefined;
}

/** A tree from the server as one batch, replacing what this device holds of it. */
function treeBatch(
  workspaceId: Id,
  tree: ServerTree,
  account: Account,
  root: Id | null,
): RemoteBatch {
  return {
    workspaceId,
    workspaces: [{ ...tree.workspace, localOnly: false, accountId: account.id }],
    sections: tree.sections,
    pages: tree.pages,
    favourites: tree.favourites,
    visits: tree.visits,
    databases: tree.databases ?? [],
    views: tree.views ?? [],
    replace: { root },
  };
}

/**
 * Whether the tree holds a state the server never does, among pages with nothing waiting (their
 * local state stands until the server answers): a trashed page whose trash root is missing, not
 * trashed or not above it; a live page under a trashed parent; a page in another section than its
 * parent.
 */
export function impossibleTree(pages: PageRecord[], pending: ReadonlySet<Id> = new Set()): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const above = (page: PageRecord, root: Id) => {
    const seen = new Set<Id>();
    for (let p: PageRecord | undefined = page; p && !seen.has(p.id);) {
      if (p.id === root) return true;
      seen.add(p.id);
      p = p.parentPageId ? byId.get(p.parentPageId) : undefined;
    }
    return false;
  };
  for (const page of pages) {
    if (pending.has(page.id)) continue;
    const parent = page.parentPageId ? byId.get(page.parentPageId) : undefined;
    if (parent && !pending.has(parent.id)) {
      if (parent.sectionId !== page.sectionId) return true;
      if (parent.trashedAt && !page.trashedAt) return true;
    }
    const rootId = page.trashRootId;
    if (page.trashedAt && rootId && rootId !== page.id && !pending.has(rootId)) {
      const root = byId.get(rootId);
      if (!root || !root.trashedAt || !above(page, rootId)) return true;
    }
  }
  return false;
}

/** A page of the feed as one batch for the store; access events name subtrees to fetch again. */
export function batchOf(
  workspaceId: Id,
  changes: ServerChange[],
  account: Account,
  roots: Set<Id>,
  emit: (event: SyncEvent) => void,
): RemoteBatch {
  const batch: RemoteBatch = {
    workspaceId,
    workspaces: [],
    sections: [],
    pages: [],
    favourites: [],
    visits: [],
    deleteSections: [],
    deletePages: [],
    deleteFavourites: [],
    deleteVisits: [],
    databases: [],
    views: [],
    rows: [],
    deleteViews: [],
    deleteRows: [],
  };
  // Phase 6: told of once each per page of the feed, never stored.
  const comments = new Set<Id>();
  let notifications = false;
  for (const change of changes) {
    switch (change.entityType) {
      case 'comments':
        comments.add(change.entityId);
        break;
      case 'notification':
        notifications = true;
        break;
      case 'workspace':
        if (change.kind === 'delete') batch.deleteWorkspace = true;
        else if (change.entity)
          batch.workspaces!.push({ ...change.entity, localOnly: false, accountId: account.id });
        break;
      case 'section':
        if (change.kind === 'delete' || !change.entity) batch.deleteSections!.push(change.entityId);
        else batch.sections!.push(change.entity);
        break;
      case 'page':
        if (change.kind === 'delete' || !change.entity) batch.deletePages!.push(change.entityId);
        else batch.pages!.push(change.entity);
        break;
      case 'favourite':
        if (change.kind === 'delete' || !change.entity)
          batch.deleteFavourites!.push(change.entityId);
        else batch.favourites!.push(change.entity);
        break;
      case 'visit':
        if (change.kind === 'delete' || !change.entity) batch.deleteVisits!.push(change.entityId);
        else batch.visits!.push(change.entity);
        break;
      case 'member':
        emit({ kind: 'members', workspaceId });
        break;
      case 'access':
        roots.add(change.entityId);
        break;
      case 'database':
        // A database's delete comes with its page's, which takes it with all it holds.
        if (change.kind !== 'delete' && change.entity) batch.databases!.push(change.entity);
        break;
      case 'view':
        if (change.kind === 'delete' || !change.entity) batch.deleteViews!.push(change.entityId);
        else batch.views!.push(change.entity);
        break;
      case 'row':
        // Kept only for a database this device holds (the store's rule); deletes always apply.
        if (change.kind === 'delete' || !change.entity) batch.deleteRows!.push(change.entityId);
        else batch.rows!.push(change.entity);
        break;
    }
  }
  for (const pageId of comments) emit({ kind: 'comments', workspaceId, pageId });
  if (notifications) emit({ kind: 'notifications', workspaceId });
  return batch;
}
