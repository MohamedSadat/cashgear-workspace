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

## 2026-11-11: Phase 0 results

Each spike's result, its evidence (files under `bench/results/` come from a local run; CI uploads
its own), and the decision it confirms or changes. The harnesses are in `bench/` (see its README).

### Spike results

| Spike | Result | Evidence |
| --- | --- | --- |
| S1 Block schema and ids under collaboration | **Pass**, with the schema and binding changed as below. 12 runs of 10,000 operations (2 and 3 clients, 3 seeds, two schemas): all converged, schema valid, no duplicate id after quiescence, no id changed by a move, 291 to 843 deterministic repairs a run. No caret jump when a peer types earlier in the paragraph, in jsdom and in real Chrome and WebView2 (S5) | `bench/results/s1-fuzz-recommended.json`, `s1-scenarios.json`; CI runs 1,500 operations a configuration on every push |
| S1 rejected configurations | Separate node types per text kind under `body* block*`: 9 of 12 runs ended with "Invalid content for node block" (a body after a child block), after which the binding stops syncing that client. Upstream `y-prosemirror` 1.3.7: crashed in 3 of 6 runs (it restores a node selection on a node a peer removed), and rewrites the blocks between a move's ends, losing a peer's typing in blocks nobody moved (185 such losses in three runs) | `bench/results/s1-fuzz-final.json` (`S1_COMPARE=1`) |
| S2 Old client meets a newer document | **Pass.** With the gate the older build opens read-only, pushes nothing, and the update is byte-identical (281 bytes before and after). Without it: Tiptap's binding refuses the unknown node and then silently saves none of the user's edits; upstream deletes the unknown block for everyone | `bench/results/s2-version-gate.json` |
| S3 Yjs on the server, Rust over `yrs` | **Pass.** 1,000 fuzzed documents merged, compacted and diffed by `cgw-ydoc` from .NET 10.0.15 by P/Invoke all load in Yjs 13 with identical XML and ProseMirror JSON; its JSON, text, meta and client ranges match Yjs's. 2,520 calls on 504 malformed inputs: 2,195 refused with an error, 325 decoded as valid updates (bit flips inside text), no panic, no crash. A 1 MB page compacts in 24.8 ms (median); a deliberately fragmented 1 MB history of 34,001 one-character transactions takes 307 ms, where Yjs 13 itself takes 642 ms on the same bytes | `bench/results/s3/dotnet-summary.json`, `verify-summary.json`; `pnpm bench:s3` in CI |
| S4 YDotNet | **Not run**: S3 passed. YDotNet wraps the same `yrs`, so it could not be faster | — |
| S5 RTL and Arabic input | **Pass**: 17 of 17 checks in Chrome 157.0.8103.50 and in WebView2 157.0.4341.42 (paragraph direction, list markers and nesting, table columns, block handle side, arrow keys in RTL, LTR and mixed text, End, a selection across directions, typed Arabic, IME composition, no caret jump, typing after a peer edit) | `bench/results/s5-rtl.json`, `s5-chrome.png`, `s5-webview2.png` |
| S6 Performance | **Fail on one budget, by 1 to 3 ms.** Keystroke to paint at 200 blocks: p95 19.1 ms (Chrome), 17.0 ms (WebView2) against 16 ms. Everything else is met: open 200 blocks p95 46.5 / 34.7 ms (≤ 300), open 2,000 p95 167 / 202 ms (≤ 1 s), keystroke at 5,000 p95 47.5 / 45.5 ms (≤ 50), heap at 5,000 blocks 19.6 MB (≤ 150). The editor's own work per keystroke is 0.5 ms at 200 blocks and 4.5 ms at 5,000; the rest is waiting for the next 60 Hz frame, which alone reaches 16.7 ms. See Q19 | `bench/results/s6-perf.json` |
| S7 Hostile updates | **Pass.** No script ran and nothing unsafe was drawn in Chrome or WebView2 (`javascript:`, `data:`, `vbscript:` links; `on*` and `style` attributes; markup in text; pasted `<script>`, `<iframe>`, `<img onerror>`). `cgw-ydoc` refuses oversized and lying-length input without allocating it, survives 100,000-deep nesting on a 1 MB stack, and flags forged client ids, unknown elements and unsafe link schemes. One gap for Phase 2: an update with an unknown node type makes the client binding stop syncing, so updates must be validated before other clients receive them (Q20) | `bench/results/s7-browser.json`; `crates/cgw-ydoc/src/hostile_tests.rs` |
| S8 Sequence under load | **Pass.** 50 writers, 3,998 updates, 8 readers pulling "after N" with no repair: no reader missed an update, under READ COMMITTED and under READ_COMMITTED_SNAPSHOT. The `IDENTITY` control without the lock lost about 70 % of updates for every reader. On one hot page the lock serialises pushes: p50 0.65 s, p95 0.84 s (READ COMMITTED) and 5.1 s (snapshot) on LocalDB | `bench/results/s8-sequence.json` |
| S9 Sheet in an iframe | **Pass.** From a parent without COEP, Sheet's deployed app draws a real workbook (`formattingBook()`: values, formats, a chart) inside a sandboxed iframe, in Chrome and in WebView2. The frame is not cross-origin isolated and Sheet runs without shared memory ("No shared memory"). From a cross-origin isolated parent the frame is blocked, because Sheet sends `Cross-Origin-Resource-Policy: same-origin` | `bench/results/s9-embed.json`, `s9-*.png` |

### Answers to Q1 to Q4

| Question | Answer |
| --- | --- |
| Q1. Exact content expression of the block container | `block: (body \| block)*` and `doc: block*`. Text kinds are one node, `textBody`, with a `kind` attribute (paragraph, heading, bulleted, numbered and check item, toggle, quote, callout), so "turn into" is an attribute change. The final expressions are in `DATA_MODEL.md` |
| Q2. Tiptap's Yjs fork or upstream `y-prosemirror` 1.x | Tiptap's fork, `@tiptap/y-tiptap`, behind our seam; upstream is rejected. The fork needs two small changes; whether to carry them as a patch is Q18 |
| Q3. Rust `yrs` library or YDotNet in the worker | The Rust library, `crates/cgw-ydoc`. YDotNet is not needed |
| Q4. Does the Sheet embed need cross-origin isolation inside an iframe? | No. Workspace keeps sending no COEP. An isolated parent could not embed Sheet anyway while Sheet sends `CORP: same-origin` |

### Decisions confirmed or changed

