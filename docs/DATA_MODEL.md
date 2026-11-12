# Data model

What Cash Gear Workspace stores, how each thing is identified, and which store owns it. The
reasons behind the choices are in `DECISIONS.md`; how the stores stay in step is in
`SYNC_DESIGN.md`.

Two models, kept apart on purpose:

- **Page content** is a Yjs document, one per page. Only the editor writes it.
- **Everything else** (the tree, titles, permissions, databases, assets) is relational records.
  The page hierarchy never depends on the editor: a page can be listed, moved, shared, trashed
  and searched without loading its document.

## Identifiers

| Thing | Id | Made by | Notes |
| --- | --- | --- | --- |
| User, workspace, section, page, database, view, asset, workbook, version, comment | UUIDv7 | The client that creates it | Lower-case hyphenated text in APIs and local stores; `binary(16)` in SQL Server so time order is index order |
| Block | 12 characters of base 62 | The editor's id plugin, in local transactions only | Unique within its page. A block anywhere is addressed as `pageId#blockId` |
| Operation (outbox) | UUIDv7 | The client | The idempotency key; the server stores it and answers a repeat with the first result |
| Document update | UUIDv7 | The client | The idempotency key for a pushed Yjs update |
| Document sequence | 64-bit integer, per page, gap-free | The server | Assigned under a lock on the page row |
| Workspace change sequence | 64-bit integer, per workspace | The server | The change feed's cursor |
| Yjs client id | 32-bit unsigned integer | A pool the server issues to a device; random while local-only | One per editing session, as Yjs requires. Registered to a user so pushed updates can be checked (Q9 in `DECISIONS.md`) |
| Order key | Fractional-index string, base 62 | The client | Binary collation; siblings sort by (order key, id) |
| Database property, select option (Phase 4) | 8 characters of base 62 | The client; options a type change or an import makes are derived from a hash (Databases) | Unique within their database or property; the title property's id is `title` |

Rules for stable ids:

- An id is never reused and never changes. A moved page keeps its id; a moved block keeps its id.
- A link to a page stores the page id. A link to a block stores `pageId#blockId`. Neither stores
  a title or a path.
- A duplicated block or page gets new ids for itself and everything inside it.
- Duplicate block ids inside one page (from two concurrent moves) are repaired the same way on
  every client: in document order, the first keeps the id and the k-th gets the first 12 base-62
  characters of SHA-256 of `id` + `:` + k, or of the next k whose result is not already an id in
  the page (so a repair never makes a new duplicate). The repair is its own local transaction,
  dispatched after the remote change has been applied; a transaction appended to the remote one
  never reaches Yjs (spike S1).

## Page content: the block schema

### Shape

Every block is a container with the same shape.

```
doc                           block*
└─ block                      attrs: id; content: (body | block)*
   ├─ body                    one of the body kinds below; the first is the block's body
   └─ block                   any block can hold blocks
```

A block is created with exactly one body, first. The content expression still allows any order
and any number, because concurrent edits can produce them and the binding stops syncing a
document the schema cannot hold (spike S1: `body* block*` broke in 9 of 12 long runs). A second
body, left by two concurrent conversions, is drawn after the first; a client never removes it on
its own.

### Content expressions

Fixed by spike S1 (DECISIONS.md, 2026-11-11: Phase 0 results).

| Node | Group | Content | Marks |
| --- | --- | --- | --- |
| `doc` | | `block*` | |
| `block` | | `(body \| block)*` | |
| `textBody` | `body` | `inline*` | all |
| `codeBlock` | `body` | `text*` | none |
| `table` | `body` | `tableRow*` | |
| `tableRow` | | `tableCell*` | |
| `tableCell` | | `inline*` | all |
| `divider`, `image`, `file`, `bookmark`, `childPage`, `tableOfContents` (v2), `databaseView` (v3), `sheetEmbed`, `erpView` | `body` | none (atom) | |
| `text`, `hardBreak`, `pageMention`, `userMention`, `dateMention` (v3) | `inline` | | |

Schema rules that hold forever (D3):

- `*` only. No `+`, no fixed counts, and no order between groups inside a container.
- A new attribute is optional and has a default. An older client that edits a node keeps the
  attributes it does not know only with the binding patch (Q18); without it, adding an attribute
  raises `schemaVersion` like a new node type.
- A node type or attribute is never removed or renamed. It can stop being created.
- An unknown node type is never dropped by a client: the schema-version gate (D7) stops an old
  client from binding the editor at all (spike S2).
- "Turn into" between text kinds changes `textBody.kind`; it never replaces the node, so a peer's
  concurrent typing in the block is kept. Turning text into a code block, or a code block into
  text, replaces the node, and concurrent typing in it is lost.

### Body kinds

Text kinds are one node, `textBody`, told apart by `kind` (spike S1).

