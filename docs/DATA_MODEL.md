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
| `divider`, `image`, `file`, `bookmark`, `childPage`, `sheetEmbed`, `erpView`, `databaseView` | `body` | none (atom) | |
| `text`, `hardBreak`, `pageMention`, `userMention`, `dateMention` | `inline` | | |

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
| Embedded spreadsheet | `sheetEmbed` | `workbookId`, `sheet`, `range`, `chartId`, `height` | No | Phase 5 |
| Embedded ERP view | `erpView` | `linkId`, `connectorId`, `filter`, `fields`, `sort`, `pageSize` | No | Phase 5 |
| Database view | `databaseView` | `databaseId`, `viewId` | No | Phase 4 |

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
| Inline atom | `dateMention` | `date` (Phase 4) |

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
| `PageAncestors` | (`PageId`, `AncestorPageId`), `Depth` | A closure table, kept by the server in the same transaction as a move. Gives "all descendants" and "all ancestors" in one indexed read, for permissions, trash and breadcrumbs |
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
`PrincipalType` later.

### Databases (Phase 4)

| Table | Key fields | Notes |
| --- | --- | --- |
| `Databases` | `PageId` (the database is a page of kind `database`), `Properties` (JSON), `Version` | Each property: `id`, `name`, `type`, `options` |
| `DatabaseViews` | `Id`, `DatabaseId`, `Name`, `Type`, `OrderKey`, `Config` (JSON), `Version` | `Type` is `table`, `board`, `list`, `calendar`, `gallery`; `Config` holds filter, sorts, grouping, visible properties, widths |
| `DatabaseRows` | `PageId` (the row is a page of kind `row`), `DatabaseId`, `Values` (JSON by property id), `PropertyVersions` (JSON by property id), `Computed` (JSON), `ComputedVersion` | The row's title is the page title. Its body is the page's Yjs document, created on first open |

Property types and how each value is stored:

| Type | Stored as |
| --- | --- |
| Text | String (plain; rich text in a cell is not planned) |
| Number | Decimal as a string, plus a display format on the property |
| Date | ISO date or date-time, optional end, optional time zone |
| Checkbox | Boolean |
| Select, Status | Option id |
| Multi-select | Array of option ids |
| Person | Array of user ids |
| URL | String, same scheme allow-list as links |
| Files | Array of asset ids |
| Relation | Array of row page ids in the target database; the reverse side is a second property kept in step by the server |
| Formula | Not stored in `Values`; the result is in `Computed` |
| Rollup | Not stored in `Values`; the result is in `Computed` |

Rules:

- Two edits to different properties of one row both stand. Two edits to the same property: the
  last to reach the server wins, and the property's version rises.
- Filtering, sorting and grouping run on the server for large databases and on the local mirror
  for small ones, with the same rules and shared test vectors.
- Property ids, not names, are stored everywhere, so a rename touches one record.

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
| `prefs` | Theme, language, sidebar state, toggle state, pinned-offline pages |
| `meta` | The store's own schema version: 2 from Phase 2 (IndexedDB upgrades additively; SQLite copies its file to `workspace.v1.db` first) |

A workspace made while signed out starts as local-only: the same collections, with nothing in
`outbox` ever sent. Uploading it (Phase 2) keeps its id and every record's: the workspace is made
on the server, each page's log is merged into one update, and the outbox is replaced by the
workspace's records as creates. A workspace made while signed in is uploaded at once.

## Data export and deletion

- A workspace exports as a zip: one Markdown file and one JSON file per page in folders that
  follow the tree, an `assets` folder, and a manifest of ids. Available from the first milestone,
  because a browser may evict local storage.
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
