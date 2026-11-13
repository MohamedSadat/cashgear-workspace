# Sync design

How edits become durable, how they reach the server and other devices, what happens when two
people disagree, and how real-time editing is added later. These are four separate problems with
four separate milestones:

| Problem | Question it answers | Phase |
| --- | --- | --- |
| Autosave | Is my last keystroke safe if the app dies now? | 1 |
| Cloud sync | Does the server, and my other device, have it? | 2 (online), 3 (offline) |
| Conflict resolution | Two of us changed the same thing; what is the result? | 2 and 3 |
| Real-time collaboration | Do I see your edit, and your cursor, as you type? | 6 |

No part of this design promises conflict-free offline sync. Each conflict has a stated rule
below, and some rules lose an edit. Those are named.

## The local store

One TypeScript interface, `LocalStore`, at domain level. The browser implements it on IndexedDB;
the desktop on SQLite (rusqlite, bundled) behind typed Tauri commands. The sync engine is
TypeScript and talks only to this interface.

```ts
interface LocalStore {
  // Documents
  loadDoc(pageId: Id): Promise<{ snapshot: Uint8Array | null; snapshotCovers: number; updates: StoredUpdate[] }>;
  appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]>;   // local sequences
  compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void>;
  quarantineUpdates(pageId: Id, localSeqs: number[], reason: string): Promise<void>;
  docLogLength(pageId: Id): Promise<number>;

  // Local page history
  addHistory(pageId: Id, snapshot: Uint8Array, keep: number): Promise<HistoryEntry>;
  listHistory(pageId: Id): Promise<HistoryEntry[]>;
  getHistory(entryId: Id): Promise<Uint8Array | null>;

  // Metadata mirror and outbox, in one transaction per call
  applyLocalOps(ops: Operation[]): Promise<void>;     // plans, changes the mirror, adds to the outbox
  nextOutboxBatch(limit: number): Promise<Operation[]>;
  settleOps(results: OpResult[]): Promise<void>;
  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot>;
  getPage(pageId: Id): Promise<PageRecord | null>;

  // Sync (store schema 2, Phase 2)
  nextOutboxBatch(limit: number, workspaceId?: Id): Promise<Operation[]>;
  settleOps(results: OpResult[]): Promise<void>;          // answers' entities enter the mirror
  applyRemote(batch: RemoteBatch): Promise<void>;         // feed or tree: upserts, deletes, cursor
  syncCursor(workspaceId: Id): Promise<number | null>;
  beginUpload(workspaceId: Id, accountId: Id, ops: Operation[], replaced?: Id[]): Promise<void>;
  unsentDocUpdates(limit: number): Promise<UnsentDoc[]>;
  ackDocUpdates(pageId: Id, acks: DocAck[]): Promise<void>;
  applyRemoteDocUpdates(pageId: Id, pull: RemoteDocPull): Promise<StoredUpdate[]>;
  docCursor(pageId: Id): Promise<DocCursor | null>;
  docCursors(workspaceId: Id): Promise<Record<Id, DocCursor>>;
  replaceDoc(pageId: Id, update: LocalUpdate, upTo?: number): Promise<void>;
  pendingAssets(limit: number): Promise<AssetRecord[]>;
  markAssetUploaded(assetId: Id): Promise<void>;

  // Search: the caller normalises text (D25); the store indexes and matches word prefixes
  putSearchEntry(entry: SearchEntry): Promise<void>;
  deleteSearchEntries(pageIds: Id[]): Promise<void>;
  search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]>;

  // Assets and preferences kept on this device
  putAsset(asset: AssetRecord, bytes: Uint8Array): Promise<void>;
  getAssetBytes(assetId: Id): Promise<Uint8Array | null>;
  getPref<T>(key: string): Promise<T | undefined>;
  setPref(key: string, value: unknown): Promise<void>;

  // Offline (store schema 3, Phase 3)
  pin(pin: PinRecord): Promise<void>;                     // a page, or a page and its subtree
  unpin(pageId: Id): Promise<void>;
  pins(workspaceId: Id): Promise<PinRecord[]>;
  heldPages(workspaceId: Id): Promise<Id[]>;              // documents this device holds
  storageUsage(workspaceId: Id): Promise<StorageUsage>;
  setAsideDoc(pageId: Id, reason: string): Promise<QuarantineEntry | null>;
  quarantine(workspaceId: Id | null): Promise<QuarantineEntry[]>;
  settleQuarantine(id: Id, status: 'recovered' | 'dismissed', recoveredPageId?: Id | null): Promise<void>;
  repairState(pageId: Id): Promise<RepairState | null>;
  setRepairState(state: RepairState): Promise<void>;

  // Databases (store schema 4, Phase 4); database and view records come with readMirror
  readRows(databaseId: Id): Promise<RowRecord[]>;         // rows this device holds, trashed and templates too
  trashedRows(workspaceId: Id): Promise<RowRecord[]>;     // rows that are their own trash root
  dbHold(databaseId: Id): Promise<DbHold | null>;
  dbHolds(workspaceId: Id): Promise<DbHold[]>;
  holdDatabase(hold: DbHold): Promise<void>;              // full or partial; the engine fetches

  // Housekeeping
  purgeTrash(workspaceId: Id, before: string): Promise<Id[]>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}
```