| Block | Body node | Attributes (all optional, with defaults) | Inline content | MVP |
| --- | --- | --- | --- | --- |
| Paragraph | `textBody`, `kind: paragraph` | `dir`, `colour` | Yes | Yes |
| Heading 1 to 3 | `textBody`, `kind: heading` | `level` (1 to 3), `dir` | Yes | Yes |
| Bulleted list item | `textBody`, `kind: bulletItem` | `dir` | Yes | Yes |
| Numbered list item | `textBody`, `kind: numberedItem` | `dir`, `start` | Yes | Yes |
| Checklist item | `textBody`, `kind: checkItem` | `checked`, `dir` | Yes | Yes |
| Toggle | `textBody`, `kind: toggle` | `dir` | Yes (the summary line) | Yes |
| Quote | `textBody`, `kind: quote` | `dir` | Yes | Yes |
| Callout | `textBody`, `kind: callout` | `icon`, `tone`, `dir` | Yes | Yes |
| Divider | `divider` | none | No | Yes |
| Code block | `codeBlock` | `language`, `wrap` | Plain text only, no marks | Yes |
| Image | `image` | `assetId`, `width`, `align`, `alt`, `caption` | No | Yes |
| File attachment | `file` | `assetId` | No | Yes |
| Table | `table` → `tableRow*` → `tableCell*` | `headerRow`, `headerColumn`, per-cell `colspan`, `rowspan`, `colwidth`, `dir` | Cells hold inline content | Yes |
| Bookmark | `bookmark` | `url` | No | Yes (URL only; preview in Phase 2) |
| Child page | `childPage` | `pageId` | No | Yes |
| Table of contents | `tableOfContents` | none | No | Phase 3 (schema version 2): drawn as the page's headings, each a link to its block; Markdown and plain text write nothing for it |
| Embedded spreadsheet | `sheetEmbed` | `workbookId`, `sheet`, `range`, `chartId`, `height` | No | Phase 5 |
| Embedded ERP view | `erpView` | `linkId`, `connectorId`, `filter`, `fields`, `sort`, `pageSize` | No | Phase 5 |
| Database view | `databaseView` | `databaseId`, `viewId` (null: the database's first view) | No | Phase 4 (schema version 3): an inline database or a linked view, drawn by the host lazily near the viewport; deleting the block never deletes the database; Markdown and plain text write nothing for it |

Notes:

- A list is consecutive list-item blocks. Numbers are computed when drawn, not stored.
- A toggle's children are its hidden content. Whether it is open is kept per device.
- `dir` is `null` (from the first strong character), `ltr` or `rtl`. It exists on text blocks
  only. Containers and lists take their direction from their first text.
- `colour` is a theme token (as the colour marks use) for the whole block's text, set from the
  block menu. Every text kind has it, as it has `dir`.
- `hardBreak` is a line break inside a text body (Shift+Enter). A code block keeps its new lines
  as text instead.
- A file's name, size and type are read from the asset record, not copied into the document.
- A child page block is a link. The tree's parent field is the truth; deleting the block does not
  delete the page, and a page whose block is gone still shows in the sidebar.
- A block whose target is deleted, or that the reader may not see, draws a placeholder. A client
  never removes such a block on its own.

### Marks and inline nodes

| Kind | Name | Attributes |
| --- | --- | --- |
| Mark | `bold`, `italic`, `underline`, `strike`, `code` | none |
| Mark | `link` | `href` (scheme allow-list: `https`, `http`, `mailto`, `tel`, and internal page links) |
| Mark | `textColour`, `highlight` | `token` (a named colour from the theme, not a hex value, so dark mode works) |
| Inline atom | `hardBreak` | none |
| Inline atom | `pageMention` | `pageId`, optional `blockId` |
| Inline atom | `userMention` | `userId` (Phase 6) |
| Inline atom | `dateMention` | `date`, `end` (Phase 4, schema version 3): `YYYY-MM-DD` or a UTC instant, both default null; drawn in the interface language; text and Markdown write the date (and ` → end`) |

### Future blocks

Charts, kanban, calendar, timeline, embedded presentations, AI-generated content and plugin
blocks all fit the same pattern: an atom body holding ids and settings, with the data living in
its own store. AI-generated content is ordinary blocks once accepted; nothing in the schema marks
it. Plugin blocks are described in `INTEGRATIONS.md`.

## The Yjs document

| Shared type | Name | Holds |
| --- | --- | --- |
| `Y.XmlFragment` | `content` | The ProseMirror document above |
| `Y.Map` | `meta` | `schemaVersion` (integer), `epoch` (integer), `pageId` |
| `Y.Map` | `moves` | Phase 3: block id → `{ at, parent }`, written in the same update as a local move (drag, keyboard move, indent, outdent), so a moved block is recognisable and a device whose edit the move removed is told (`doc.moveConflict`). For history only; never pruned yet. Old clients keep it, as Yjs keeps root types it does not read; the worker validates only `content` |

- The server's page record holds the authoritative `schemaVersion` and `epoch`. The copies in
  `meta` let an offline client check before it binds the editor.
- Garbage collection is on.
- No subdocuments. A page inside a page is another page.

### Schema versions and migrations

- `schemaVersion` starts at 1 and rises by one for every change to the schema that an older
  client could not draw.
- Adding an optional attribute does not raise it. Adding a node type does.
- A migration is a function from version n to n + 1 that edits the document as an ordinary Yjs
  transaction. It runs on the first capable client that opens the page with edit rights, or in
  the server worker for bulk changes, and then raises `meta.schemaVersion` and the page record's.
- A change that cannot be expressed as a forward edit bumps the epoch instead (see
  `SYNC_DESIGN.md`).
- Every migration ships with a fixture document from the old version and a test that the result
  loads in the oldest supported client build that knows the new version.

As built in Phase 3: version 2 adds `tableOfContents`. `packages/doc/src/migrations.ts` holds one
step per version; `PageDocument.open` runs every step from the document's version to the build's
in one Yjs transaction (origin `MIGRATE`) when the page opens with edit rights and the device holds
content for it, before anything else; a reader writes nothing. Step 1 → 2 only raises
`meta.schemaVersion`. The edit is saved and pushed like any other; the worker, seeing a document
whose version rises to no more than the pushing client's and its own, validates it against the new
version's elements and raises the page's `DocSchemaVersion` in the same transaction, after which
older clients get 426 and open the page read-only. Fixture: `packages/doc/fixtures/doc-v1.json`
(every version-1 body, text kind and mark). A page pulled to a version newer than the build while
it is open saves what was typed, writes nothing more, and turns read-only; the read-only view shows
every node the build does not know as a placeholder where it was, with whatever it held that the
build can draw, and never drops it.

As built in Phase 4: version 3 adds `databaseView` and `dateMention`; step 2 → 3 only raises
`meta.schemaVersion`, by the same path. Fixture: `packages/doc/fixtures/doc-v2.json`; a build that
knows only version 2 opens a version-3 page read-only with both new nodes as placeholders, kept.

## Relational records

Column lists give the fields that matter to the design, not final DDL. Every table has
`CreatedAt`; every tenant-owned table has `WorkspaceId` and is covered by the tenant filter. As
built in Phase 2 (`server/src/Cgw.Core/Data`): ids are `binary(16)` in RFC byte order, order keys
are binary-collated, and one EF Core query filter scopes every tenant-owned table to the request's
workspace (a test fails if a table with `WorkspaceId` lacks it).

### Accounts and tenancy

| Table | Key fields | Notes |
| --- | --- | --- |
| `Users` | `Id`, `Email` (unique), `DisplayName`, `Locale`, `AvatarAssetId`, `DeletedAt` | ASP.NET Core Identity tables hang off this (`Roles`, `UserClaims`, `UserLogins`, `UserTokens`, `RoleClaims`); OpenIddict's applications, authorisations and tokens beside them |
| `Devices` | `Id`, `UserId`, `Name`, `Platform`, `LastSeenAt`, `RevokedAt`, `AuthorizationId` | A desktop install or a browser profile. A cookie session carries its device id and is refused once it is revoked; a desktop's OpenIddict authorisation is revoked with it |
| `DataProtectionKeys` | `FriendlyName`, `Xml` | The key ring for cookies and Identity tokens, shared by every API instance, DPAPI-protected on Windows hosts |
| `YjsClients` | `ClientId`, `WorkspaceId`, `UserId`, `DeviceId`, `Origin` | Unique on (`WorkspaceId`, `ClientId`). `Origin` is `issued` (a device's pool) or `registered` (used before the device synced) |
| `Workspaces` | `Id`, `Name`, `Icon`, `OwnerUserId`, `ChangeSeq`, `Version`, `StorageQuotaBytes`, `StorageUsedBytes`, `DeletedAt` | `ChangeSeq` is the head of the change feed, given out under the row's lock. The quota is recorded and shown, not enforced (Q10) |
| `WorkspaceMembers` | (`WorkspaceId`, `UserId`), `Role` | `owner`, `admin`, `member`, `guest` |
| `WorkspaceInvites` | `Id`, `WorkspaceId`, `Email`, `Role`, `TokenHash`, `ExpiresAt`, `AcceptedAt` | The token is stored hashed |

### Tree

| Table | Key fields | Notes |
| --- | --- | --- |
| `Sections` | `Id`, `WorkspaceId`, `Name`, `OrderKey`, `Visibility`, `OwnerUserId`, `Version` | `Visibility` is `workspace` or `private` |
| `Pages` | `Id`, `WorkspaceId`, `SectionId`, `ParentPageId` (null at the top of a section), `OrderKey`, `Kind`, `Title`, `SearchTitle`, `Icon`, `CoverAssetId`, `Version`, `DocSeq`, `DocHeadSeq`, `DocSchemaVersion`, `DocEpoch`, `Restricted`, `TemplateOfPageId`, `IsTemplate`, `CreatedBy`, `UpdatedBy`, `UpdatedAt`, `TrashedAt`, `TrashedBy`, `TrashRootId`, `DeletedAt` | `Kind` is `page`, `database` or `row`. `Version` rises on every metadata change. `DocSeq` is the last document sequence given out, `DocHeadSeq` the validated head pulls serve up to (Q20). `SearchTitle` is the normalised title. A page deleted for good stays as a tombstone (`DeletedAt`, no title) so a push gets 410; the worker purges its document |
| `PageAncestors` | (`PageId`, `AncestorPageId`), `Depth` | A closure table, kept by the server in the same transaction as a move. Gives "all descendants" and "all ancestors" in one indexed read, for permissions, trash and breadcrumbs. Rows of databases are not in it (Databases) |
| `Favourites` | (`UserId`, `PageId`), `OrderKey` | Per user |
| `PageVisits` | (`UserId`, `PageId`), `LastVisitedAt` | Recent pages, capped per user |

Indexes that matter: `Pages (WorkspaceId, SectionId, ParentPageId, OrderKey, Id)` for listing
children in order; `Pages (WorkspaceId, TrashedAt)` for the trash; `PageAncestors (AncestorPageId)`.

Tree rules, enforced by the server:

- A page's parent is in the same workspace and section.
- No cycles: a move whose new parent is the page itself or a descendant is refused.
- Parent and order key change together in one operation.
- Trashing a page trashes its descendants as one unit; restoring brings back the same unit. If the
  old parent is gone, the page returns to the top of its section.
- Permanent deletion happens only from the trash, by a person or when retention ends.

Large workspaces: the client mirrors `Pages` metadata for the workspace (about 200 bytes a page,
so 10,000 pages is about 2 MB) and draws the sidebar from the mirror with a virtualised tree. No
document is loaded to draw the tree.

### Documents

| Table | Key fields | Notes |
| --- | --- | --- |
| `PageDocUpdates` | (`PageId`, `Seq`), `UpdateId` (unique), `Epoch`, `UserId`, `DeviceId`, `Data` (`varbinary(max)`), `Status`, `Problem`, `CreatedAt` | `Status` is pending until the worker decides: valid (served) or refused (never served; `Problem` says why). Rows are deleted once a snapshot covers them |
| `PageDocSnapshots` | `Id`, `PageId`, `Epoch`, `UpToSeq`, `BlobKey`, `SizeBytes`, `Kind`, `Name`, `CreatedBy`, `CreatedAt` | `Kind` is `compaction`, `auto` (kept as history) or `named` |
| `PageDocDerived` | `PageId`, `UpToSeq`, `Json` (compressed ProseMirror JSON), `PlainText`, `SearchText`, `Outgoing` (JSON: linked page ids, asset ids) | Written by the worker. `SearchText` is the normalised text the full-text index reads |
| `PageLinks` | (`FromPageId`, `ToPageId`) | Backlinks, rebuilt by the worker from `Outgoing` |
| `PageDocCommands` | `Id`, `PageId`, `Kind`, `SnapshotId`, `RequestedBy`, `Status`, `Error` | Work the worker does on a document: a hard restore |

A page's current content is the newest compaction snapshot plus the update rows after it.

### Assets

| Table | Key fields | Notes |
| --- | --- | --- |
| `Assets` | `Id`, `WorkspaceId`, `BlobKey`, `FileName`, `ContentType`, `SizeBytes`, `Sha256`, `Status`, `Problem`, `Width`, `Height`, `CreatedBy`, `UnreferencedSince` | `Status` is `pending` (until the worker has checked the bytes against the type), `ready`, `quarantined` or `deleted` |
| `AssetRefs` | (`AssetId`, `PageId`) | Rebuilt by the worker. An asset nothing refers to (content, cover, link preview, avatar) for 30 days is deleted |
| `LinkPreviews` | (`WorkspaceId`, `UrlHash`), `Url`, `Status`, `Title`, `Description`, `SiteName`, `ImageAssetId`, `FetchedAt` | Bookmark previews (Q13), fetched behind the SSRF guard and kept 7 days; the image is a workspace asset |

Blob layout: `workspaces/{workspaceId}/assets/{assetId}` and
`workspaces/{workspaceId}/pages/{pageId}/snapshots/{snapshotId}`. Names never contain user text.

Reading an asset needs read access to a page that references it, or to be its uploader.

### Permissions

| Table | Key fields | Notes |
| --- | --- | --- |
| `PagePermissions` | (`PageId`, `PrincipalType`, `PrincipalId`), `Level` | `PrincipalType` is `user`, `workspace` or `link`. `Level` is `full`, `edit`, `comment`, `view` or `none` |
| `ShareLinks` | `Id`, `PageId`, `TokenHash`, `Level`, `ExpiresAt`, `RevokedAt`, `CreatedBy` | Off unless a person creates one. `view` only at first |

How access is decided, on the server, for every request:

1. The caller must be a member of the workspace (or hold a valid share link for that page).
2. Workspace `owner` and `admin` have `full` on everything in shared sections.
3. A private section is visible to its owner only.
4. Otherwise the level comes from the nearest page, walking up from the page through its
   ancestors, that has `Restricted` set or an explicit row for the caller; failing that, the
   workspace default for the caller's role (`member`: edit, `guest`: none).
5. A `guest` sees only pages shared with them by name.

As built in Phase 2 (`Cgw.Core/Access.cs`, `Cgw.Core/Sharing`): a page in a private section takes
no access list and no link. Changing a page's list raises its `Version` (`GET` sends it as an
`ETag`, `PUT` takes `If-Match`) and writes an `access` change to the feed, `revoke` when anyone
could lose access, else `grant`, so clients refetch the subtree. The list's entries are shown
only to someone with `full` on the page; others see whether it is restricted and their own level.

A page never falls back to a looser access than it had. Moving a page so that a different ancestor
decides its access needs `full` on it, and the page keeps its access: it becomes `Restricted`, with
rows copied from the chain that decided it. A restore or a create whose parent has gone, and so
lands at the top of the section, keeps the old chain's access the same way. Moving between a
shared and a private section needs `full` on every page moved; so does deleting a subtree for
good. Each of these writes an `access` change, as does any move of a page with pages under it.

A share link reads its page and the pages under it, except restricted pages, pages hidden from the
workspace (a `workspace` row of `none`) and everything under either, and trashed pages; it reads
each as the worker's derived JSON, never the Yjs updates (which still carry text deleted moments
before). The token is 32 random bytes, stored as its SHA-256, sent in the `X-Share-Token` header,
and an unknown, revoked or expired link gets the same 404 as a missing page.

