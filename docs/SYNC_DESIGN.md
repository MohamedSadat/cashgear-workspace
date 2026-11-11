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
  appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<void>;
  loadDoc(pageId: Id): Promise<{ snapshot: Uint8Array | null; updates: StoredUpdate[] }>;
  ackDocUpdates(pageId: Id, acks: { updateId: Id; seq: number }[]): Promise<void>;
  applyRemoteDocUpdates(pageId: Id, epoch: number, updates: RemoteUpdate[], headSeq: number): Promise<void>;
  compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void>;
  unsentDocUpdates(limit: number): Promise<{ pageId: Id; updates: StoredUpdate[] }[]>;

  // Metadata mirror and outbox, in one transaction per call
  applyLocalOp(op: Operation): Promise<void>;          // changes the mirror and adds to the outbox
  nextOutboxBatch(limit: number): Promise<Operation[]>;
  settleOps(results: OpResult[]): Promise<void>;       // removes from the outbox, fixes the mirror
  applyChanges(workspaceId: Id, changes: Change[], cursor: number): Promise<void>;

  // Reads for the UI
  listChildren(parent: TreeParent): Promise<PageSummary[]>;
  getPage(pageId: Id): Promise<PageRecord | null>;
  search(workspaceId: Id, query: string, limit: number): Promise<SearchHit[]>;

  // Assets
  putAsset(asset: AssetRecord, bytes: Blob | null): Promise<void>;
  getAssetBytes(assetId: Id): Promise<Blob | null>;

  // Housekeeping
  schemaVersion(): Promise<number>;
  quarantine(pageId: Id, reason: string): Promise<Id>;  // keeps a recoverable copy
}
```

Rules for both implementations, checked by one conformance suite run against each:

- Every method is one atomic transaction.
- `applyLocalOp` changes the mirror and adds to the outbox together, or does neither.
- Bytes cross the Tauri boundary as raw binary, never base64 in JSON.
- The store never runs SQL or a query given by the webview.
- The browser asks for persistent storage (`navigator.storage.persist()`) and tells the user if
  the browser refuses.

### Local schema migration

- The store records its own schema version. On start the app compares it with the version it was
  built for.
- Older store: migrations run in order, inside a transaction, after a copy of the store is made
  (desktop: the SQLite file; browser: not possible, so migrations there must be additive).
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

200 { "acks": [ { "updateId": "0193…", "seq": 1042 } ], "headSeq": 1042 }
```

The server, in one transaction per request:

1. Checks the caller may edit the page (403 otherwise; 410 if the page is permanently deleted).
2. Checks `epoch` equals the page's (409 `doc.epochMismatch` otherwise).
3. Checks `clientSchemaVersion` is at least the page's (426 `client.tooOld` otherwise).
4. Checks size and rate limits (413, 429).
5. Drops any update whose `updateId` it has already stored, answering with the sequence it gave
   the first time.
6. Locks the page row, assigns the next sequence numbers, inserts the rows, and moves the page's
   head sequence.

