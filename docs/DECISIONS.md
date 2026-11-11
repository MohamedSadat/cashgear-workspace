# Decisions

Every choice that is expensive to reverse, with what was rejected and what it costs. New decisions
are added under a dated heading; old ones are never edited, only superseded by a later entry that
says so.

## 2026-11-11: Planning

### Answered by you

| Question | Answer |
| --- | --- |
| Who signs in to Cash Gear Workspace? | Workspace has its own accounts. An ERP company can link its workspace, and ERP blocks then use a launch-ticket session, so Workspace never holds an ERP API key |
| Where does the backend live? | In this repo, with its own SQL Server database and EF Core migrations. It talks to the ERP only through a versioned contract |
| What does the first milestone include? | Local-first: the full editor, page tree, search and themes saved locally, in the browser and in Tauri, with no login. Accounts and cloud storage follow as the next phase |
| Are documents CRDT data from the first milestone? | Yes. Each page is a Yjs document from the start, even with one user |
| How is work delivered? | As in cashgear-sheet: everything is committed and pushed to `main`; when a phase ends, the next one is offered as a card that starts a new session |

### Architecture decisions

Each row names the choice, what was rejected, and the trade-off accepted.

#### D1. Repository: separate repo, same template as Sheet

- **Choice.** `cashgear-workspace` is its own repo with a pnpm workspace, a Cargo workspace and a
  .NET solution. It consumes `@cashgear/ui` as a git dependency pinned to a commit, as Sheet does.
- **Rejected.** A monorepo with Sheet: Sheet's rules are `main` only, phase tags and one version
  bumped everywhere, and all its `@cgs/*` packages are private raw TypeScript. Joining the repos
  would couple releases, CI time and licence gates with nothing shared today except the UI library.
- **Rejected for now.** A shared `@cashgear/app-kit` package for the platform split, theme
  controller and shortcuts. Workspace copies those small pieces and adapts them. A shared package
  is proposed once a third app needs the same code.
- **Trade-off.** Some duplicated code (a few hundred lines) and three repos pinning the UI library
  at different commits.

#### D2. Editor: Tiptap 3 on ProseMirror

- **Choice.** Tiptap 3 (MIT) used directly, with our own schema, block-id plugin, direction
  attribute, slash menu, drag handle and bubble toolbar.
- **Rejected.**
  - Lexical (MIT): still 0.x, three collaboration bindings in flux (`@lexical/yjs`, `@lexical/y`,
    an experimental v2 plugin), smaller table ecosystem. Its RTL and table maturity were not verified.
  - BlockNote: core is MPL-2.0, which the licence policy allows, but its `xl-*` packages are
    GPL-3.0 or proprietary, and it fixes the schema we need to control for ERP, sheet and
    database blocks.
  - Slate: weaker collaboration and IME story.
  - A custom text-layout engine: the brief rules it out and nothing here needs it.
  - `CgRichTextEditor` from the UI library: it wraps Tiptap 3.31 but takes and returns sanitised
    HTML strings only. It has no document model, so it cannot be the block editor.
- **Trade-off.** We own the Notion-style behaviour ourselves (block containers, handle, menus)
  instead of getting it from BlockNote.

#### D3. Block schema: one uniform block container

- **Choice.** Every block is a container with an id, a body and optional child blocks. Lists are
  blocks, not `ul > li` trees. Nesting is children of any block.
- **Rules that hold from the first commit.** Content expressions use `*`, never `+` or bounded
  counts; every attribute added later is optional with a default; no node is ever removed from the
  schema, only stopped being created.
- **Why.** The Yjs binding deletes any node the local schema cannot build, and that deletion
  syncs to everyone. A split is "delete the tail, insert a node", so a concurrent edit can leave a
  node that breaks a `+` rule.
- **Rejected.** ProseMirror's standard nested list nodes: indent, drag, convert and duplicate would
  each need a list case and a non-list case.
- **Open.** The exact content expression for the container body is fixed by spike S1.

#### D4. Block ids: our own plugin