As built in Phase 1 and extended in Phases 2 to 4 (`packages/workspace/src/types.ts`, store
schema 4).
Both stores run the same operation planner (`planOps`), which holds the tree rules: IndexedDB
inside its own transaction, the desktop against its in-memory mirror before it sends the plan to
SQLite as one transaction. What the server says is planned by shared code too (`remote.ts`):
`planSettle` for the answers to pushed operations, `planRemote` for a page of the change feed or
a tree. In both, an entity with operations still in the outbox keeps its local state until the
server has answered them; deletes always apply. A compaction in a synced workspace keeps the
updates the server does not hold yet, so they are still pushed.

Rules for both implementations, checked by one conformance suite run against each (51 cases on
memory, IndexedDB and SQLite in Phase 3; 73 in Phase 4):

- Every method is one atomic transaction.
- **Nothing unsent is dropped by the server's word.** When what the server says (`applyRemote`,
  `settleOps`, a lost workspace) removes a page of a synced workspace whose log holds an unsent
  update, the page's log (snapshot, then every update) is set aside first, in the same
  transaction, as a pending quarantine entry with reason `page.removed`; the shell turns it into
  a recovered page. A person's own permanent delete and the trash purge drop as before.
  `setAsideDoc` is the same step on the engine's word: it copies the log and takes the unsent
  updates out of it, and does nothing when nothing is unsent.
- Removing a page also removes its pin and repair state; quarantine entries outlive their page.
- Removing a database page removes its database record, views, hold and rows, each row as a removed
  page (Phase 4). Rows count as pages for documents. A row upsert from the server is written only
  for a database this device holds; database and view records always, as pages are.
- `applyLocalOp` changes the mirror and adds to the outbox together, or does neither.
- Bytes cross the Tauri boundary as raw binary, never base64 in JSON.
- The store never runs SQL or a query given by the webview.
- The browser asks for persistent storage (`navigator.storage.persist()`) and tells the user if
  the browser refuses.

### Local schema migration

- The store records its own schema version. On start the app compares it with the version it was
  built for.
- Older store: migrations run in order, inside a transaction, after a copy of the store is made
  (desktop: the SQLite file; browser: not possible, so migrations there must be additive). As
  built: SQLite checkpoints its WAL, copies the file to `workspace.v{n}.db` (synced, then renamed
  into place), then runs every step from version n to 4 in one transaction; a migration that
  fails leaves the file as it was, and the next start tries again. IndexedDB's upgrade
  transaction only adds object stores and indexes. Both are tested from stores of every earlier
  version (for SQLite, files written by the released v0.1.0, v0.2.0 and v0.3.0 code), and the
  SQLite migration is killed at every moment from each (`scripts/kill-migration.mjs`).
- **Newer store than the app** (the user installed an older build): the app refuses to open the
  store and asks the user to update. It never wipes, because the outbox may hold unsynced work.

## Autosave

Autosave is local and needs no network.

1. The editor changes the page's `Y.Doc`. Yjs emits an update.
2. The document layer batches updates for at most 500 ms, merges the batch into one update, and
   calls `appendDocUpdates`.
3. The save indicator shows "Saved" when the write returns. Budget: durable within 1 s of the
   last keystroke.
4. On close, on `visibilitychange` to hidden, and on the desktop window's close request, any
   pending batch is flushed first.
5. When a page has more than 200 stored updates, the document layer writes a compacted state with
   `compactDoc`.

Crash recovery: on start, `loadDoc` returns the snapshot and every update after it. Applying them
rebuilds the document exactly. There is no separate recovery file and no "recover?" prompt: the
log is the document. An update that fails to decode is skipped, kept in a `corrupt` area for
support, and reported; the rest still load.

Assets: a pasted or dropped image is written to the local store first and shown from there. In
local-only mode that is the end. With an account, the upload is queued.

## Cloud sync

Two channels, because the two models differ.

### Channel 1: documents

Each page has, on the server: an epoch, a schema version, and a gap-free sequence of updates.

**Push**

```
POST /api/v1/pages/{pageId}/doc/updates
{
  "epoch": 3,
  "clientSchemaVersion": 4,
  "updates": [ { "updateId": "0193…", "data": "<base64 Yjs update>" } ]
}

200 { "acks": [ { "updateId": "0193…", "seq": 1042 } ], "headSeq": 1040 }
```

`headSeq` is the page's validated head (below): the pushed updates have their numbers, but are
served to other clients only once the worker has passed them.

The server, in one transaction per request:

1. Checks the caller may edit the page (403 otherwise; 410 if the page is permanently deleted).
2. Checks `epoch` equals the page's (409 `doc.epochMismatch` otherwise).
3. Checks `clientSchemaVersion` is at least the page's (426 `client.tooOld` otherwise).
4. Checks size and rate limits (413, 429).
5. Drops any update whose `updateId` it has already stored, answering with the sequence it gave
   the first time.
6. Takes the page's sequence lock, assigns the next sequence numbers, inserts the rows, and moves
   the page's head sequence. (As built in Phase 3 the lock is an application lock named for the
   page, `docseq:{pageId}`, held to the commit, rather than the page row: every writer of the
   sequence takes it, so numbers stay gap-free and commit in order, and the row is free for the
   worker. The database reads with `READ_COMMITTED_SNAPSHOT`, so readers never wait on writers.)

The server does not decode updates on this path. The rows are stored as pending; the worker
validates them in sequence order (see "What the server checks") and moves the page's validated
head past them, so they are served to other clients only once they have passed (Q20): spike S7
showed that one update with a node type the schema lacks stops every client's binding from
syncing that page. The worker polls for pending rows every 100 ms, and while it finds some its
passes run back to back. Who may edit is remembered per workspace between passes and read again
only when an access, member or workspace change has committed since (every change to who may
edit writes one: the same rule the check under the lock rests on).

**Pull**

```
GET /api/v1/pages/{pageId}/doc?after=1040

200 {
  "epoch": 3,
  "schemaVersion": 4,
  "headSeq": 1042,                          // every update up to here is decided
  "cursor": 1042,                           // the next "after"
  "more": false,                            // at most 1,000 updates an answer
  "snapshot": null,                         // or { "upToSeq": 1000, "url": "<SAS, 5 min>" }
  "updates": [ { "seq": 1041, "updateId": "0193…", "data": "…" }, … ],
  "rejected": [ "0193…" ]                   // the caller's own updates the worker refused
}
```

- `after` is the highest sequence the client has applied. With `after=0`, or when the rows after
  `after` have been compacted away, the answer includes a snapshot and the updates after it.
- Only valid updates up to the validated head are served; a refused one is never served, and its
  pusher finds it in `rejected` and keeps it aside (the store's corrupt area).
- A device that pushed an update recognises it in a pull by its `updateId` and only records its
  sequence.
- A client applies updates in any order and any number of times; Yjs makes that safe.
- A client whose epoch differs from the answer's follows "Epoch change" below.
- Workspace-wide: the change feed (channel 2) says which pages have a new head sequence, so a
  client pulls only pages it holds and that changed.

**Repair.** If a client suspects it is missing something (a checksum of the state vector differs
from the one the worker publishes with each snapshot), it sends its full state and pulls from
`after=0`. This is the only use of state vectors.

As built in Phase 3: the worker stores a state hash with the page whenever it moves the validated
head (and after a hard restore), and the API serves it without decoding anything:

```
GET  /api/v1/pages/{pageId}/doc/state-hash   200 { "epoch": 3, "upToSeq": 1042, "hash": "…" | null }
POST /api/v1/pages/{pageId}/doc/repair        { "epoch": 3, "clientSchemaVersion": 2, "update": { "updateId", "data" } | null }
                                              200 { "ack": { "updateId", "seq" } | null, "pull": <GET /doc?after=0> }
```

- The hash is the same in TypeScript and Rust (shared vectors made by Yjs,
  `packages/doc/vectors/state-hash-vectors.json`): SHA-256, in lower-case hex, of
  `v1;sv=<client>:<clock>,…;ds=<client>:<start>-<end>,…`, the state vector sorted by client
  (clocks of 0 left out) and the delete set sorted by client and start, touching ranges merged,
  ends exclusive. The delete set is in it because an update that only deletes moves no clock.
- A client checks a page when it opens it (once a session), after a pinned page is refreshed with
  others' edits, and when the document layer finds updates still pending after its retry; only
  when the page has nothing unsent and its cursor equals the server's `{ epoch, upToSeq }`. A
  mismatch sends the whole local state as one update (a reader sends none) and applies the pull
  from the start. At most one repair per page, epoch and head; if the hashes still differ the user
  is told (`doc.repairFailed`) and it is not retried until a check matches. Equal hashes, or a
  repair that worked (`doc.repaired`), are recorded in the store's `repairs`.
- The worker judges every pushed update by what it adds to the page's state (a diff against its
  state vector) before checking whose Yjs client ids it writes as, so a repair re-sending other
  people's structs is not taken for a forgery, and one adding structs under someone else's id
  still is.

Payloads are JSON with base64 in Phase 2. A binary framing is an optimisation for Phase 6, when
update frequency rises.

### Channel 2: metadata

Everything relational (sections, pages' metadata, favourites, and later database schemas, views
and rows) syncs as operations.

**An operation**

```ts
interface Operation {
  opId: Id;                 // UUIDv7, the idempotency key
  type: 'page.create' | 'page.update' | 'page.move' | 'page.trash' | 'page.restore'
      | 'page.delete' | 'section.create' | 'section.update' | 'section.delete'
      | 'favourite.set' | /* Phase 4 */ 'db.update' | 'view.upsert' | 'view.delete' | 'row.update';
  entityId: Id;
  baseVersion: number | null;   // the entity's version this was based on; null for create
  payload: unknown;             // typed per operation
  createdAt: string;            // for display only; never used to order
}
```