- **D3 (block schema), changed.** The container is `(body | block)*`, not "bodies, then children":
  with one node type per kind, a concurrent "turn into" deletes and re-inserts the body, and 9 of
  12 long runs broke `body* block*`. Text kinds become one `textBody` node with a `kind`
  attribute: "turn into" then keeps a peer's concurrent typing, which separate node types lose.
  `body* block*` with the `kind` attribute also passed (12 of 12), but only while no operation
  ever re-creates a body; `(body | block)*` cannot be broken by any interleaving. The first body
  is the block's body; a second one, left by two concurrent conversions, is shown after it. Code
  block, divider, image, file, table, bookmark, child page and the embeds stay node types.
- **D4 (block ids), refined.** The repair rule now reads: the k-th copy takes the hash of `id:k`,
  or of the next `k` whose id is not already in the page. Without that, a later round could repair
  a copy onto an id an earlier round had given. The repair cannot be an `appendTransaction` on the
  remote change: both bindings hold a mutex then and never write it to Yjs (the cause of Tiptap
  UniqueID issue 8603). It is dispatched on its own once the remote change is done. A split keeps
  the children with the original block.
- **D5 (Yjs seam), confirmed, with findings.** The seam held: three bindings ran behind one
  function. Named limits measured: a block moved, merged or deleted while a peer types in it loses
  that typing (Yjs moves are delete and insert), and two concurrent splits of one paragraph
  duplicate the shared tail. Yjs 13.6.33 can leave updates pending after everything they need has
  arrived, depending on order (1 run in 276 at small sizes; `bench/editor/fixtures/yjs-pending-order.json`);
  applying the pending update once more integrates it, so the document layer retries after every
  batch, and only what is still pending after that goes to the repair path.
- **D7 (schema version), confirmed, with a gap.** The read-only gate works. But "a new optional
  attribute does not raise the version" is unsafe with the stock binding: an older client that
  edits a node removes the attribute it does not know. Either the binding keeps unknown attributes
  (Q18) or every attribute addition raises `schemaVersion`.
- **D14 (Yjs on the server), confirmed.** `cgw-ydoc`'s functions are the worker's interface:
  `merge`, `state_vector`, `diff`, `compact`, `to_json`, `to_text`, `meta`, `client_ranges` and
  `validate`, over a C ABI (`cgw_*`) that returns a status and a buffer and never unwinds.
- **D15 (sequence), confirmed.** The gap-free sequence under the page-row lock never let a reader
  skip; an `IDENTITY` column does. A page with many simultaneous writers serialises on its row,
  which Phase 2's push budget and Phase 6's hub must allow for.
- **D21 (Sheet embed), confirmed.** A sandboxed iframe with `allow-scripts allow-same-origin`
  works from a page without COEP. Inside a frame, Sheet's "Open" button (the File System Access
  picker) is unavailable; the embed route gets its bytes from the parent (`source`), as planned.
- **D26 (large pages), confirmed, with a rule.** Plain node views and `content-visibility: auto`
  meet the budgets at 5,000 blocks, but a decoration per block re-made on every change costs about
  95 ms a keystroke at 5,000 blocks: the block handle is one floating element (Track U3), never a
  widget per block.

### Defaults picked

| Choice | Default | Reason |
| --- | --- | --- |
| Pending updates | After applying a batch, re-apply `store.pendingStructs` once; repair-pull only if still pending | The Yjs order bug above; costs nothing when nothing is pending |
| `cgw-ydoc` limits | 64 MB input, nesting depth 200 | Refuse before decoding; real pages nest a few levels |
| Benchmarks in CI | S6 in Chrome on every push, recorded, gated from Phase 1 | The first rows of the benchmark history |

### New open questions, each with a recommended default

| # | Question | Recommended default | Phase |
| --- | --- | --- | --- |
| Q18 | Carry a patch on `@tiptap/y-tiptap` 3.2.0? Two changes, about 40 lines (`bench/editor/vendor/y-tiptap-ids.js` shows them): a node with an id never stands in for a node with another id, and equal ids anchor the diff, which stops a move or merge from losing a peer's typing in blocks it did not touch; and attributes the schema does not know are kept, not removed (S2). Measured cost: 4.5 ms a keystroke at 5,000 blocks against 2.4 ms stock | Yes: a `pnpm patch` on the pinned version, offered upstream, with S1's fuzz as its test. The alternative is to accept those losses and raise `schemaVersion` for every attribute | 1 |
| Q19 | The keystroke budget at 200 blocks (p95 ≤ 16 ms keystroke to paint) is missed by 1 to 3 ms, almost all of it waiting for the next frame | Redefine it as two budgets: the editor's work per keystroke p95 ≤ 8 ms, and keystroke to the frame after paint p95 ≤ 33 ms (two frames). Keep 50 ms at 5,000 blocks | 1 |
| Q20 | When the worker validates pushed updates (S7) | Before other clients receive them: the push path holds a page's new updates as unvalidated until the worker passes them, and refuses the push if they fail | 2 |

## 2026-11-11: Phase 1

### Answered by you