The server does not decode updates on this path. The worker validates them (see "What the server
checks") before they are served to other clients (Q20): spike S7 showed that one update with a
node type the schema lacks stops every client's binding from syncing that page.

**Pull**

```
GET /api/v1/pages/{pageId}/doc?after=1040

200 {
  "epoch": 3,
  "schemaVersion": 4,
  "headSeq": 1042,
  "snapshot": null,                         // or { "upToSeq": 1000, "url": "<SAS, 5 min>" }
  "updates": [ { "seq": 1041, "data": "…" }, { "seq": 1042, "data": "…" } ]
}
```

- `after` is the highest sequence the client has applied. With `after=0`, or when the rows after
  `after` have been compacted away, the answer includes a snapshot and the updates after it.
- A client applies updates in any order and any number of times; Yjs makes that safe.
- A client whose epoch differs from the answer's follows "Epoch change" below.
- Workspace-wide: the change feed (channel 2) says which pages have a new head sequence, so a
  client pulls only pages it holds and that changed.

**Repair.** If a client suspects it is missing something (a checksum of the state vector differs
from the one the worker publishes with each snapshot), it sends its full state and pulls from
`after=0`. This is the only use of state vectors.

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
  mirror. Its outbox is kept and replayed.

### The sync loop

The same engine in the browser and on the desktop:

1. On start, on regaining the network, on a timer while online, and after any local change:
2. Push the outbox, oldest first.
3. Push unsent document updates, page by page.
4. Pull the change feed until `more` is false.
5. Pull documents for held pages whose head sequence moved.
6. Upload queued assets (each with its own retry state).

Failures back off exponentially with jitter, capped at 5 minutes. A 401 pauses the loop until the
user signs in again; nothing is discarded.

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
| One edits a block while another moves it (or indents it) | A move is delete and insert in Yjs, so the edit is lost | Yes. Named limit. Measured in spike S1 |
| One edits a block while another merges it into the block above | The merged block is deleted and its text copied, so the edit is lost | Yes. Named limit. Measured in S1 |
| One edits a block while another moves a different block | Both stand, with the id-aware binding (Q18); the stock binding can rebuild the untouched neighbour and lose the edit | No, with the patch |
| One types while another turns the block into another text kind | Both stand: the kind is an attribute | No |
| Two people move the same block | Two copies. The id plugin repairs the duplicate id; the content appears twice | Duplicates, visible to users |
| Two people split the same paragraph | Each split copies the tail into a new block, so the shared tail appears twice | Duplicates, visible to users (S1) |
| Two people merge the same block | Valid, because the schema uses `*` only | Can lose an edit made in the merged block |
| One formats, another types in the same range | Both stand | No |
| Undo | Each user's undo reverts only their own changes (Yjs `UndoManager`, scoped to local origin) | No |

The "yes" and "duplicates" rows are properties of Yjs, not bugs to fix later. They matter mostly
for long offline sessions. The mitigations are version history, and a move intent recorded by the
id plugin so a moved block is at least recognisable. Under spike S1's harshest test (three clients,
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
restore, a schema migration that cannot be a forward edit, or a corruption repair.

- A push with the old epoch gets 409 `doc.epochMismatch`.
- The client quarantines its unsent updates as a recovered page (the old state plus its edits),
  discards its copy of the document, and pulls the new epoch from `after=0`.
- The user is told, with a link to the recovered page.

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
- **Hard restore** (admin, for a corrupt document) replaces the state and bumps the epoch.

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
| Size of one update (1 MB), of one request (4 MB), and updates per minute per user and per page | Web process | 413, 429 |
| The update decodes as a Yjs update | Worker, within seconds | The update row is marked bad and removed from what pulls return; the page is flagged; the pusher's device is asked to resend from its full state |
| Every struct in the update belongs to a Yjs client id registered to the pushing user | Worker | Same as above, and an audit entry |
| The resulting document fits the schema (known nodes, known attributes, attribute types) | Worker | The page is flagged for review; clients still render only what the schema allows |
| Document size (10 MB of state) | Worker | The page is flagged; further pushes are refused until it is compacted or split |

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
| Two and three simulated clients, random operations, random network order, loss and duplication | All clients converge to the same document and the same tree |
| Block-id fuzz: 10,000 operations including moves, splits, pastes, offline merges | No duplicate ids after quiescence; ids stable across moves |
| 50 concurrent writers on one page | No client misses an update with repair disabled |
| Every row of the conflict tables, scripted | The stated rule, including the notice the user sees |
| Old client build against a newer document | Opens read-only; the server document is byte-identical afterwards |
| Hostile update corpus | Rejected or rendered inert; no script runs in the browser or in Tauri |
| Outbox replay after a lost response | No duplicate entity, no lost operation |
| Access granted and revoked while a client is offline | No stale or missing record after reconnect |
| Compaction killed at each step | The page loads and no update is lost |