- **Choice.** A plugin in the document package mints ids. It does not use
  `@tiptap/extension-unique-id`.
- **Rules.**
  - Ids are minted only in local transactions: create, paste, duplicate, split.
  - No id is ever rewritten in response to a remote transaction, with one exception below.
  - On a split, the half that keeps the content keeps the id.
  - A move keeps the id.
  - Duplicates (two concurrent moves, or a paste of a block that still exists) are repaired by a
    rule every client computes the same way: the first in document order keeps the id, the k-th
    gets a hash of the id and k.
- **Why not UniqueID.** Open issues at the time of planning: ids minted on open stay out of the
  Yjs document until the next edit and peers overwrite each other; internal drag-and-drop
  regenerates ids; the append transaction is quadratic in new nodes.
- **Trade-off.** We maintain a small plugin and its fuzz test.

#### D5. Document state: one Yjs document per page

- **Choice.** Yjs 13, one `Y.Doc` per page, garbage collection on, no subdocuments. The Yjs to
  ProseMirror binding sits behind one module so Tiptap's fork (`@tiptap/y-tiptap`), upstream
  `y-prosemirror` 1.x and the Yjs 14 rewrite stay swappable.
- **Rejected.**
  - ProseMirror JSON and steps now, CRDT later: every document would be migrated and undo,
    persistence and sync rewritten at the offline phase. Central rebasing also drops work after
    long offline sessions.
  - Automerge 3: its ProseMirror binding calls itself beta, dictates the schema, and history is
    kept in full.
  - Loro: it has a real move operation and a tree CRDT, but its ProseMirror binding has open
    content-loss issues and its .NET binding is community-maintained and bare.
  - Yjs 14 with `@y/prosemirror` 2: beta, and migrating to it is one-way.
- **Escape hatch.** The server keeps a derived ProseMirror JSON and plain text for every page, so
  a page can always be rebuilt without Yjs.
- **Trade-off.** Binary storage, Yjs undo semantics, a server component that understands Yjs, and
  the limits in D9.

#### D6. The document holds ids only; the page title is relational

- **Choice.** Child pages, sheet embeds, ERP views, database views, mentions and files are atom
  nodes that store an id. Titles and names are resolved from the local mirror when drawn. The page
  title is a field on the page record, edited outside the ProseMirror document.
- **Why.** A cached title goes stale and leaks across permissions. A title in both stores has two
  writers and a sidebar that disagrees with the editor.
- **Trade-off.** Concurrent edits to a title do not merge by character; the last to reach the
  server wins. Undo does not span the two stores.

#### D7. Schema version and epoch on every document

- **Choice.** Each page records a document schema version and an epoch, on the server and inside
  the Yjs document. A client older than the document opens it read-only and its pushes are
  refused. A hard restore, a migration or a corruption fix bumps the epoch; a push against an old
  epoch gets 409 and the client keeps a recoverable copy.
- **Why.** Offline desktop makes stale clients certain, and a stale client would delete nodes it
  does not know. The same gate makes a later move to Yjs 14 possible.

#### D8. Permissions stop at the page

- **Choice.** The smallest unit with its own access list is a page. Content that must be
  restricted is a child page with its own access list.
- **Why.** Anyone who syncs a Yjs document receives all of it, so a block-level permission inside
  one document can hide a block but cannot protect it.
- **Effect on the brief.** "Block-level permissions in future versions" becomes "restricted
  sub-pages". Block-level *locking* (who may edit) can still be added as a soft rule.

#### D9. Everything that is not page content is relational

- **Choice.** The page tree, titles, icons, permissions, favourites, database schemas, views and
  rows are relational records. They sync through an outbox of idempotent operations and a
  per-workspace change feed, not through a CRDT.
- **Why.** These need rules only a server can enforce: no cycles, permissions, uniqueness.
- **Conflict rule.** The last operation to reach the server wins per field. Client clocks are
  never compared. Delete, move and permission changes carry the version they were based on and are
  refused on a mismatch.

#### D10. Rust where it pays, not in the editor