| Question | Answer |
| --- | --- |
| The MVP's block list | As planned: paragraph, headings 1 to 3, bulleted, numbered and check items, toggle, quote, callout, divider, code block, table, image, file, bookmark and child page. A bookmark shows its URL only (previews are Q13, Phase 2). Sheet, ERP and database blocks are absent until Phases 4 and 5 |
| Export format in the MVP | A zip: one Markdown and one JSON file per page, in folders that follow the tree, an `assets` folder and a manifest of ids. Import reads the same zip |
| Desktop file association and deep-link scheme | `cashgear-workspace://`, no file type |
| First-run content | One "Getting started" page in each language |
| Track U | Local stand-ins behind the props the Track U component will have, each listed in `PROGRESS.md`. `CashGear.React.UI` is not changed in this phase |
| Q18. Patch `@tiptap/y-tiptap`? | Yes. A `pnpm patch` on the pinned version: a node with an id never stands in for a node with another id, equal ids anchor the diff, and attributes the schema does not know are kept. S1's fuzz is its test. The upstream issue and pull request are drafted for you to send; nothing is posted from here |
| Q19. The keystroke budget at 200 blocks | Two budgets: the editor's work per keystroke p95 ≤ 8 ms, and keystroke to the next frame p95 ≤ 33 ms. The 5,000-block budget stays p95 ≤ 50 ms |
| Workspace's Tauri updater key | Made here with `tauri signer generate` and a random password, piped straight into the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; never written to disk or shown. Only the public key is committed. A `v*` tag drafts a GitHub release, which you publish |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Versions taken | Tiptap 3.33.1 and `@tiptap/y-tiptap` 3.3.0, once a day old (14:01 UTC today); Vite stays on 8.3.7 (8.3.8 is under a day old) | pnpm's release-age guard stays on. y-tiptap 3.3.0 changes only the cursor plugin, so the Q18 patch applies unchanged |
| The patch | `scripts/y-tiptap-patch.mjs` writes it into `pnpm patch`'s copy and refuses to run unless each of its five changes matches exactly once | A new upstream release that moved the code fails loudly instead of shipping half a patch |
| Two schema additions in version 1 | `hardBreak` (Shift+Enter in a text body) and a `colour` attribute on `textBody` (block colour from the block menu, a theme token) | Both were needed by the MVP's editor; added before any document exists, so no version change |
| Ids on blocks a command creates | Minted in the creating transaction (split, insert, slash commands); the id plugin still mints for anything left without one (paste, duplicate) | An id set by an appended transaction re-renders the block while the next key is typed. D4 allows minting in local transactions |
| Atom node views | Plain DOM for images, files, bookmarks, child pages, code blocks and tables, not React (ARCHITECTURE.md updated) | Each is small; the editor needs no React renderer; menus and toolbars over it are React |
| Typing just after a structural change | For two frames after a block is created or the caret enters another top-level block, typed characters are inserted by the editor (`beforeinput`), not the browser | `content-visibility: auto` (D26) can leave a new block unlaid-out; the browser then put the first character at its start |
| Theme and language preferences | In `localStorage` (`cgw-theme`, `cgw-language`), as Sheet does; toggle state and tree state in the local store's preferences | Applied before first paint; neither is a credential |
| The desktop store's boundary | One typed command, `store`, taking one of a fixed set of requests (load a page's log, append updates, apply a plan, search, ...) in a binary frame: a JSON header and raw byte blobs. Saving a file is its own command, which opens the system's save dialog itself | No SQL and no path ever come from the webview (ARCHITECTURE.md, Tauri); bytes stay bytes |
| Planning operations on the desktop | Against the store's in-memory mirror in TypeScript, then written by SQLite in one transaction | One planner and one set of tree rules for both stores; the desktop app runs as one instance |
| Desktop data folder | The app's data folder (`%APPDATA%\com.cashgear.workspace`); `CGW_DATA_DIR` overrides it at start, for tests | Tests never touch a person's own pages |
| SQLite durability | WAL with `synchronous = NORMAL` | Survives a killed process, which the kill test checks; a power cut may lose the last write |
| Export format | `cgw-export.json` (format `cash-gear-workspace-export`, version 1) with the workspace, sections, pages and assets; per page `Title.md` and `Title.json` (the ProseMirror JSON) in folders that follow the tree; `assets/{id}/{name}`. Import makes a new workspace with new page, section and asset ids, and keeps block ids | A workspace imported on the same device does not collide with the original |
| Browser storage | `navigator.storage.persist()` at start; if refused, a notice once per device says the browser may clear pages and points to the export | SYNC_DESIGN.md |
| Kill test | `scripts/kill-test.mjs`: types random English and Arabic words, pauses at random, kills the whole process tree at a random moment, reopens, checks the reopened text starts with what was last reported saved and is a prefix of what was typed. 25 runs a target in CI, 1,000 locally for the exit criterion | The guarantee is "what the page reported saved"; the check also times saves after the last key |
| Initial JavaScript | The editor, Tiptap, Yjs and the document layer load in their own chunks after the frame paints (about 133 kB gzip before them) | ARCHITECTURE.md: ≤ 350 kB before the editor loads |
| Browser search index | MiniSearch 7.2.0 (MIT, 7 kB gzip) in a worker, built from the IndexedDB `search` store when the store opens and kept current by the store as it writes entries; pages in the trash are dropped when results are read | Searching never blocks the page; the index needs no copy of its own on disk |
| Search matching | Every query word must match the start of a word, in the title or the text; titles rank first. Both stores take text normalised by `normaliseText` (search vectors) | The same query finds the same pages in the browser and on the desktop |
| Deep links | `cashgear-workspace://p/{pageId}[/{blockId}]`, `://trash`, `://settings`, `://` alone; read by `crates/cgw-native`, which refuses anything else (a query, a fragment, an id of the wrong shape), so a link can only choose a route. A link the app started with waits until the page asks for it | A link from a browser or a mail is outside input |
| One instance | Per data folder: a second start brings the window forward and hands its link to the first (`tauri-plugin-single-instance` with deep links). Skipped when `CGW_DATA_DIR` is set, so tests run beside an installed app | One process owns the SQLite store |
| Updates | As Sheet: the feed is checked 10 s after start and every six hours; a newer version shows as "Update to x" in the top bar, and Settings can check at once. Pending saves are written before the installer closes the app. `tauri-plugin-updater` with native TLS | The cdla-licensed root certificates of the default TLS fail the licence gate |
| The updater's key | Made once by `scripts/updater-key.mjs`: the private key and a random password go from the Tauri CLI into the repo's secrets through `gh secret set`'s standard input, never to disk or the screen; the public key is in `tauri.conf.json` | Q answered today: "I make it into secrets" |
| Release | `.github/workflows/release.yml` and the scripts behind it are Sheet's, renamed: release check, installer test (install, deep links, update, uninstall of a throwaway product with its own scheme), Azure Artifact Signing when `CGW_SIGN_*` is set, else a throwaway certificate said so in the notes; the release is drafted, and publishing it is the person's step | As Sheet does |
| Narrow screens | Below 768 px the sidebar is `@cashgear/ui`'s `CgDrawer` over the page (shading, Escape, a tap outside, closed when a page opens, the page behind it inert, focus kept in it and given back); on a narrow or touch screen a toolbar above the keyboard inserts, formats, and moves blocks up, down, in and out | Phones have no hover and no Alt+Shift+arrows |
| A new page | Starts with focus in its title, from the button, the row menu or a key | The keyboard pass found focus lost to the page body |
| Start-up | With no page in the address, the last page visited opens | The desktop window has no address; the cold-start budget is to an editable page |
| The palette | Loads with the frame, not lazily (3 kB) | Keys typed straight after Ctrl+K were lost while its chunk loaded |
| Contrast | Inline code, orange and yellow text darker in the light theme, red lighter in the dark one; the page header's buttons hidden rather than faded until hover or focus; the chosen palette row's detail in the text colour | Axe found each below 4.5:1 |
| Two Track U stand-ins in CSS and an effect | `@cashgear/ui`'s primary button keeps white text on the dark theme's light accent (2.5:1): dark text there, as its own dialog actions do. `CgSplitter` names its separator with an English template: the frame sets the name from the catalogue | Listed in PROGRESS.md; CashGear.React.UI is not changed from here |
| Accessibility checks | `@axe-core/playwright` 4.14.0 (MPL-2.0, a test tool only, not shipped) on the main screens in both themes and languages and on a phone-sized screen; a keyboard-only e2e pass; the accessibility tree checked for named landmarks, tree and editor | The licence gate allows MPL for tools |
| Theme screenshots | Each theme's screenshot is read back pixel by pixel: page, sidebar and top bar in that theme's own colours, title contrast above 7:1, the two themes differing almost everywhere. No pixel baselines | CI's fonts render a little differently from a desktop's |
| Budget gate | `bench/phase1.mjs` in CI after the kill tests: over budget fails; so does worse than the last successful run on `main` by half again and by more than a small margin per figure. The last run's figures come from its uploaded results | Hosted runners are noisy; a margin keeps the gate from flapping |