**Push**

```
POST /api/v1/workspaces/{workspaceId}/ops
{ "deviceId": "…", "ops": [ … up to 100, in order … ] }

200 { "results": [ { "opId": "…", "status": "applied" | "rejected", "entity": { … }, "error": { "code": "…" } } ] }
```

For each operation, in order, each in its own transaction:

1. If `opId` is in `AppliedOps`, answer with the stored result.
2. Check permission.
3. Check the rules for that type (below).
4. Apply, raise the entity's version, append to `WorkspaceChanges`, and store the result in
   `AppliedOps`, all in the same transaction.

A rejected operation does not stop the batch, except that operations depending on a rejected
create are rejected too.

The client removes an operation from its outbox only when it has a result for it. A lost answer
means the same batch is sent again; step 1 makes that safe.

**Pull**

```
GET /api/v1/workspaces/{workspaceId}/changes?after={cursor}&limit=500

200 { "changes": [ { "seq": 9001, "entityType": "page", "entityId": "…", "kind": "upsert", "entity": { … } } ], "cursor": 9001, "more": false }
```

- The answer never includes a change above the lowest sequence still being written by an open
  transaction, so a slow transaction cannot be skipped. The workspace sequence is assigned under
  a lock on the workspace row for the same reason.
- Each change carries the entity as the caller may see it now.
- **Access changes are events.** When a caller gains access to a subtree, the feed carries a
  `grant` naming its root, and the client fetches that subtree. When they lose access, a `revoke`
  names the root and the client removes it locally (after quarantining unsent edits; see
  conflicts). A plain version cursor cannot express either.
- A client whose cursor is older than the feed's retention (90 days) does a full resync of the
  mirror. Its outbox is kept and replayed. As built: the worker deletes changes older than 90 days
  and records the highest sequence it removed (`Workspaces.ChangesPrunedSeq`); a pull with an
  older `after` gets `410 feed.expired`, and the client takes the whole tree with its cursor.

### The sync loop

The same engine in the browser and on the desktop (`packages/workspace/src/sync/engine.ts`, over
the `LocalStore` and a `SyncApi`; `sync/http.ts` is the API over @cgw/api). It runs every 1.5
seconds while signed in, and soon after any local change, when the network returns and when the
window gains focus; the workspaces the account gained or lost elsewhere are checked every tenth
pass.

1. On start, on regaining the network, on a timer while online, and after any local change:
2. Push the outbox, oldest first.
3. Push unsent document updates, page by page; a page whose `page.create` still waits in the
   outbox (made since step 2) waits for the next pass, since the server does not hold it yet.
4. Pull the change feed until `more` is false.
5. Pull documents for held pages whose head sequence moved.
6. Upload queued assets (each with its own retry state).

The status says "syncing" from the moment a local change waits (not only once a pass starts), and
"synced" only when a pass ends with nothing waiting.

Failures back off exponentially with jitter, capped at 5 minutes. A 401 pauses the loop until the
user signs in again; nothing is discarded. A refused move, trash, restore or delete fetches that
subtree again from the server (a scoped resync), so its pages show the server's state.

**As built in Phase 3** (`engine.ts`; the convergence simulator found the two tree rules last in
this list):

- One pass, per synced workspace: upload assets (Phase 4: first, since the server takes a cover or
  a row's file only once it holds the bytes, and refused the operation that named one sent before
  them); push the outbox; push unsent document updates in batches; pull the feed to its end;
  reconcile the tree if a subtree operation was answered; pull held pages whose head or epoch
  moved, and a bounded number of pinned pages not held yet; up to four state-hash checks. Passes
  come every 1.5 s, 100 ms after a pass that left work, 50 ms when a change came during one.
- **Backoff** after a failure: `min(5 min, 1 s × 2^(n−1)) × (0.5 + random)`, never shorter than the
  server's `Retry-After` (sent on every 429 and 503), even when the network returning or the
  window's focus kicks a pass. A local change does not cut a backoff short.
- **Sleep:** timers are chains of at most 15 s; one that fires more than 90 s late means the
  machine slept or the clock jumped, and a pass runs at once with the backoff reset.