- **Choice.** Rust is used for the Tauri shell, the desktop SQLite store (rusqlite, bundled, with
  FTS5), token storage in the OS keychain, and the server-side Yjs library (D14). Formualizer may
  be reused for database formulas in Phase 4.
- **Rejected.** Rust or WASM inside the editor. ProseMirror is bound to the DOM; a WASM call per
  keystroke adds a copy and a hop and removes nothing.

#### D11. Local storage: one interface, two stores

- **Choice.** A `LocalStore` TypeScript interface at domain level ("append this update to this
  page", not SQL). The browser implements it on IndexedDB; the desktop on SQLite behind typed
  Tauri commands. One conformance suite runs against both. The sync engine is TypeScript and
  shared.
- **Rejected.**
  - `tauri-plugin-sql`: it hands raw SQL to the webview, so one XSS reads and writes everything.
  - SQLite on OPFS in the browser: one schema for both, but `opfs` needs COOP/COEP (which breaks
    third-party embeds), `opfs-sahpool` fails in a second tab, and all variants are worker-only.
    It stays a later option.
  - A sync engine in Rust: the browser would need it as WASM, and it would be written twice or
    bridged on every call.

#### D12. Backend: a new ASP.NET Core service in this repo

- **Choice.** .NET 10, one deployable API plus one worker process, modules by feature, EF Core
  migrations, OpenAPI as the contract with a generated TypeScript client, ProblemDetails for
  errors, ETag and `If-Match` on single-record writes.
- **Rejected.** A new host in `CashGearERP.sln`: it would inherit hand-run SQL scripts, the
  shared live database with no local copy, and the split service registrations between UnifiedAPI
  and the Blazor host.
- **Trade-off.** Identity and tenancy are built here instead of reused.

#### D13. Database: SQL Server

- **Choice.** SQL Server, a new database, `WorkspaceId` on every tenant-owned row, the tenant
  filter applied in one place (an EF Core global query filter plus a check in the data-access
  layer's tests).
- **Rejected.** PostgreSQL: better JSON and a known Arabic stemmer, but a second engine to host,
  back up and monitor beside the ERP's SQL Server.
- **Rejected.** A database per workspace, as the ERP does per tenant group: thousands of small
  workspaces make that unworkable.
- **Default picked.** Ids are UUIDv7 stored as `binary(16)`, because SQL Server sorts
  `uniqueidentifier` in an order that scatters time-ordered ids. Confirmed in Phase 2.

#### D14. Yjs on the server: a worker and a small Rust library

- **Choice.** The web process never loads a Yjs library. It stores updates as rows and hands them
  back by sequence number. A separate worker process merges, compacts, validates and extracts
  text, through an in-house Rust library over `yrs` whose functions take bytes and return bytes.
- **Fallback.** YDotNet, pinned, in the worker only.
- **Rejected.**
  - YDotNet on the request path: 0.7.0 (2026-11-10) describes itself as early, has no
    update-level merge or diff (so each pull would load a full document in native code inside
    `w3wp`), and its recent fixes include wrong state vectors and process crashes.
  - Hocuspocus or any Node service: no Node in production today.
  - Compaction by clients only: the server cannot trust an uploaded snapshot without parsing it.
  - Ycs (pure .NET Yjs): stale since 2023, no XML types.
- **Decided by** spike S3 (and S4 for the fallback).

#### D15. Document sync by sequence number

- **Choice.** Each page has a gap-free sequence. The server assigns the next number under a lock
  on the page row. Clients pull "updates after N". State vectors are a repair path only.
- **Why.** Yjs updates are idempotent, so redelivery is harmless and the server needs no Yjs code
  to serve a pull. An identity column would let number 11 become visible before 10 commits, and a
  client that moved past it would lose that update for good.

#### D16. Identity: ASP.NET Core Identity and OpenIddict

- **Choice.** Workspace's own accounts in ASP.NET Core Identity. OpenIddict (Apache-2.0) issues
  tokens. The web app uses a `Secure`, `HttpOnly`, `SameSite=Lax` cookie session with antiforgery;
  the desktop app uses authorisation code with PKCE through the system browser, and keeps its
  refresh token in the OS keychain.
- **Rejected.** ERP API keys as Workspace identity: long-lived, kept in `localStorage` by the ERP
  client, and tied to one company. The built-in Identity bearer endpoints: opaque tokens with no
  path to ERP sign-on or social login.
- **Trade-off.** An OpenID Connect server to configure and keep patched.

#### D17. Blob storage: private, short-lived signed URLs

- **Choice.** Azure Blob Storage with private containers only. The API checks permission, then
  issues a user-delegation SAS for one blob: about 5 minutes to read, about 10 to upload.
- **Why.** The ERP's item-image container is public on purpose; Workspace must not repeat that.
  SAS generation does not exist anywhere in the ERP code, so it is built here.
- **Never.** One blob per block, or a public document URL without an explicit share.

#### D18. Version history: full snapshots, restore is a forward edit

- **Choice.** The worker writes a full-state snapshot to Blob Storage on a schedule and when a
  user names a version. Restore applies the difference to the live document as a new edit.
- **Rejected.** Yjs snapshots: they need garbage collection off, and tombstones then grow without
  bound.

#### D19. Order keys: in-house fractional index

- **Choice.** Sibling order is a fractional-index string, implemented here in TypeScript and C#
  with shared test vectors, stored in a binary-collated column, with ties broken by id.
- **Why.** The common npm package is CC0-1.0, which is not on the licence allow-list. Default SQL
  Server collations ignore case and would mis-sort base-62 keys. Two clients inserting between the
  same neighbours can produce the same key.

#### D20. Transport: HTTP first, SignalR later

- **Choice.** HTTP push and pull for autosave and sync in Phases 2 and 3. A SignalR hub in
  Phase 6 that appends to SQL and then relays, and holds no state of its own.
- **Why.** Autosave, sync, conflict handling and real-time editing are four problems with four
  milestones. A stateless hub loses nothing on an app-pool recycle.
- **Open.** Scaling past one node needs Azure SignalR Service or a backplane; decided in Phase 6.

#### D21. Sheet embedding: sandboxed iframe and a message contract

- **Choice.** A new embed route in Cash Gear Sheet, shown in a sandboxed iframe, driven by a
  versioned `postMessage` contract. A workbook is its own document with its own id, storage and
  permissions; a page stores only a reference.
- **Rejected.**
  - Shared React packages: `AppShell.tsx` is a 3,140-line component that creates its own engine,
    reads `localStorage` and sets test hooks on `window`; `@cgs/*` packages are private raw source.
  - Embedding the app as a component: the same coupling, plus a 5 MB WASM engine and two workers
    inside the editor's process.
  - Duplicating the engine: ruled out by the brief.
- **Trade-off.** A second origin to load and a message protocol to version. Work in the Sheet
  repo (Track S) must land first, including cloud workbook storage, which Sheet does not have.

#### D22. ERP blocks: the ERP enforces, Workspace only asks

- **Choice.** Generalise the contract Sheet already uses: a one-time ticket becomes a short
  session scoped to named connectors, each with `Schema`, `Query` and, for editable connectors,
  `Commit`. The browser calls the ERP directly with the session. A page stores the block's
  configuration, never ERP data.
- **Rejected.** Workspace's backend as a proxy holding ERP API keys: it would become a second
  path into ERP transactions with its own copy of the permission rules.
- **Trade-off.** ERP blocks show nothing offline, by design.

#### D23. Toolbar: no ribbon

- **Choice.** A bubble toolbar on selection, a slash menu, and a block handle menu, built from
  `CgFlyout`, `CgMenu` and `CgToolbar`. Components the UI library lacks are added there (Track U).

#### D24. Languages and direction

- **Choice.** i18next with English and Arabic catalogues from the first milestone, `dir` on
  `<html>`, logical CSS throughout. Text blocks have our own `dir` attribute where null means
  "from the first strong character".
- **Rejected.** Tiptap's built-in `textDirection`: it writes `dir` on every node type and has an
  open list-marker bug under `dir="auto"`.

#### D25. Search

- **Choice.** Text is normalised in application code before indexing and before querying: strip
  tashkeel and tatweel, unify alef forms, ya and ta marbuta, fold case. The server indexes the
  normalised text with SQL Server full-text search; the desktop with FTS5; the browser with an
  in-memory index built in a worker.
- **Why.** Search behaves the same online and offline and does not depend on the quality of SQL
  Server's Arabic stemmer, which was not verified.

#### D26. Large pages: no block virtualisation

- **Choice.** `content-visibility: auto` on top-level blocks, plain DOM node views for common
  blocks, React node views only for rare heavy ones, lazy mounting of embeds and database views.
- **Rejected.** Virtualising ProseMirror's content: selection, find, IME and screen readers all
  assume the whole document is in the DOM.

#### D27. AI is optional and outside the editor

- **Choice.** A provider interface on the server, not before Phase 7. AI output is a proposal the
  user accepts into the document. AI never commits to the ERP; it can only prepare a change that
  goes through the same review and commit screen as a person's.

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Package scope and crate prefix | `@cgw/*`, `cgw-*` | Mirrors Sheet's `@cgs/*`, `cgs-*` |
| Product identifier | `com.cashgear.workspace` | Mirrors `com.cashgear.sheet` |
| Desktop targets | Windows first; macOS at the end of Phase 3; Linux later | Sheet ships NSIS only today |
| Document spelling and style | Plain short sentences, British spelling, decision tables | Same as Sheet's docs |
| Block id | 12 characters of base 62, unique within a page | Short in the document, about 71 bits |
| Entity id | UUIDv7, made on the client | Pages can be created offline; ids sort by time |
| Local autosave delay | Updates batched for at most 500 ms | Meets the 1 s durability budget |
| Trash retention | 60 days | Must exceed the longest offline window |
| Longest offline window | 30 days, the refresh token's life | After that the device must sign in again before it syncs |
| Snapshot schedule | After 200 updates or 10 minutes of edits, whichever is first | Bounds the update log and the load time |
| Asset size limit | 25 MB per file in Phase 2 | Raised with quotas later |
| Web hosting | Azure Static Web Apps | As Sheet |
| First ERP connector | Vendors, read-only | The ERP already has its schema and query |
| Browser search index | MiniSearch (MIT), licence and size confirmed in Phase 1 | Small, no server |
| Toggle open state | Kept per device, not in the document | A reader opening a toggle should not edit the page |
| Workspace does not send COEP | No `Cross-Origin-Embedder-Policy` on the web app | It needs no `SharedArrayBuffer`, and COEP would block embeds and remote images |

### Open questions, each with a recommended default

Each is answered in the phase named, in that phase's batch of questions.

| # | Question | Recommended default | Phase |
| --- | --- | --- | --- |
| Q1 | Exact content expression of the block container | Fixed by spike S1 | 0 |
| Q2 | Tiptap's Yjs fork or upstream `y-prosemirror` 1.x | Tiptap's Collaboration extension, behind our seam | 0 |
| Q3 | Rust `yrs` library or YDotNet in the worker | Rust library if S3 passes | 0 |
| Q4 | Does the Sheet embed need cross-origin isolation inside an iframe? | Assume no; spike S9 decides | 0 |
| Q5 | Product domain | `workspace.cashgearerp.com`, API on a sibling host of the same site so the cookie is same-site | 2 |
| Q6 | Where the API is hosted | IIS beside UnifiedAPI, its own site and app pool; revisit for SignalR | 2 |
| Q7 | Does the hosting SQL Server edition have full-text search installed? | Assume yes; fall back to a `LIKE` search on the normalised column for small workspaces | 2 |
| Q8 | Email for sign-up and password reset | SMTP settings from environment, provider chosen by you | 2 |
| Q9 | Who issues Yjs client ids | The server issues a pool per device; local-only ids are registered at first sync | 2 |
| Q10 | Free and paid tiers, storage quotas | No tiers; a quota column per workspace, not enforced | 2 |
| Q11 | Data residency | One region, the storage account's | 2 |
| Q12 | Code signing for the desktop app | Reuse Sheet's signing setup | 1 |
| Q13 | Server-side link previews for bookmarks | Phase 2, behind an SSRF guard; MVP shows the URL only | 2 |
| Q14 | Database formulas: Formualizer on both client and server, or client only with cached values | Cached values with a version; spike in Phase 4 | 4 |
| Q15 | When Sheet gets cloud workbooks (Track S) | Starts during Phase 4 so Phase 5 is not blocked | 4 |
| Q16 | Which ERP entities follow Vendors | Customers, then items on hand | 5 |
| Q17 | SignalR scale-out | Single node until measured; then Azure SignalR Service | 6 |

### Library facts checked on 2026-11-11

Read from registries, repositories and official documents. Nothing was run. Re-check before the
first dependency is added in Phase 0.

| Claim | Source |
| --- | --- |
| `@tiptap/core` 3.33.1 is MIT; `@tiptap/react` supports React 17 to 19 | https://registry.npmjs.org/@tiptap/core/latest , https://registry.npmjs.org/@tiptap/react/latest |
| Drag handle, unique id, file handler, details, table of contents, emoji, mathematics are MIT in the public monorepo | https://github.com/ueberdosis/tiptap/tree/main/packages |
| Collaboration cloud, comments, document history, conversion, pages, AI toolkit remain paid | https://tiptap.dev/pricing |
| Text direction is built into Tiptap's core and adds `dir` to every node type | https://github.com/ueberdosis/tiptap/blob/main/packages/core/src/extensions/textDirection.ts |
| Open: list markers misaligned under `dir="auto"` | https://github.com/ueberdosis/tiptap/issues/7338 |
| Open: UniqueID with Collaboration, ids overwrite each other | https://github.com/ueberdosis/tiptap/issues/8603 |
| Open: UniqueID regenerates ids on internal drag-and-drop | https://github.com/ueberdosis/tiptap/issues/7581 |
| Open: caret stays at the old offset when a peer types in the same paragraph | https://github.com/ueberdosis/tiptap/issues/8611 |
| Collaboration extension depends on `@tiptap/y-tiptap`, on Yjs 13 | https://registry.npmjs.org/@tiptap/extension-collaboration/latest |
| `y-prosemirror` stable is 1.3.7, MIT, Yjs 13 | https://registry.npmjs.org/y-prosemirror |
| The rewrite `@y/prosemirror` 2 is beta on Yjs 14; migration is one-way; unknown nodes are deleted | https://github.com/yjs/y-prosemirror/blob/master/CAVEATS.md , https://github.com/yjs/y-prosemirror/issues/275 |
| Yjs 13.6.33 is MIT; `gc = false` is needed to restore old content; merging updates does not collect garbage | https://registry.npmjs.org/yjs , https://docs.yjs.dev/api/document-updates |
| No move in `yrs`; reorder is remove and insert | https://github.com/y-crdt/ydotnet/blob/main/docs/array-move-deprecation.md |
| Lexical 0.53.0, MIT; three collaboration bindings | https://registry.npmjs.org/lexical/latest , https://lexical.dev/docs/collaboration/react |
| BlockNote core is MPL-2.0; `xl-*` packages are GPL-3.0 or proprietary | https://registry.npmjs.org/@blocknote/core/latest , https://registry.npmjs.org/@blocknote/xl-multi-column/latest |
| `@automerge/prosemirror` 0.2.0 calls itself beta | https://github.com/automerge/automerge-prosemirror |
| `loro-prosemirror` has open content-wipe and per-keystroke cost issues | https://github.com/loro-dev/loro-prosemirror/issues |
| YDotNet 0.7.0, MIT, .NET 10, "still early"; no merge or diff of updates | https://github.com/y-crdt/ydotnet/releases , https://github.com/y-crdt/ydotnet/issues/118 |
| SQL Server full-text has an Arabic word breaker, on Azure SQL too | https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-fulltext-languages-transact-sql |
| rusqlite is MIT and its bundled build enables FTS5 | https://crates.io/crates/rusqlite |
| `tauri-plugin-sql` wraps sqlx and exposes SQL to the webview | https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/Cargo.toml |
| OPFS variants of SQLite WASM and their limits | https://sqlite.org/wasm/doc/trunk/persistence.md |
| `fractional-indexing` 4.0.0 is CC0-1.0 | https://registry.npmjs.org/fractional-indexing/latest |
| Server-ordered last-writer-wins and cycle rejection for tree moves | https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ |
| SignalR scale-out needs Azure SignalR Service or a backplane | https://learn.microsoft.com/en-us/aspnet/core/signalr/scale |
| Formualizer is MIT OR Apache-2.0 | https://crates.io/crates/formualizer |

Not verified, and treated as unknown: Lexical's RTL and table maturity; the quality of SQL
Server's Arabic stemmer; YDotNet's native library loading under IIS; FTS5 in the official SQLite
WASM build.

## 2026-11-11: Phase 0

### Answered by you

| Question | Answer |
| --- | --- |
| Q12. Code signing for the desktop app | Reuse Sheet's setup. The release workflow signs with Azure Artifact Signing, on the same account and certificate profile as Sheet, once the repository variables `CGW_SIGN_ENDPOINT`, `CGW_SIGN_ACCOUNT`, `CGW_SIGN_PROFILE` and the Azure secrets exist; until then it signs with a throwaway certificate and the release notes say so. Phase 0 builds the desktop app unsigned in CI. The release workflow and Workspace's own Tauri updater key come in Phase 1 (M1.9) |
| Q1 to Q4 | Settled by spike results, with the recommended defaults as the hypotheses under test: Q1 and Q2 by S1, Q3 by S3, Q4 by S9. A failed spike is recorded and raised with you, not worked around |
| Pin of `@cashgear/ui` | The full commit hash of the head of `CashGear.React.UI`'s only branch, `claude/cashgear-react-ui-library-xq8tsz`, checked when pinning: `ef1277e78c6151643043fe3327a7f0733307b873`, the same commit Sheet pins. The library has no `main` branch |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| S8 database | A scratch database on `(localdb)\MSSQLLocalDB`, dropped when the spike ends | Never the ERP's database, which is live and shared |
| S9 target | Sheet's deployed web app at `proud-desert-008137810.4.azurestaticapps.net` | `sheet.cashgearerp.com` has no DNS record yet (Sheet's `PROGRESS.md`) |
| .NET for spike harnesses | `net10.0`, built with the installed SDK 11 | D12 names .NET 10, the long-term release |
| CI shape | As Sheet's: licence gates on `ubuntu-latest`, build and test on `windows-latest` | Same runners, same gates, same desktop smoke test |

Further defaults picked while scaffolding (M0.1):

| Choice | Default | Reason |
| --- | --- | --- |
| TypeScript | 6.0.3, as Sheet | 7.0.2 is out, but `typescript-eslint` 8.72.2 supports `typescript <6.1.0` |
| Releases younger than a day | Not taken: pnpm's minimum release age stays on with no exclusions; the previous release is pinned (Vite 8.3.7, Tiptap 3.33.0, `@tiptap/y-tiptap` 3.2.0) | A supply-chain guard; the newer ones can be taken once they age |
| Versions during Phase 0 | `0.0.0` everywhere | From Phase 1 one version is bumped everywhere per release |
| Local ports | Web dev 5273, preview 4273 | Sheet uses 5173 and 4173; both can run at once |
| Desktop CSP `frame-src` | `https://sheet.cashgearerp.com` and Sheet's current Static Web Apps host | ARCHITECTURE.md names the Sheet origin; the custom domain has no DNS record yet |
| Spike dependencies | `devDependencies` of packages under `bench/spikes/` | Spike code never ships; the licence gate still refuses denied licences in them |