## 2026-11-12: Phase 2

### Answered by you

| Question | Answer |
| --- | --- |
| Q5. Product domain | Sibling hosts: the web app at `workspace.cashgearerp.com`, the API at `workspace-api.cashgearerp.com`. Same site, so the web session is a `Secure`, `HttpOnly`, `SameSite=Lax` cookie and no token is ever in JavaScript |
| Q6. Where the API is hosted | IIS beside UnifiedAPI: its own site and app pool; the worker as a Windows service on the same server. Revisited for SignalR in Phase 6 |
| Deployment | I build, you deploy. The phase ships the deploy package, the migration bundle, scripts and a runbook, rehearsed end to end on a local scratch environment (LocalDB and Azurite). You run the real deployment; "Deployed" is ticked once you have |
| Q11. Data residency | One region, the same as the Cash Gear ERP's Azure Storage account. No replication to a second region |
| Q7. Full-text search on the host | Use SQL Server full-text over the normalised text when the server has it (detected at start); otherwise a `LIKE` search on the normalised column |
| Q8. Email | SMTP settings from environment variables; the provider is chosen at deploy time. In development and tests mail is written to a pickup folder |
| Q9. Who issues Yjs client ids | The server issues a pool per device; ids a local-only workspace already used are registered at its first sync. The worker refuses structs from ids not registered to the pushing user |
| Q10. Tiers and quotas | No tiers. A storage quota column per workspace, recorded and shown, not enforced |
| Q13. Link previews | Yes, in Phase 2, fetched by the server behind an SSRF guard (public addresses only, no redirect into a private range, size and time limits). A bookmark still shows its URL when there is no preview |
| Q20. When the worker validates pushed updates | Before fan-out. Pushed updates are held as unvalidated until the worker passes them with `cgw-ydoc`; pulls by other clients return only validated ones. A failing update is refused and its pusher told |
| Who may sign up | Anyone, with the email confirmed before the first sign-in. Rate-limited, with lockout after repeated failed sign-ins |

### Defaults picked (say if any should change)

M2.1 and M2.2, the server and accounts:

| Choice | Default | Reason |
| --- | --- | --- |
| Server layout | `server/Cgw.Server.slnx`: `Cgw.Core` (data, tenancy, blob, mail, audit), `Cgw.Api`, `Cgw.Ydoc` (P/Invoke), `Cgw.Worker`, `tests/Cgw.Tests`; .NET 10 | Only the worker references `Cgw.Ydoc`; a test walks the API's references and its build output (D14) |
| Test databases | LocalDB locally, which has no full-text search (the `LIKE` path); in CI SQL Server 2022 in a container with `mssql-server-fts` (the full-text path), on Ubuntu. One scratch database per run, dropped at the end; tests stay apart by working in workspaces of their own | The reference machine has no Docker; CI covers both search paths |
| Ids | UUIDv7 as `binary(16)` in RFC byte order, by one EF Core value converter for every `Guid` (D13 confirmed) | Time order is index order |
| Test framework | xUnit v3 (Apache-2.0) with its own asserts, on Microsoft.Testing.Platform (root `global.json`) | FluentAssertions is no longer open source |
| NuGet licence gate | `scripts/check-nuget-licenses.mjs` against `license-policy.json`, in `pnpm check`, CI and the self-test. Three named exceptions: Apache.Arrow (Apache-2.0, named by its licence file), and Microsoft.Data.SqlClient.SNI.runtime and Microsoft.Identity.Client.NativeInterop (Microsoft redistributables that SqlClient brings) | npm and cargo had gates; NuGet needed its own. None of the three is copyleft |
| Blob storage in development and tests | Azurite 3.37.0 (MIT), a root dev dependency, always run with `--disableTelemetry` | It collects telemetry unless told not to |
| Signed URLs | A user-delegation SAS from an Azure AD credential (`DefaultAzureCredential`: managed identity or a service principal from the environment) in production; a service SAS from the account key when a connection string is configured (Azurite) | Azurite has no Azure AD; production never holds an account key |
| Sign-in pages | Served by the API on its own origin: sign in, sign up, confirm, forgot, reset; English and Arabic (`lang`, else `Accept-Language`), light and dark by the system; antiforgery tokens in every form; a strict CSP | Passwords are typed only on the API's pages, never into the app or its webview (RFC 8252) |
| The web session | Identity's cookie `cgw_session`, 14 days sliding; each sign-in makes a device row, carried as a claim and checked on every request (cached 15 s, cleared at once on the server that revokes it); writes need `X-CSRF-TOKEN` from `GET /api/v1/account/antiforgery`; return addresses only to the web app's origins or `/connect/authorize` | Signing a device out ends that session; no open redirect |
| The desktop's sign-in | Authorisation code with PKCE in the system browser, back to a loopback listener on a port the app picks (RFC 8252, 7.3; the port is not compared, everything else is), not the deep link. The native side exchanges and refreshes the tokens; the refresh token is in the OS keychain and never reaches the webview | Another app can claim a URI scheme, not the app's own loopback port |
| Tokens | Access tokens 15 minutes, refresh tokens 30 days and rolled on use; one permanent OpenIddict authorisation per desktop device, revoked with it; authorisation and token entry validation on, so a revoked device's tokens stop at once. Production certificates come from `LocalMachine\My` by thumbprint (`OpenIddict__SigningCertificateThumbprint`, `__EncryptionCertificateThumbprint`); ephemeral keys elsewhere | No key in a file or the repo |
| Passwords and lockout | At least 10 characters, no composition rules (NIST SP 800-63B); 5 failures lock the account for 15 minutes; a reset signs every device out | |
| Account enumeration | Signing up with a taken address answers as for a new one and mails the owner instead; "forgot" always answers the same | Answers never say whether an address has an account |
| Data Protection keys | In the database (`DataProtectionKeys`), protected with DPAPI on Windows hosts (`DataProtection__Dpapi=true`) | Every instance and every restart reads the same keys |
| Links in mails | Built from `Api__PublicUrl`, required in production | A link built from the Host header can be pointed elsewhere by whoever sent the request |
| Rate limits | Per minute: anonymous routes 120 per IP, sign-in 20 per IP, 1,200 per user, pushes 600, search 240, previews 60; set by `RateLimits__*` (a load test raises them) | |