- **Signed in while offline:** the account (id, email, name, device id; no credential) is kept in
  the store's prefs. With no network at start the app uses it, says "Offline, N changes waiting",
  and syncs when the server answers. A 401 pauses with the count still shown ("Sign in to sync N
  changes"); a sign-out forgets the account, not the data.
- **Long outboxes:** document pushes go in batches of at most 200 updates and 4 MB (an update over
  1 MB alone, which the server refuses with 413 and only it is set aside); each batch's answers
  are stored before the next request, so a failure loses nothing answered and nothing restarts
  from zero. 1,000 updates across 50 pages go in 56 requests.
- **Feed past retention:** `410 feed.expired` takes the whole tree with its cursor (`replace:
  { root: null }`; records with operations waiting keep their local state) and the outbox is
  replayed as usual.
- **Scoped resync, widened:** when the server's subtree leaves out a page this device holds under
  the root (moved away on the server, the device not told yet), the engine takes the whole tree
  instead, so a page that still exists is never removed with its edits set aside.
- **Reconcile after subtree operations:** the local planner applies a trash or move to the
  subtree as this device saw it, the server to the subtree as it is. After any answered subtree
  operation the engine looks for a tree the server never holds (a trashed page without its trash
  root above it, a live page under a trashed parent, a page in another section than its parent)
  and takes the whole tree if it finds one.

Before a page's updates are pushed, the Yjs client ids they write as are registered to the user
(Q9): a session writes as an id from the pool the server issued to the device, so registering is
needed only for ids used before the device synced (a local workspace's history) or when the pool
ran out. An id another user holds in the workspace is refused, and the updates written with it
are kept aside.

**Uploading a local workspace** (Phase 2): the workspace is made on the server with its own id;
each page's log (snapshot and updates) is merged into one update, its client ids registered; the
outbox is replaced by the workspace's records as creates, parents first, then trash roots
(deepest first) and favourites; the loop then sends the rest, assets included. An interrupted
upload resumes from the outbox. Nothing written while the upload is prepared is lost: only the
operations it read before it read the workspace give way to its creates (later ones follow them),
and only the updates it merged give way to the merged one (later ones stay after it; a local
compaction in between makes it stop and start again).

**Databases** (Phase 4): database, view and row records are metadata on this channel; their rules
are in `DATA_MODEL.md` (Databases).

- **Operations**: `page.create` of kind `database` (with its first properties) or `row` (its
  database as parent, with its first values), `db.update` (property defs merged per property, with
  `order`), `view.upsert`, `view.delete`, `row.update` (values merged per property, null clears),
  and the page operations on rows (title, icon, cover, reorder among the database's rows, trash,
  restore, delete). No `baseVersion` on the database ones: the last to reach the server wins, per
  property. The answers carry `entityType` `database`, `view` or `row` (a database's create carries
  its page and its record).
- **Tree and feed**: the tree holds every database and view record the account may see and never a
  row. The feed carries `database`, `view` and `row` changes; every change to a row (its values, its
  page, its document's head) is a `row` change, never a `page` one, and a row made or removed also
  writes a `database` change (its `rowCount`). A `database` delete is carried by its page's delete,
  which removes everything it holds. Clients from before Phase 4 ignore entity types they do not
  know, so they never see rows; a page holding a database view is document schema 3, which they
  open read-only.
- **Holds**: a device keeps a database's rows only once it holds it: a view showing it, a pin over
  it, or its making on the device. A database of at most 5,000 rows is held `full`: every row is
  fetched (`GET /databases/{id}/rows?after=&limit=`, by row id, 1,000 a request, at most 4 requests a
  pass and the next pass 100 ms later while some remain; each page and the hold's place written in
  one transaction), the feed keeps them fresh, and its views are queried on the device. A larger one
  is held `partial`: its views ask the server (`POST /databases/{id}/query`, keyset paged), whose
  rows are kept as a cache; offline it shows the rows on the device, and says so. A hold moves
  between full and partial as `rowCount` crosses the limit. An `access` event marks the holds under
  its root incomplete, and a feed past its retention marks all, so they are fetched again; a fetched
  page also removes held rows the server no longer has.
- **Rows' documents** are pages' documents: pushed, pulled when their head moves, set aside on 410,
  as any page's. Pins hold the databases under them, not every row's document.
- **Refusals**: a refused database, view or row operation takes the server's entity, as a page's
  does. What the local planner changed beyond that entity (reverse relation values, rows converted by
  a type change, a reverse property added to another database) is taken back by fetching what it
  reached again. A record the feed brings while an operation on its id waits whose answer carries
  something else (a page operation on a database's page, a visit, a favourite) is kept and taken
  once nothing waits on it. The convergence simulator found both.

**Access changes from moves** (Phase 2): the server writes an `access` change when a page with
pages under it moves, when a move or a fallback (a restore or create whose parent has gone) makes
a page `Restricted` to keep its access, and when pages cross between a shared and a private
section. The client resyncs that subtree, as for a change to an access list, so it never keeps
pages it lost or misses pages it gained. The client's own planner does not know these rules: the
server refuses what they forbid (`access.denied`), and the refused operation's subtree is fetched
again.

### What the user sees

| State | Shown as |
| --- | --- |
| Saved locally, all sent | "Saved" |
| Saved locally, sending | "Syncing" |
| Offline, changes waiting | "Offline, N changes waiting" |
| A change was rejected | A notice on the page with what happened and where the copy is |
| Signed out with changes waiting | "Sign in to sync N changes" |
| Local-only workspace | "On this device only" |

### Offline availability (Phase 3)

- A page is available offline when the device holds its document. Opening a page caches it. A
  user can pin a page or a subtree; pinned pages are fetched in the background and kept fresh.
  As built: a pin is a page, or a page with every live page under it, pages added later included
  (no "whole workspace" pin). Each pass fetches at most 24 pinned pages not held, four at a time,
  and the next pass follows in 100 ms while some remain, so a 500-page subtree is held in about 21
  short passes and typing never waits on it. Held pages stay fresh as every held page does (their
  head moves in the feed). Unpinning keeps what is held. Settings shows the pins, what is still
  to fetch, and the storage this device uses.
- The metadata mirror covers the whole workspace, so the tree, breadcrumbs and title search work
  offline for every page, cached or not. An uncached page says so when opened offline.
- Pages can be created offline: ids are made on the client, so the page, its document and its
  place in the tree exist locally at once and sync later.
- A device may stay offline for 30 days (the refresh token's life). After that it must sign in
  before syncing; its local data is still there.

## Conflict resolution

### Inside a page (Yjs)

| Case | Result | Loses work? |
| --- | --- | --- |
| Two people type in the same block | Both insertions stand, interleaved by Yjs's rules | No |
| One edits a block, another deletes it | The block is deleted; the edit goes with it. Version history has it | Yes, by design |
| One edits a block while another moves it (or indents it) | A move is delete and insert in Yjs, so the edit is lost; the device that typed it is told, and pointed to the page's history (`doc.moveConflict`, `editLost`) | Yes. Named limit. Measured in spike S1 |
| One edits a block while another merges it into the block above | The merged block is deleted and its text copied, so the edit is lost | Yes. Named limit. Measured in S1 |
| One edits a block while another moves a different block | Both stand, with the id-aware binding (Q18); the stock binding can rebuild the untouched neighbour and lose the edit | No, with the patch |
| One types while another turns the block into another text kind | Both stand: the kind is an attribute | No |
| Two people move the same block | Two copies. The id plugin repairs the duplicate id; the content appears twice; both are told (`doc.moveConflict`, `movedTwice`) | Duplicates, visible to users |
| Two people split the same paragraph | Each split copies the tail into a new block, so the shared tail appears twice | Duplicates, visible to users (S1) |
| Two people merge the same block | Valid, because the schema uses `*` only | Can lose an edit made in the merged block |
| One formats, another types in the same range | Both stand | No |
| Undo | Each user's undo reverts only their own changes (Yjs `UndoManager`, scoped to local origin) | No |

The "yes" and "duplicates" rows are properties of Yjs, not bugs to fix later. They matter mostly
for long offline sessions. The mitigations are version history, and a move intent recorded by the
id plugin so a moved block is at least recognisable.

As built in Phase 3: a local move writes its intent into the document's `moves` map in the same
update (`DATA_MODEL.md`, The Yjs document). The notice rule is causal, not timed: a remote change
that deletes this device's own content (by its Yjs client id) without having seen it deleted a
block it did not know held that content; if the block lives on under its id, it was moved and the
edit went with the old copy (`editLost`). A block deleted or merged away is not a move and gets no
notice; nor does a body replaced by "turn into" code. Measured on S1-style runs (three devices,
offline spells, `packages/editor/src/conflicts.test.ts`): 151 of 155 typed words lost to a move
were told to the device that typed them, none of 181 lost to deletes; the losses came a median of
88 steps after the typing, so an "edited in the last few seconds" window would have missed most.
A move that arrives while the page is closed is replayed on open without the check, and gets no
notice. Every row of the table above is a scripted test with real editors. Under spike S1's harshest test (three clients,
long offline spells, a quarter of all edits structural) about a third of typed text that raced a
structural edit of the same block was lost this way; every loss was one of these rows.

**Pending updates.** Yjs 13.6.33 can keep updates pending after every update they need has
arrived, depending on the order they came in (S1; `bench/editor/fixtures/yjs-pending-order.json`).
After applying a batch, the document layer applies Yjs's pending update once more, which
integrates it. Only what is still pending after that is treated as missing, and goes to the
repair path above.

### Metadata

| Case | Rule |
| --- | --- |
| Two people rename a page | The last to reach the server wins. The other value is in the audit trail |
| Two people change different fields of one page | Both stand |
| A move, a trash, a permanent delete, a permission change | Carries `baseVersion`. If the entity changed since, it is rejected with `version.conflict` and the client shows the current state. These are never silently merged |
| A move that would make a cycle | Rejected with `tree.cycle`. The client puts the page back where the server has it |
| Two offline clients create pages under one parent | Both exist. Order is (order key, id). If two order keys are equal the server gives the later one a new key |
| A page is created under a parent that was deleted | The page is created at the top of its section, and the user is told |
| Database row: two edits to different properties | Both stand |
| Database row: two edits to the same property | The last to reach the server wins; the property's version rises |
| A property's type changed while another device edits it offline | The edit lands converted to the new type (every write is coerced); what cannot be converted is cleared |
| A property deleted while another device edits it | The edit is kept on the row, hidden; restoring the property shows it |
| A select option deleted while another device sets it | The value is kept and reads as empty (an `isEmpty` filter matches it) |
| Two people edit relations to the same rows | Each edit adds and removes its own ids on both sides, in the order the server receives them |
| A row made offline in a database trashed elsewhere | The row is made in the trash with its database; restoring the database brings it back |
| A view edited on two devices | The last to reach the server wins, whole view |

Client clocks are never compared. "Last" always means the order the server received them.

### Across the two models

| Case | Rule |
| --- | --- |
| A page was edited offline and trashed on the server | The document updates are accepted into the trashed page. Trash keeps pages for 60 days, longer than any device can stay offline, so the edits are there on restore. The user is told the page is in the trash |
| A page was edited offline and permanently deleted | Push returns 410. The client saves the local document as a new page named "Recovered: {title}" in the user's private section |
| A page was moved on the server | No conflict. Documents are keyed by page id |
| Permission to edit was removed while offline | Push returns 403. The client quarantines the unsent edits as a private recovered page, tells the user, and drops its copy of the original if read access is gone too. A device that never reconnects keeps what it had; that cannot be prevented, only bounded by the 30-day token |
| A version was restored while a client was offline | See "Epoch change" |
| The app is older than the document's schema | The page opens read-only from the server's derived JSON; nothing is pushed. The user is asked to update |
| The app is older than the local store | The app refuses to open the store and asks the user to update |

### Epoch change

The epoch rises when the server replaces a document's history rather than adding to it: a hard
restore, a schema migration that cannot be a forward edit, or a corruption repair. As built in
Phase 3: the page's log is set aside (`setAsideDoc`, reason `doc.epochMismatch`) when it holds
unsent edits, the log is replaced by an empty update marked sent, the page is pulled from the
start of the new epoch, and the set-aside log becomes a recovered page (below). The same happens
when a pull, not a push, is the first to see the new epoch.

- A push with the old epoch gets 409 `doc.epochMismatch`.
- The client quarantines its unsent updates as a recovered page (the old state plus its edits),
  discards its copy of the document, and pulls the new epoch from `after=0`.
- The user is told, with a link to the recovered page.

**Recovered pages** (as built in Phase 3). A pending quarantine entry, whatever set it aside (an
epoch change, a 403 or 410 on a push, a page removed by the server's word with unsent edits),
becomes a page "Recovered: {title}" at the top of the account's private section of its workspace
(or of the open workspace's if that one is gone): the entry's parts are merged into a fresh
document, read as ProseMirror JSON, and written as the first update of the new page, block ids
kept, so the content is recognisable beside the original. The entry is then marked recovered with
the new page's id; the engine asks again after every pass while entries are pending, and making
one is idempotent. A "Recovered" list beside the trash shows every entry with its reason, time,
original title and a link; entries can be dismissed.

| Set aside because | Reason | The device then |
| --- | --- | --- |
| The epoch changed (push 409, or a pull in a new epoch) | `doc.epochMismatch` | Resets the page's log and pulls the new epoch |
| Edit access went (push 403) | `access.denied` | Resets the page and pulls it again; if read access went too (404), the feed's revoke removes it |
| The page was deleted for good (push 410) | `page.gone` | The feed's delete removes the page |
| The server's word removed a page with unsent edits | `page.removed` | Nothing more: the store set it aside in the same transaction |

An ordinary "restore this version" does not bump the epoch; it is a forward edit (below).

## Version history and restore

- **Compaction snapshots** exist to keep loading fast. The worker writes one after 200 updates or
  10 minutes of edits. Order of work, so a crash at any point is safe: write the new blob; then in
  one transaction point the page at it and delete the update rows it covers; later, delete the old
  compaction blob. One compactor per page, under an application lock.
- **History snapshots** are kept for users: one per hour of activity for 30 days, one per day
  after that, and every named version for ever. They are full states, so garbage collection can
  stay on.
- **Viewing** a version loads its snapshot into a separate read-only document.
- **Restore** computes the difference between the live document and the chosen version and
  applies it to the live document as one transaction by the restoring user. It is undoable, it
  syncs like any edit, and a snapshot of the state before the restore is kept. An offline client
  with edits against the pre-restore state still merges: its edits inside content the restore
  removed are gone, the rest stand. The restore dialog says this.
- **Hard restore** (admin, for a corrupt document) replaces the state and bumps the epoch. As
  built: `POST /pages/{id}/versions/{vid}/restore` with `{ "mode": "hard" }` (owners and admins;
  202 with a command the worker carries out, 409 while the version is not ready or another restore
  of the page waits). The worker first keeps the live state as a `preRestore` version, so the
  hard restore can be undone like any restore; then, under the page's lock, it writes the chosen
  state as the new epoch's snapshot, and sequence numbers keep rising across the epochs. The copy
  of the epoch inside the document (`meta.epoch`) is not rewritten (the worker has no Yjs write
  call): clients take the epoch from the page and the pull answer, never from the document. A
  compaction of the old epoch checks the epoch under its lock, so it cannot remove the new
  snapshot.
- **As built in Phase 2:** the worker writes a history snapshot after an hour of activity on a
  page, keeps one a day after 30 days, keeps every named and `preRestore` version, and writes a
  version someone names within a second, as the page was when it was named: the app sends the
  page's last edits first, the server records the last sequence given out, and the worker writes
  the state up to it once every update before it is decided (`GET /pages/{id}/versions/{vid}` gives its signed URL
  once it is ready).

Deleted text does not live for ever: once a compaction snapshot covers an update row, the row is
deleted, and the snapshot is written with garbage collection on. History snapshots age out as
above. Permanent deletion of a page removes its rows and blobs.

## What the server checks

A CRDT cannot un-apply an operation, so the server refuses what it can and keeps history for the
rest.

| Check | Where | On failure |
| --- | --- | --- |
| The caller may edit this page | Web process, every push | 403 |
| Epoch and client schema version | Web process | 409, 426 |
| Size of one update (1 MB), of one request (4 MB), and updates per minute per user and per page | Web process | 413, 429 (with `Retry-After`, as every 429 and 503 has) |
| The update decodes as a Yjs update | Worker, before it is served (Q20) | Refused: never served; the pusher's next pull lists it, and its device keeps it aside |
| Every struct the update adds to the page's state belongs to a Yjs client id registered to the pushing user (structs the server already holds, as in a repair, are not judged) | Worker, before it is served | Refused, and an audit entry (`doc.forgedClient`) |
| The resulting document fits the schema: only the schema version's elements, block ids of 12 base-62 characters, attributes that are plain values, link schemes from the allow-list; `meta.pageId` stays the page's and `meta.schemaVersion` no higher than the page's | Worker, before it is served | Refused. Attributes the schema does not know are not judged: clients keep them (Q18) and draw them inert (S7) |
| Document size (10 MB of state) | Worker, before it is served | The update that would pass it is refused |

What the server cannot check is intent. "Delete everything" is a valid update. The remedies are
version history and, for a document bloated on purpose with tiny structs, a hard restore.

Every client treats document content as hostile regardless: it renders only through the schema,
which whitelists node types and attributes; link schemes are checked when parsed, when drawn and
when clicked; embeds load in sandboxed iframes from an allow-list.

## Real-time collaboration (Phase 6)

Real-time uses the same updates and the same sequence. Nothing in the document model changes.

- **Hub.** One SignalR hub. A client joins a group per open page after the same permission check
  as a pull.
- **Sending.** A client sends an update to the hub. The hub does exactly what the push endpoint
  does (same transaction, same sequence), then relays `{seq, data}` to the group. The hub holds no
  document state, so an app-pool recycle loses nothing: clients reconnect and pull from their last
  sequence.
- **Receiving.** A client applies relayed updates. If it sees a gap in the sequence, it pulls the
  missing range over HTTP.
- **Presence.** Cursor, selection, name and colour travel as Yjs awareness messages through the
  hub. They are relayed and never stored. A client that goes quiet for 30 seconds is dropped from
  the list.
- **Metadata.** The hub also tells members of a workspace that the change feed has moved, so
  sidebars update without polling.
- **Fallback.** With the socket down, the client is exactly a Phase 3 client: it pushes and pulls
  over HTTP.
- **Permission changes** take effect on the next message: the hub re-checks access at most every
  60 seconds per connection and on every `revoke` event.

Comments and mentions are relational records (see `DATA_MODEL.md`) and travel on the metadata
channel; they are not part of the Yjs document.

Scaling past one server node needs Azure SignalR Service or a backplane (Q17). The design does
not depend on which.

## Tests that guard this design

| Test | Proves |
| --- | --- |
| `LocalStore` conformance suite, run on IndexedDB and SQLite | Both stores behave the same |
| Kill the app at random points during typing, 1,000 runs | Reopened document equals the keystrokes whose save returned |
| Two and three simulated clients, random operations, random network order, loss and duplication | All clients converge to the same document and the same tree, and from Phase 4 the same database records, views and rows (values and per-property versions) |
| Filter, sort, group, formula, rollup, conversion and CSV vectors, run in TypeScript and C# | The device and the server give the same rows and values |
| Block-id fuzz: 10,000 operations including moves, splits, pastes, offline merges | No duplicate ids after quiescence; ids stable across moves |
| 50 concurrent writers on one page | No client misses an update with repair disabled |
| Every row of the conflict tables, scripted | The stated rule, including the notice the user sees |
| Old client build against a newer document | Opens read-only; the server document is byte-identical afterwards |
| Hostile update corpus | Rejected or rendered inert; no script runs in the browser or in Tauri |
| Outbox replay after a lost response | No duplicate entity, no lost operation |
| Access granted and revoked while a client is offline | No stale or missing record after reconnect |
| Compaction killed at each step | The page loads and no update is lost |