A guest sees only themselves and the people named on pages they can see (no addresses but their
own), only sections that hold a page they can see, and no other member's changes in the feed. A
removed member's rows and waiting invitations go with them; a used invitation works again only
while its person is still a member. The worker refuses a pushed update whose author can no longer
edit the page when it decides, so a revoke cannot be outrun by a push.

Granularity stops at the page (D8). Field names in `PagePermissions` leave room for groups as a
`PrincipalType` later. A database's rows take its access: a row has no access list, no share link
and no `Restricted` of its own (Phase 4).

### Databases (Phase 4)

A database is a page of kind `database`; a row is a page of kind `row` whose parent is its
database. The shapes are `packages/workspace/src/db/types.ts` and `RowRecord` in
`packages/workspace/src/types.ts`; the rules run in TypeScript (`packages/workspace/src/db/`) and
in C# (`server/src/Cgw.Core/Databases/`), held together by the shared vectors
`packages/workspace/vectors/db-{convert,query,formula,compute,csv}-vectors.json`.

| Table | Key fields | Notes |
| --- | --- | --- |
| `Databases` | `PageId` (its page, kind `database`), `WorkspaceId`, `Properties` (JSON array, in display order, deleted ones included), `Version`, `RowCount`, `RowsVersion`, `ComputePending`, `CreatedAt`, `UpdatedAt` | Exactly one property of type `title`, id `title`: the row's page title. `Version` rises on every change to the properties; `RowsVersion` on any write to its rows (the query cache's check). `RowCount` counts rows not trashed and not templates |
| `DatabaseViews` | `Id`, `WorkspaceId`, `DatabaseId`, `Name`, `Type`, `OrderKey` (binary collation), `Config` (JSON), `Version` | `Type` is `table`, `board`, `list`, `calendar`, `gallery`; `Config` holds the filter, sorts, group, shown and hidden properties with widths, the calendar's date property, the gallery's cover and card size, wrap |
| `DatabaseRows` | `PageId` (its page, kind `row`), `WorkspaceId`, `DatabaseId`, `Values` (JSON by property id), `PropertyVersions` (JSON by property id), `Computed` (JSON), `ComputedVersion`, `Seq` | The row's title, icon, cover, order key, trash and document are its page's. `Seq` is the `RowsVersion` it was last written at. Indexes (`DatabaseId`, `PageId`), (`DatabaseId`, `Seq`) |