After the separate review of M2.2 (2026-11-12; what changed from the rows above):

| Choice | Default | Reason |
| --- | --- | --- |
| Confirming a desktop sign-in | A signed-in browser at `/connect/authorize` sees "Sign in the Cash Gear Workspace desktop app on this computer as {email}?" and the code is issued only on that form's POST (antiforgery); Cancel answers `access_denied`; `prompt=none` gets `consent_required` | Without it, any link could have a signed-in browser hand a code to a listener of the sender's (RFC 8252, 8.6) |
| Lockout and tokens | The token endpoint no longer refuses a locked-out account: lockout slows password guessing and signs nobody out | Five wrong passwords, by anyone, signed every desktop of the account out |
| Answers that could tell an address has an account | Sign-up checks the name, email and password before looking the address up; an unconfirmed account hears "confirm your email" only with the right password (a wrong one counts towards lockout); a locked account hears the generic answer, which says for everyone that repeated wrong tries pause signing in for 15 minutes; every failed sign-in costs one password check; account mail is queued and sent off the request | "Answers never say whether an address has an account" holds for timing too |
| Joining a workspace | Only by invitation: `POST /workspaces/{id}/members` is gone; an invite answers the same whether the address has an account or not | Adding by address told whether it had an account, and put people in workspaces without asking them |
| Confirmation and reset links | Opening a confirmation link shows a Confirm button (a POST); "forgot" also mails unconfirmed accounts and a reset confirms the address; reset links last 1 hour (confirmation 24); neither mail carries a display name someone else chose | A mail scanner opening a link confirms nothing; an address someone signed up first can be taken back |
| Mail | One account mail per address every 2 minutes (`Mail__CooldownSeconds`); invites are not throttled (their token would be lost) | No mail floods from the API's domain |
| The device claim | Kept across Identity's security-stamp refresh (`OnRefreshingPrincipal` copies the claims the sign-in added) | Web sessions ended a minute after sign-in |
| `/connect/logout` | POST with antiforgery, rate-limited, signs the device out | A GET could sign anyone out from another site, and left the device signed in |
| Cookies | `__Host-cgw_session` and `__Host-cgw_xsrf` outside development; plain names over http on 127.0.0.1 | A sibling host of the same site cannot plant either |
| Development shortcuts | Explicit settings (`Api__AllowHttp`, `OpenIddict__EphemeralKeys`, `Api__PublicUrlFromRequest`), refused in Production, which also refuses to start without `Web__Origins`, an https `Api__PublicUrl` and DPAPI; certificates past their date are refused at start | Nothing fails open because an environment name or a setting is missing |
| Rate limits | `/connect/token` has its own bucket (120 a minute per IP); `/connect/revoke` and logout are limited | Desktops behind one address no longer share the sign-in forms' 20 |
| Deleting an account | On the API's own page, after the password again (`/account/delete`); the JSON route is gone. The app's settings link there | A stolen session alone cannot delete an account; passwords stay on the API's pages |

M2.3 to M2.5, metadata sync, documents and assets:

| Choice | Default | Reason |
| --- | --- | --- |
| Serialising a workspace's writes | Every operation takes the workspace row's lock first (the change feed's sequence is given out under it), then the page rows; the worker and the push path take them in the same order | Changes commit in sequence order, so a reader never passes one still being written; the tree rules (no cycles) cannot race; no deadlock between writers |
| Operations on the server | `OpsService` ports `planOps`' rules to C#, each operation in its own transaction with its `AppliedOps` row; the answer carries the entity as the server holds it (and a `notice`, such as `tree.parentMissing`) | The client's mirror takes the server's entity; a refused move, trash, restore or delete resyncs that subtree from the server |
| The change feed | Several changes to one entity in a page of the feed are sent once, as the last; an entity the caller may not see is a `delete`; member changes write `grant` or `revoke` events naming the workspace, and the client refetches the tree | A delete reveals only a random id; the client never keeps what it lost access to |
| Upload of a local workspace | `POST /workspaces` with the local id, then each page's log merged into one update (its Yjs client ids registered), then the workspace's records as creates in the outbox, parents first, trash roots deepest first, favourites last; the sync loop sends the rest. Operations and updates written while it is prepared (the first-run pages of a workspace made while signed in, keys typed meanwhile) are kept and sent after it, in the same store transaction | The ids, the tree, the trash and the documents arrive intact, and an interrupted upload resumes from the outbox |
| Local store schema 2 | Additive in IndexedDB (indexes on the outbox, `syncCursors`, `docCursors`, `unsentPages`); in SQLite a copy of the file first (`workspace.v1.db`), then the migration in a transaction. Remote batches and answers are planned by shared code (`planRemote`, `planSettle`) and written as plans, as local operations are | Both stores keep the same rules (the conformance suite runs 33 cases on each) |
| Validation before fan-out (Q20) | A push stores updates as pending; the worker validates them in sequence order (each update's Yjs client ids against the pusher's, then the batch merged once, falling back to one at a time), refuses what fails, and moves the page's validated head. Pulls serve valid updates up to that head; the pusher's next pull lists its refused ones. The worker polls every 100 ms | One hostile update can no longer reach peers (S7); a second device sees an edit within a pass of its poll |
| What the worker checks | The update decodes; its structs are written as ids registered to the pusher; the document keeps only the schema version's elements, block ids of 12 base-62 characters, attributes that are plain values and safe link schemes; `meta.pageId` stays the page's and `meta.schemaVersion` no higher than the page's; at most 10 MB. Unknown attributes are not judged: clients keep them (Q18) and draw them inert (S7) | The element lists are shared with the editor (`packages/doc/vectors/schema-elements.json`) |
| Yjs client ids | Pools of 8 per device per workspace, refilled under 4; a session takes one at random from the pool (two tabs starting together rarely pick the same); without a pool a random id, registered at its first push. An id another user holds is refused, and updates written with it are set aside | Q9 |
| Pull answers | `cursor` (the next `after`) and `more`, at most 1,000 updates; a snapshot by signed URL when rows before `after` were compacted away | Bounded answers; the client never skips a row |
| Compaction | After 200 decided updates or 10 minutes; the old snapshot's blob deleted after the commit; one compactor per page under `sp_getapplock` | Proven by killing it after the blob and after the commit |
| An epoch change on the client (Phase 2's part) | Unsent updates are set aside in the store's corrupt area, the page's log is replaced by an empty update marked sent, and the page is pulled from the start; the user is told. The recovered page is Phase 3 (M3.3) | Nothing typed is thrown away |
| Assets | Any member gets an upload ticket (a SAS that creates one blob, 10 minutes); the worker sniffs the first 64 kB against the declared type and reads image sizes; a mismatch is quarantined. Raster images (PNG, JPEG, GIF, WebP) are served inline as their type; everything else, SVG included, as an `attachment` with `application/octet-stream`. 25 MB. Reading needs the uploader, or read access to a page that shows it in its content or as its cover. An asset nothing refers to for 30 days is deleted; storage used per workspace is recorded | ARCHITECTURE.md, Upload safety |
| Link previews (Q13) | Title, description, site name and image, per workspace and URL, kept 7 days; the image stored as a workspace asset. The guard: http and https on 80 and 443 only, DNS resolved once and the connection pinned to the checked address, every redirect (at most three) checked again, private, loopback, link-local, CGNAT, multicast, reserved, NAT64, 6to4 and Teredo ranges refused, 5 s and 1 MB | No request reaches an internal address |

M2.6 to M2.8, sharing, search, history and operations:

| Choice | Default | Reason |
| --- | --- | --- |
| Access lists | Set by `PUT /pages/{id}/permissions` (full access); `GET` sends the page's version as an `ETag` and `PUT` takes `If-Match` (409 `version.conflict` when stale); a `PUT` that changes nothing writes nothing. Entries name members or the whole workspace; a page in a private section takes none | Two people editing the list cannot overwrite each other unseen |
| Access changes in the feed | One `access` change per edit of a list, rooted at the page: `revoke` when anyone could lose access, else `grant`; the client refetches that subtree | A client drops what it lost at once, and nothing is revealed by the event itself |
| Share links | View only; 32 random bytes, stored as their SHA-256; 1 to 365 days (30 by default); shown once when made; revocable, and repeating a revoke is harmless. A link reads its page and the pages under it, except restricted pages and everything under them, and trashed pages; a page in a private section or in the trash gets none. Read with the `X-Share-Token` header on `/api/v1/shared/*`, rate-limited per IP; an unknown, revoked or expired link answers 404 like a missing page. Made and revoked links are audited | The token never sits in a URL a server logs; a link cannot widen what its creator restricted |
| Server search | One query over the normalised title and text (`SearchTitle`, `PageDocDerived.SearchText`), full-text with `CONTAINS` where installed (catalogue `cgw_search`, language neutral, no stop list), else `LIKE`; hits the caller may not read are dropped before answering (access worked out once per search for the whole workspace, scanning further rounds to fill the page); at most 8 terms, 20 hits by default and 50 at most, with a cursor; the score is 1 plus the share of terms in the title; the snippet from the first 20,000 characters of the text | Q7; Arabic and English alike, since the text is normalised the same way as on the client |
| History | An automatic version after an hour of activity on a page; all kept 30 days, then one a day; named and `preRestore` versions for ever. A named version is written by the worker within a second | SYNC_DESIGN.md, Version history |
| Hard restore | Owners and admins; a command the worker carries out (202), after keeping the live state as a `preRestore` version; sequences keep rising across epochs; the epoch is read from the page, not from the document's `meta` | It can be undone, and no sequence number is ever reused |
| Export from the server | Owners and admins; the pages the requester may read (their own private section included, not others'); a zip of Markdown and JSON per page with its files, kept 7 days, read by its requester only; asking again while one is being made returns that one. The Markdown is the server's own writer, held to the client's by 15 shared vectors | Same layout as the local export (Phase 1) |
| Deletion and purges | A page deleted for good is a tombstone; its document, versions and blobs are purged within the minute. A deleted workspace is purged after 30 days; its audit rows stay. Account deletion as in DATA_MODEL.md | The audit log is append-only |
| Reconcile | Every 6 hours: a row without its blob is undeleted from Blob soft delete first; else a snapshot row is dropped and an asset marked missing; a blob with no row is deleted once a day old; every "missing" is checked again first | A blob written just before its row is not taken for an orphan |
| Trash retention | Pages in the trash are not yet removed after 60 days; the 60 days and the offline window are Phase 3's questions | Asked in Phase 3 |

After the separate review of M2.6 (2026-11-12; what changed from the rows above):

| Choice | Default | Reason |
| --- | --- | --- |
| A page leaving the ancestor that decided its access | Needs `full`; the page keeps its access (`Restricted`, the chain's rows copied). A restore or create that falls back to the top of the section does the same; the actor gets a `full` row only when the copied rows would leave them none. An open page moved under a restricted one also needs `full` and stays open (`Restricted` with `workspace: edit`) | A move could open a restricted subtree to every member; a fallback could too, with no one meaning it |
| Shared and private sections | Moving pages between them needs `full` on every page moved | A member could move a shared page into their private section and take its restricted pages with it, out of everyone else's sight |
| Deleting for good | `full` on every page of the subtree; trash is unchanged, since it can be undone | Restricted pages under a page should not go for good by someone who cannot see them |
| Invitations | A used invitation works again only while its person is a member; removing a member voids their waiting invitations and their rows; the token travels in the body (`POST /invites/accept`) | A removed admin could rejoin with the mail they kept; tokens stay out of request logs |
| Share links | Skip pages hidden from the workspace as well as restricted ones; serve the worker's JSON, not Yjs updates | A link showed pages members could not open, and served text deleted moments before |
| The directory | Guests see themselves and the people named on pages they can see, no addresses but their own, only sections with a page they can see, no other member's changes; access lists are shown to `full` only | "A guest sees only pages shared with them by name" |
| The search cursor | Sealed by Data Protection to the user and the workspace | It carried the ids of pages the caller could not read |
| The worker's check | Refuses an update whose author cannot edit the page any more when it decides (audited `doc.accessDenied`) | A push checked just before a revoke could still land |
| Exports | Read only while the requester is an owner or admin | A demoted admin kept the workspace's zip for 7 days |
| Covers | A cover is taken only from a file its setter may read. Content may still name any of the workspace's files by id: someone who can edit a page and knows a file's id (noted while they had access) can make it readable through that page; accepted until files are tied to the page they were uploaded for | A cover made any file readable through any page |
| Existence | Inside a workspace, the level is checked first and anything unseen is 404. Across workspaces, four answers still tell an id exists (a page, an asset, a workspace, an update id); each needs a random id from another workspace; accepted | |
| Account deletion | One transaction under every workspace lock it touches, the only-owner rule checked under them | Two owners deleting at once could leave a workspace with members and no owner |

The client side (shell, desktop sign-in, the server stack for development):

| Choice | Default | Reason |
| --- | --- | --- |
| Where the cloud lives in the app | `packages/shell/src/cloud`: one `Cloud` per app, made after the local session opens; signed out, the app is Phase 1's. The sync engine stays in `@cgw/workspace` and reaches the server only through `SyncApi`; the editor still never does | The layering of D2 holds: the editor is given an `EditorHost`, the workspace layer a typed API |
| The API in development | `http://127.0.0.1:5280`, the web app on `127.0.0.1` too (5273 dev, 4273 preview); `VITE_CGW_API` at build time names another | `localhost` and `127.0.0.1` are different sites for the session cookie |
| Signing in on the web | The whole page goes to the API's sign-in page and comes back by `returnUrl`; at start the app asks `GET /account/session`, which answers 200 signed in or not | Passwords are typed only on the API's pages; no 401 in the console of a signed-out start |
| Signing in on the desktop | The API bases a build may talk to are fixed when it is built (`CGW_API_BASES`, else production and loopback development); the refresh token is in Windows Credential Manager under `com.cashgear.workspace`, split across entries above 2,560 bytes; tests use `CGW_KEYCHAIN_SERVICE` (a name starting with the real one) and `CGW_AUTH_URL_FILE` | A compromised page cannot send a token elsewhere; tests never touch the person's own sign-in |
| Remote changes to an open page | Applied with the `REMOTE` origin, so they are neither saved again as local edits nor sent back; each session writes with a Yjs client id from the device's pool | A device never re-sends what it pulled; ids stay the server's to give (Q9) |
| Upload of a local workspace | Offered, not automatic: a banner on a local-only workspace once signed in. A workspace made while signed in is uploaded at once | Moving data off the device is the person's choice |
| The sync status | One label in the sidebar (on this device only, synced, syncing, offline with changes waiting, signed out, paused and retrying), its text set on the DOM node, not by React | Nothing React-rendered changes per keystroke (Phase 1 gotcha) |
| Search in the palette | Local results at once; the server's added when they answer, after the local ones, without pages already listed or not in this device's tree | Typing stays as fast as Phase 1; the server fills in pages this device holds no text for |
| A share link in the app | `#/s/<token>` on the web app; the page is read as the worker's JSON with the token in an `X-Share-Token` header, signed out, read-only (a page the worker has not derived yet is retried for a few seconds) | The fragment never reaches a server log; the token never sits in a query string |
| Images and files from the server | Read by a fresh signed URL when shown and kept in the local store, marked as uploaded | An image opened once shows offline |
| The development stack | `scripts/server-stack.mjs` (`pnpm dev:server`): Azurite, the API and the worker from their build output, on LocalDB; mail to a pickup folder. Playwright starts it with `--e2e` on a fresh database with raised rate limits | One command for a working server; e2e never shares state with a developer's database |

## 2026-11-12: Phase 3

### Answered by you

| Question | Answer |
| --- | --- |
| Trash retention and the longest offline window | 60 and 30 days. The server purges pages that have been in the trash for 60 days (as a permanent delete, leaving the tombstone), and a device-only workspace purges its own trash the same way. A device may sync after up to 30 days offline: the desktop's refresh token already lasts 30 days, and the web session goes from 14 to 30 days, sliding, to match. Past that the device signs in again before it syncs; nothing on it is lost |
| What "pin for offline" covers | A page, or a page and its subtree. Pages added later under a pinned subtree are fetched too; pinned pages are refreshed in the background, and the storage they use is shown. Pages a person opens are cached anyway; there is no "whole workspace" pin |
| macOS signing, notarisation and proof | A universal app built on GitHub's macOS runner, signed with a Developer ID certificate and notarised from repository secrets you add; until they exist it is ad-hoc signed and the release notes say Gatekeeper will warn. The runner installs it and drives it through a test-only bridge that is compiled into test builds only, never a release: start, offline edits, a new page, the keychain, the deep link, the update. Sign-in and sync on macOS run against your deployed API with a CI test account once it is up; until then that step is yours, like Phase 2's "Deployed" |
| Items Phase 2 left open | Two taken on. The worker's lock waits are fixed in M3.2, and a new budget is gated: an edit reaches other people's pulls within 5 s at p95 with 200 people typing (26 to 65 s at the end of Phase 2). The server's workspace export gets a button in Settings for owners and admins, beside the local export. Not taken: tying files to the page they were uploaded for; the risk stays accepted as recorded on 2026-11-12 (Phase 2, after the M2.6 review) |

### Defaults picked (say if any should change)

M3.2, the robust sync loop and the worker's lag:

| Choice | Default | Reason |
| --- | --- | --- |
| Reads on the server | The database runs with `READ_COMMITTED_SNAPSHOT ON` (migration `ReadCommittedSnapshot`; `OFF` undoes it). Writers that check and then write still do so under the lock they always took: the workspace row's, or a page's sequence lock | Readers waiting on writers' locks were the largest wait under the 200-person load test (1,961 s in a run). The change feed's guarantee holds: changes are numbered and committed in order under the workspace lock, so what has committed is always a prefix |
| Numbering a page's updates | A push takes the page's sequence lock (`sp_getapplock docseq:{page}`) to the end of its transaction instead of holding the page row; every writer of `DocSeq` takes it (push, hard restore) | Numbers stay gap-free and commit in order (D15, S8) while the worker's head update no longer queues behind four typists' pushes |
| Validation | Decided with nothing locked, a workspace's pages together, then written in one short transaction per workspace; access is checked again under the lock only if an access, member or workspace change committed since it was read; validation runs on a loop of its own, 8 workspaces at a time | An edit reaches other people's pulls at p95 2.2 s with 200 people typing (59 s before, measured the same way); gated at 5 s in `bench/phase2.mjs` |
| What a pushed update is judged by | What it adds over the worker's state (`diff` against its state vector): only new structs must be written as the pusher's Yjs client ids | A repair re-sends the device's whole state, other people's structs included, and must not be taken for a forgery; one adding structs under someone else's id still is |
| Retry-After | The rate limiter's lease; until the next minute for the per-page push limit; 60 s for any other 429 and 30 s for a 503 | The client waits at least that long, whatever kicks it |
| Retention jobs | Change feed: rows older than 90 days, 2,000 a transaction, every 10 minutes, with `Workspaces.ChangesPrunedSeq`; an older cursor gets 410 `feed.expired`. Trash: roots in the trash for 60 days, deleted for good through the same path as a person's delete, audited `page.purgedByRetention` | The plan's 90 days; the answer's 60 |
| Index for pinned-page refresh | None: the feed carries each page's `docHeadSeq`, and a refresh pulls by the primary key | The plan's index has no query to serve |
| Backoff and sleep | `min(5 min, 1 s × 2^(n−1)) × (0.5 + random)`, at least `Retry-After`; timers in chains of at most 15 s, and one that fires more than 90 s late runs a pass at once with the backoff reset | A laptop that slept syncs as it wakes, not minutes later |
| Pushing a long outbox | At most 200 updates and 4 MB a request, an update over 1 MB alone; each batch answered and stored before the next | The server's limits; a failure loses nothing answered and restarts nothing |
| Pinned pages | At most 24 fetched a pass, 4 at a time, the next pass 100 ms later while some remain | 500 pages in about 21 short passes, well inside the 2 minutes, without long store transactions |
| Repair | Checked on open (once a session), after a pinned page is refreshed with others' edits, and when the document layer finds updates still pending; at most four checks a pass; one repair per page, epoch and head, then the user is told | A repair that does not help must not loop |
| Scoped resync and subtree operations | A scoped resync that would remove a page the server moved away takes the whole tree instead; after any answered subtree operation, a tree the server could never hold is fetched whole | Both found by the convergence simulator; each loses no edit and costs one tree fetch when it happens |

M3.1 and M3.3, offline availability and conflicts:

| Choice | Default | Reason |
| --- | --- | --- |
| The signed-in account offline | Kept in the local store's prefs (`sync:account`: id, email, name, device id; no credential), so the app starts signed in with no network; a sign-out forgets it | "Offline, N changes waiting" from the first paint |
| Nothing unsent dropped by the server's word | A remote plan that removes a page with unsent updates sets its log aside first, in the same transaction (`page.removed`) | Deletes always applied in Phase 2, and an edit made offline went with them |
| Quarantine ids and times | Minted in TypeScript in every store; the desktop sends them to Rust | One order everywhere; the SQLite crate needs no UUID or clock |
| SQLite migration fixtures | Stores written by the released code: `crates/cgw-store/tests/fixtures/make.mjs` builds `cgw-store` from the v0.1.0 and v0.2.0 tags and drives it with the frames those releases sent | "Fixtures from every earlier version", from the real thing (about 356 kB of `.db` files) |
| IndexedDB schema 3 | Additive: `pins`, `quarantine`, `repairs`, and an index `covers` on `docLogs` so held pages are found without reading snapshots; storage used counts held assets by their records' size | The browser cannot copy a store before migrating it |
| The move notice | Causal, not timed: a remote change that deletes this device's own content without having seen it, in a block that lives on under its id, was a move that took an edit (`editLost`); a block moved here and elsewhere at once that now shows twice (`movedTwice`) | Measured: 151 of 155 words lost to moves were told to their typist and none of 181 lost to deletes; most losses came long after the typing, so a time window would miss them |
| The duplicate-id repair (D4, refined) | Written to Yjs in place on the element, not through ProseMirror | Through the id-aware binding a changed id is a new element, so two devices repairing one duplicate at once each made a copy, one more per round |
| Document schema version 2 | Adds `tableOfContents`; pages migrate on the first open with edit rights (a reader writes nothing); the worker raises a page's version one update at a time, never past the pushing app's version or its own | The plan's rehearsal of a real migration, on a block worth having |

M3.6, macOS:

| Choice | Default | Reason |
| --- | --- | --- |
| The Mac app | Universal (Apple silicon and Intel), macOS 13 or later, hardened runtime, `.app` and DMG; `tauri.macos.conf.json` over the shared configuration, the same CSP and scheme | One download for every Mac Tauri 2 supports |
| Signing and notarisation | `scripts/macos-build.mjs`: Developer ID from `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`; notarised and stapled with the App Store Connect key `APPLE_API_ISSUER`, `APPLE_API_KEY_ID`, `APPLE_API_KEY` (written to the runner's temp folder for the build and deleted after); ad-hoc otherwise, and the release notes say Gatekeeper will warn | The answer: secrets you add later |
| The test-only bridge | Cargo feature `e2e-bridge`, off by default: JSON lines on 127.0.0.1 with a token, three commands (eval, title, quit). Refused by `build.rs` when `CGW_RELEASE_BUILD` is set (both release workflows set it), and the release check fails if the binary holds any of its names | WKWebView has no CDP; the bridge must never ship |
| Updates on the Mac | `latest.json` gains `darwin-aarch64` and `darwin-x86_64`, both the universal update; the draft release waits for the Windows and the Mac jobs | One feed for both systems |
| Device name on the Mac | `scutil --get ComputerName` | An app started from the Dock has no host name in its environment |

The client side (shell and web app):

| Choice | Default | Reason |
| --- | --- | --- |
| The first account check | At most 5 s; any answer but the server's own "signed out" (null or 401), or none in time, goes on offline with the cached account; until it is verified, the network returning, focus and the first synced pass ask again | A hanging network must not hold the first editable page |
| Pins in the app | Only in synced workspaces, from the page and row menus; a page covered by a parent's pin says so and leads there to unpin; pages not on this device are marked (italic, secondary colour) only while offline or signed out | Online, nothing about pins re-renders the tree on a sync pass |
| A page not on this device | Pulled when opened online; offline, "This page isn't on this device yet" with Try again, opening by itself when the status moves to syncing or synced | Never an endless skeleton, and never a request the client knows will fail |
| Recovered pages | Ids derived from the quarantine entry's id (its UUIDv7 time and SHA-256 bits), made under a Web Lock across tabs, at the top of the private section; an entry can be dismissed once its page exists, and the page stays | `recover` comes after every pass while entries wait: making the page twice must be impossible |
| Notices | Every code has its own text and link (the recovered page, the Recovered list, the trash, the page's history, the block); a notice stays while hovered or focused, else 8 s | WCAG 2.2.1 (timing adjustable) |
| The service worker | Built by a plugin from the bundle and `public/` (no dependency), cache named for a hash of the files; registered only in production web builds; same-origin GETs only, navigations from the cached `index.html`; no `skipWaiting`, so a running page keeps its old lazy chunks and the new build takes over at the next start; `/sw.js` served `no-cache` | The web app starts offline; nothing from the API or Blob Storage is ever kept by it |
| Flushing | Anything holding an edit back for a moment (the title's 400 ms pause) registers with `session.onFlush`, and every flush (hiding, closing, the desktop's close request, an upload, an update) writes it first | A title typed just before closing was lost on every platform |