A database page sits anywhere a page may; only rows sit under it, and nothing sits under a row.
A full-page database is in the sidebar; an inline one is a child of the page holding its
`databaseView` block. A database page has no document of its own. Rows are not in `PageAncestors`:
a row's access is its database's (it cannot be restricted, given an access list or a share link),
a row only reorders among its database's rows, and moving, trashing, restoring or deleting a
database reaches its rows through `DatabaseRows`, set-based. Trashing a row makes it its own trash
root; on a device a row also reads as trashed while its database page is. A row with `IsTemplate`
is a row template: never in a view, a query, `RowCount` or an export.

Property ids and option ids are 8 characters of base 62, unique within their database or property
(`title` is the title property's). Property ids, not names, are stored everywhere, formulas
included (`prop("Ab12Cd34")`), so a rename touches one record.

Property types and how each value is stored (an empty value is absent, never `''` or `[]`):

| Type | Stored as |
| --- | --- |
| Title | The row page's title (not in `Values`) |
| Text, URL, email, phone | String (plain; URL, email and phone draw as safe links) |
| Number | A JSON number (an IEEE double, as both evaluators use), with a display format on the property |
| Date | `{ start, end? }`: `YYYY-MM-DD`, or a UTC instant `YYYY-MM-DDTHH:mm:ssZ` |
| Checkbox | `true` (unchecked is no value) |
| Select, status | Option id (status options carry a group: to do, in progress, complete) |
| Multi-select | Array of option ids |
| Person | Array of user ids |
| Files | Array of asset ids |
| Relation | Array of row ids of the related database, at most 1,000 (a longer one keeps its first 1,000); kept in step with the reverse property there |
| Formula, rollup | Not stored: the result is in `Computed` |
| Created time, created by, last edited time, last edited by | Not stored: the row page's `CreatedAt`, `CreatedBy`, `UpdatedAt`, `UpdatedBy` |

Rules (both sides, in the vectors):

- **Per-property last writer wins.** `row.update` and `db.update` merge per property; two edits to
  different properties of one row both stand; to the same property, the last to reach the server
  wins and that property's version rises. A row's page version, `UpdatedAt` and `UpdatedBy` move on
  every row write.
- **Coercion.** Every value written is coerced to its property's current type, on the client and
  on the server: an offline edit made before a type change lands converted; what cannot be coerced
  is cleared.
- **Type changes** convert every row's value by the table below (rows in id order); select options a
  conversion needs are made with ids derived from SHA-256 of `databaseId NUL propertyId NUL name`, so
  every device and the server make the same ones. The title never changes type.
- **Deleting a property** sets its `trashedAt`: its values stay, it is hidden, computes nothing, and
  filters, sorts and groups on it are ignored; restoring it brings everything back. **Deleting an
  option** removes it from the property; values that hold its id stay and read as empty. Neither
  rewrites a row.
- **Relations** are two-way: adding a relation with a reverse property the target lacks adds it
  there (edit on both); setting row A's relation to add B and remove C edits B's and C's reverse
  values in the same transaction. Values keep only ids of live rows of the related database. A
  relation that no longer pairs with its reverse (changed to another type, or pointed elsewhere)
  leaves the reverse one-way, with its values.
- **Formulas and rollups** are computed per row (rollups first, then formulas in dependency order; a
  cycle is `formula.cycle` for every property in it), by the server into `Computed` with
  `ComputedVersion` (the database version they were made for): in the transaction that changes a
  row (and rows relating to it, up to 1,000, else the database is marked `ComputePending`), for every
  row inline after a formula or rollup change up to 5,000 rows, else by the worker's recompute job.
  A device shows and filters by its own result when it holds the inputs, else by the server's. The
  language has no volatile functions (now, today), so a cached result never goes stale by itself.
- **Filtering, sorting and grouping** run on the device for a database it holds in full (at most
  5,000 rows, `LOCAL_ROW_LIMIT`) and on the server otherwise, by the same rules: text by
  `normaliseText`, ordinal order; dates by calendar date in the asker's offset; empty values last in
  both directions; ties by order key, then id; options by their position; a condition on a deleted
  or unknown property is ignored. The server evaluates queries in memory over the database's rows,
  cached per database and `RowsVersion` (decided by measurement in M4.3: 270 ms p95 at 50,000 rows
  with a filter and a sort, against a 300 ms budget).

A value is first read as what it holds by its old type, then written as the new type:

| New type ← old | text | number | date | checked | options | ids |
| --- | --- | --- | --- | --- | --- | --- |
| text, title | as is | `String(n)` | start, or `start → end` | `true` | names joined `, ` | nothing |
| url, email, phone | trimmed | `String(n)` | as text | `true` | names joined `, ` | nothing |
| number | parsed (1) | as is | nothing | 1 | its one name parsed | nothing |
| date | parsed (2) | nothing | as is | nothing | its one name parsed | nothing |
| checkbox | a word (3) | n ≠ 0 | nothing | as is | its one name as a word | nothing |
| select, status | the option named so | the option named `String(n)` | the option named the date | the option named `true` | the same id, else the same name | nothing |
| multi-select | each comma-separated part | as select | as select | as select | each: same id, else same name | nothing |
| person, files, relation | nothing | nothing | nothing | nothing | nothing | ids of the same kind stay |
| formula, rollup, created and edited time and by | nothing: they store no value | | | | | |

The old types read as: title, text, url, email, phone: text; number: number; date and created or
edited time: date; checkbox: checked; select, status, multi-select: options (known ids, in order);
person, created or edited by: people; files: files; relation: rows; formula and rollup: their result
(a list as text joined by `, `). (1) Trimmed; Arabic-Indic and Persian digits read as 0 to 9, `٫` as
the point, `٬` and commas between groups of three as thousands separators; no currency, percent or
spaces. (2) ISO dates only, with an optional time and offset, spans as `a → b`. (3) `true yes y 1 on
checked x ✓ ✔ نعم` and `false no n 0 off unchecked لا`. Option names match exactly after trimming.

CSV (`db/csv.ts`): import parses RFC 4180 (a BOM dropped; the separator whichever of comma,
semicolon and tab is most common in the first line), makes a new database's properties by inference
(the first column is the title; number, checkbox, date, url, email, select, else text) or maps
columns to existing properties, and reads each cell as the text conversion does; at most 50,000
rows and 20 MB. Export writes UTF-8 with a BOM and CRLF, the view's shown properties in order, values
in canonical form (options, people, related rows and files by name). A text cell starting with `=`,
`+`, `-`, `@`, a tab or a carriage return is written with a leading `'`, and import takes exactly
one such `'` off, so a spreadsheet never runs a cell as a formula and a round trip changes nothing.

### Workbooks (Phase 5)

| Table | Key fields | Notes |
| --- | --- | --- |
| `Workbooks` | `Id`, `WorkspaceId`, `Name`, `CurrentVersionId`, `ETag`, `CreatedBy`, `TrashedAt` | A document in its own right, not owned by any page |
| `WorkbookVersions` | `Id`, `WorkbookId`, `BlobKey`, `SizeBytes`, `Sha256`, `SavedBy`, `SavedAt` | The xlsx bytes |
| `WorkbookPermissions` | (`WorkbookId`, `PrincipalType`, `PrincipalId`), `Level` | Its own access list |
| `WorkbookPreviews` | (`WorkbookId`, `VersionId`, `ViewHash`), `AssetId` | A picture of a range or chart, for offline and for readers without Sheet loaded |

Deleting a page that embeds a workbook does not delete the workbook.

### ERP links (Phase 5)

| Table | Key fields | Notes |
| --- | --- | --- |
| `ErpLinks` | `Id`, `WorkspaceId`, `ErpBaseUrl`, `Company`, `LinkedBy`, `LinkedAt`, `RevokedAt` | Which ERP company a workspace is linked to. No key, token or session is stored |

ERP data is never written to any Workspace table or document.

### Sync and audit

| Table | Key fields | Notes |
| --- | --- | --- |
| `WorkspaceChanges` | (`WorkspaceId`, `Seq`), `EntityType`, `EntityId`, `Kind`, `Version`, `ActorUserId`, `CreatedAt` | The change feed. `Kind` is `upsert`, `delete`, `grant` or `revoke` |
| `AppliedOps` | `OpId`, `WorkspaceId`, `UserId`, `Result` (JSON), `CreatedAt` | Idempotency. Written in the same transaction as the operation |
| `AuditLog` | `Id`, `WorkspaceId`, `ActorUserId`, `Action`, `TargetType`, `TargetId`, `Detail` (JSON), `Ip`, `CorrelationId`, `CreatedAt` | Append-only: sign-ins (and failures, lockouts), sign-ups, password resets, devices signed out, sharing changes, member changes, exports, permanent deletions, restores, refused forged updates, ERP link changes. Account events have no workspace |
| `WorkspaceExports` | `Id`, `WorkspaceId`, `RequestedBy`, `Status`, `BlobKey`, `SizeBytes`, `Error` | A workspace's export zip, written by the worker |
| `JobStates` | `Name`, `LastRunAt`, `LastOkAt`, `LastError`, `Runs` | Each worker job's last run: the worker's lag and the API's health check |

### Comments (Phase 6)

| Table | Key fields | Notes |
| --- | --- | --- |
| `CommentThreads` | `Id`, `PageId`, `BlockId`, `AnchorPosition` (optional, a Yjs relative position), `Quote`, `ResolvedAt` | Anchored on the block id. The relative position narrows it within the block; the quoted text is the fallback when the position no longer resolves |
| `Comments` | `Id`, `ThreadId`, `AuthorUserId`, `Body` (JSON, the same inline schema), `EditedAt`, `DeletedAt` | |

## Local stores

Both local stores hold the same logical data, behind the `LocalStore` interface.

| Collection | Holds |
| --- | --- |
| `workspaces`, `sections`, `pages` | The metadata mirror, with each record's server version |
| `docUpdates` | Yjs updates per page, each marked local or acknowledged, with the server sequence once known |
| `docSnapshots` | The latest compacted state per page |
| `outbox` | Operations not yet acknowledged, in order, findable by workspace and by entity |
| `cursors` | The change-feed cursor per workspace (`syncCursors`); the server head sequence and epoch this device holds per page (`docCursors`) |
| `assets` | Asset metadata (with `uploaded` once the server holds the bytes), cached bytes, and uploads not yet sent |
| `searchIndex` | Desktop: an FTS5 table. Browser: rebuilt in memory from `pages` and cached text |
| `prefs` | Theme, language, sidebar state, toggle state, the Yjs client-id pool, the signed-in account (no credential: id, email, name, device id), so the app starts signed in while offline |
| `pins` (Phase 3) | Pages kept on this device for offline use: one record per pin, with `subtree` when the pages under it (later ones included) are kept too |
| `quarantine` (Phase 3) | Logs set aside so nothing typed is lost: the page's snapshot and every update, its title, the reason (`doc.epochMismatch`, `page.gone`, `access.denied`, `page.removed`) and whether it became a recovered page. Entries outlive their page and workspace |
| `repairs` (Phase 3) | Per page, the last state-hash check: epoch, the head it matched at, repairs made there |
| `databases`, `views` (Phase 4) | Every database and view record of the workspace the account may see, as the tree and the feed give them; `readMirror` returns them with the pages |
| `rows` (Phase 4) | Rows of databases this device holds (`RowRecord`: the row's page and its values); never in `readMirror`, read per database (`readRows`); `getPage` finds them |
| `dbHolds` (Phase 4) | Databases whose rows this device keeps: `full` (every row; queried on the device, at most 5,000 rows) or `partial` (the rows the server's queries returned, as a cache), `complete` once a full fetch has run to its end, `after` where it goes on |
| `corrupt` | Updates that did not decode or that the server refused, kept for support |
| `meta` | The store's own schema version: 4 from Phase 4. IndexedDB upgrades additively; SQLite copies its file first (`workspace.v1.db` before schema 2, `workspace.v2.db` before schema 3, `workspace.v3.db` before schema 4), then migrates in one transaction |

Schema 3's IndexedDB object stores are `pins` (key `pageId`, index `workspace`), `quarantine`
(key `id`, index `workspace`) and `repairs` (key `pageId`), and `docLogs` gains an index
`covers`; SQLite's tables are `pins`, `quarantine` with `quarantine_parts`, and `repairs`.
Schema 4's IndexedDB object stores are `databases` (index `workspace`), `views` (indexes
`workspace`, `database`), `rows` (indexes `database`, `workspace`, `trashRoot`) and `dbHolds` (key
`databaseId`, index `workspace`); SQLite's tables are `databases`, `db_views`, `db_rows` and
`db_holds` (`rows` is an SQL keyword). Removing a database page removes its record, views, hold and
rows, each row as a removed page (document, history, search entry, pin, repair state, unsent edits
set aside when it is the server's word). A database made on the device is held in full from its
creation. Rows count as pages for documents (held pages, storage, unsent updates, compaction).

Migrations are tested from stores of every earlier version: the SQLite fixtures
(`crates/cgw-store/tests/fixtures/v1`, `v2`, `v3`) are stores written by the v0.1.0, v0.2.0 and
v0.3.0 code itself (`make.mjs` builds that code from its tag and drives it).

A workspace made while signed out starts as local-only: the same collections, with nothing in
`outbox` ever sent. Uploading it (Phase 2) keeps its id and every record's: the workspace is made
on the server, each page's log is merged into one update, and the outbox is replaced by the
workspace's records as creates. A workspace made while signed in is uploaded at once.

## Data export and deletion

- A workspace exports as a zip: one Markdown file and one JSON file per page in folders that
  follow the tree, an `assets` folder, and a manifest of ids. Available from the first milestone,
  because a browser may evict local storage.
- From Phase 4 the manifest (`cgw-export.json`) is version 2, written alike by the app and the
  server: every page entry has its `kind`; a row's entry also has `databaseId` and its `values` as
  stored, and its files sit in its database's folder as a child page's do; `databases` lists each
  database's `{ id, properties, views }` (views in order-key order). Each database's folder also
  holds `<title>.csv` (every property not deleted, title first; trashed rows and templates left
  out), for people. Import reads the JSON, never the CSV, accepts versions 1 and 2 from either
  side, and makes new ids for pages, rows, databases, views and assets while keeping property and
  option ids; relations, rollups and formulas, and rows' relation values, are set once every
  database and row exists. A device exports what it holds; the server exports every row.
- Deleting a workspace marks it deleted, removes access at once, and purges rows and blobs after
  30 days (the worker's `purgeWorkspaces` job). Its audit rows stay: the log is append-only.
- Deleting a page for good (from the trash) leaves a tombstone row; the worker purges its
  document, versions, derived rows and blobs (`purgePages`, `Pages.PurgedAt`).
- Deleting an account removes the user's memberships, their private sections and their personal
  data, revokes every device and token, and keeps their edits in shared pages under "Deleted
  user". It is refused while the user is the only owner of a workspace others are in: they hand
  it over first. Workspaces no one else is in are deleted with the account.
- As built in Phase 2, the server's export (`POST /workspaces/{id}/exports`, owners and admins)
  holds the pages the requester may read, their own private section included and other people's
  not; the worker writes the zip, and it is kept 7 days behind a signed URL for the requester
  only. Its Markdown is written by the server's own writer (`Cgw.Core/Documents/Markdown.cs`),
  held to the client's by shared vectors (`packages/doc/vectors/markdown-vectors.json`).
