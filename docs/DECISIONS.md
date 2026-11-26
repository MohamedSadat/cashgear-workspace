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

M3.5, the proof (kill tests, the old build, the benchmarks):

| Choice | Default | Reason |
| --- | --- | --- |
| How the web kill test kills | The whole process tree (`taskkill /T /F`), as Phase 1's did; `--kill immediate` ends the browser process alone, for comparison. The desktop is killed at once | Chrome itself loses IndexedDB writes it reported committed when only its browser process is ended at once (5 of 70 trials on a page that writes only a counter, 1 of 40 with strict durability, 0 of 40 ending the tree). The app cannot prevent it; ending the tree is what a crash of the whole browser does |
| A kill while the refresh token rolls | Accepted, not engineered around: a kill after the server rolls the token and before the keychain holds the new one leaves a spent token; within OpenIddict's 30 s reuse leeway it still works, later the app asks for a sign-in and its changes wait | The window is one token request's round trip, at start and every 15 minutes; nothing typed is lost; turning rolling tokens off or a two-phase keychain write costs more than it saves |
| Keychain names in tests | Each desktop run of a harness has its own `CGW_KEYCHAIN_SERVICE`, removed at the end | Runs that shared one rolled each other's refresh tokens: 44 sign-outs in 1,049 kills, 0 in 220 apart |
| Making compaction frequent for tests | No switch in the app: `--until-compaction` runs wait for the 200th save (about 40 s a run) | A test-only setting in the product for a test that already runs |
| The old build | v0.2.0's web build from its tag with its own lockfile (`scripts/old-build.mjs`), served beside the current build: the same document code the v0.2.0 desktop app embeds | Driving an installed old desktop app adds an installer to CI and tests nothing more |
| Phase 3's benchmarks in CI | `bench/phase3.mjs -- --desktop` after the kill tests, against a server stack started for them, gated against the budgets and the last run on `main`; the CI job's timeout raised from 100 to 130 minutes | The same gate as Phases 1 and 2 |

Answered by you, 2026-11-12, after CI's load test measured an edit reaching others at p95 5.25 s
on GitHub's 4-core runner (3.5 to 4.5 s in the four runs before, 2.2 s on the reference machine):
speed up validation first, then tag; if that cannot hold CI under 5 s, ask again.

| Choice | Default | Reason |
| --- | --- | --- |
| Who may edit, between passes | Remembered per workspace with the feed's head it holds at; one query asks whether an access, member or workspace change committed since, and only then is it read again (four queries); kept 10 minutes and 50,000 answers at most; forgotten when the check under the lock finds a change | The same rule the recheck under the lock rests on: every change to who may edit writes one of those changes. A validation pass spent half its reading time here |
| Validation passes under load | Back to back while they find pending rows (100 ms apart when idle); the job loop goes again at once when a job has more, and writes a job's row at most once a second unless it failed (the runs in between are counted) | An edit waits for the pass after the one running when it came: the gap between passes was 150 ms, and the row a write each pass |
| The workspace lock | Taken and its sequence read in one statement (`UPDATE … OUTPUT`); validation writes its rows' statuses and the pages' heads in one batch, which throws if any head did not move | Under load every round trip costs about 35 ms: the pass was bound by their number, not by the Yjs work (67 ms of about 650) |

## 2026-11-12: Phase 4

### Answered by you

| Question | Answer |
| --- | --- |
| Q14. The formula engine | Our own small expression language with a fixed function list (`prop()`, `if`, arithmetic, comparison, text, number and date functions), evaluated in TypeScript in the app and in C# on the server, held to the same answers by shared test vectors, as order keys and filters are. The server's result is cached on the row with a version (`Computed`, `ComputedVersion`) and is what the server filters and sorts by; the app shows its own result at once. No WASM, no change to either CSP. Formualizer is not used |
| Q15. When Track S starts | Now: a separate session in `cashgear-sheet` during Phase 4 for S1 (a cloud `SheetPlatform`: open by launch ticket, read by signed URL, save a new version with `If-Match`) and S2 (the `/cloud` launch route), built against a mock of Workspace's sheet-session routes (`INTEGRATIONS.md`), which Phase 5 builds for real. That session works to Sheet's own rules and checks |
| Property types in 0.4.0 | The plan's thirteen (text, number, date, checkbox, select, multi-select, status, person, URL and files in M4.2; formula, relation and rollup in M4.6), plus email and phone (text with a check and a link), and four read-only types taken from the row's page record: created time, created by, last edited time, last edited by. The automatic four store nothing; they have filter and sort rules like the rest |
| The row limit for local filtering | 5,000 rows. At or below it a device keeps every row of the database and filters, sorts and groups it locally, offline included; above it the server answers queries, keyset paged, and offline a database shows only the rows this device has already fetched, and says so |
| The table view and `CgGrid` | Our own virtualised table in the new `@cgw/database` package, using the library's menus, flyouts, tag box, date editor and check box. `CgGrid` was assessed and not used: it turns row virtualisation off while a cell is edited and while rows are grouped (a 50,000-row table would draw every row), filters and sorts by its own engine where the plan needs one set of rules shared with the server, and has English-only labels. Generic pieces the views need that the library lacks are local stand-ins listed in `PROGRESS.md` for Track U, as in Phases 1 to 3; `CashGear.React.UI` is not changed |

### Defaults picked (say if any should change)

M4.1, the model and sync:

| Choice | Default | Reason |
| --- | --- | --- |
| Where rows live | A row is a page of kind `row` under its database page, with a `DatabaseRows` record; rows are never in the tree, the sidebar, `readMirror` or `PageAncestors`; a row's access is its database's (no access list, no share link, no `Restricted`); nothing sits under a row, only rows under a database | One access check per database, not per row; a 50,000-row import or move touches no closure rows; v0.3.0 clients never see rows |
| Rows in the feed | Every change to a row (values, page, document head) is a `row` change; a row made or removed also writes a `database` change (`rowCount`); the server logs them as page changes and the feed sends them as rows | One mechanism, as for pages; the worker's head moves needed no change; old clients ignore entity types they do not know |
| Holds | A device keeps a database's rows only once it holds it (a view showing it, a pin over it, made on the device); full up to 5,000 rows (fetched 1,000 a request, 4 a pass, then kept fresh by the feed), else partial (the server's query results as a cache); an access event or a feed past its retention fetches holds again | As documents: held when opened or pinned, so a workspace with big databases never downloads rows nobody looks at |
| Values | Numbers are IEEE doubles (not decimal strings); dates `YYYY-MM-DD` or UTC instants with an optional end; an empty value is absent; a relation keeps its first 1,000 ids, on both sides | Both evaluators agree to the bit; `DATA_MODEL.md` said decimal strings before and says doubles now |
| Property and option ids | 8 base-62 characters; options a type change or an import makes are derived from SHA-256 of `databaseId NUL propertyId NUL name` | Every device and the server make the same options for the same conversion |
| Deleting | A deleted property keeps its values and can be restored; a deleted option leaves values that read as empty; neither rewrites a row | "Deleting a property or an option never corrupts rows" |
| A relation that no longer pairs | Changed to another type or pointed elsewhere: the reverse property becomes one-way and keeps its values | Nothing is lost, and nothing points at a property that is gone |
| Type changes from the server | Convert every held row, those with a local edit waiting too | "Applied to every row a device holds" |
| Refused operations | Take the server's entity, and fetch again what the planner changed beyond it (reverse relations, converted rows, reverse properties); a feed record waiting behind an operation whose answer carries another record is taken once nothing waits | Found by the convergence simulator (two seeds of 30 failed without it); the second also fixes a Phase 3 case: a page renamed elsewhere stayed stale while a visit to it waited |
| A row made offline in a database trashed elsewhere | Made, in the trash with its database | Nothing typed is lost |
| Upload of a local workspace | Databases, views and rows go up with the tree; relations, rollups and formulas, and rows' relation values, once every database and row exists | A relation may name what the server has not made yet |
| Refusal codes | A row outside a database, a page under a database or a row, a row moved out: `invalid`; a change to anything trashed: `page.trashed`; a row's access list or share link: 400 `request.invalid` | The planner's codes, and the HTTP routes' |
| Document schema 3 | `databaseView` (`databaseId`, `viewId`) and `dateMention` (`date`, `end`); the migration 2 → 3 only raises the version | One version for both new nodes |
| The database block | A plain DOM frame, mounted within 800 px of the scrolling pane and unmounted beyond 2,400 px with its last height kept; mounted again only when its database, view, block id or editability changes | D26; a fast scroll past mounts nothing |
| Dates in a page | The "@" menu: Today, Tomorrow, Pick a date (inserts today, then opens the picker); the device's calendar dates; drawn with `Intl` in the interface language | What a person means by today |
| The views' lint rule | `packages/database` imports neither the shell, the editor, the stores nor `@cgw/api`, and touches no storage or network global | The editor's rule: the views are given a host |

M4.2 to M4.5 and M4.7, the views:

| Choice | Default | Reason |
| --- | --- | --- |
| Cell edits | Written on commit (Enter, Tab, blur): one `row.update`, the title one `page.update`; plain uncontrolled inputs | Nothing re-renders per key (Phase 1); commit to the next frame p95 14.7 ms at 50,000 rows |
| Table geometry | Fixed row height (wrap: three lines), slot-keyed rows, columns outside the window not drawn, a sticky title column; widths by type, 60 to 1,200 px | 60 frames a second steady at 50,000 rows |
| A new row in a view | Takes its group's value and the filter's simple `and` conditions; its title is typed before it is made | It shows where it was made, and an abandoned New leaves no empty row |
| Links in cells | URL `http` and `https` only (a bare host gets `https://`), email `mailto:`, phone `tel:` with digits; drawn left to right | The editor's scheme rule |
| Date-times | Entered and shown in the person's time zone, stored as UTC instants; "Include the time" is the property's setting | One instant for everyone |
| A board drop | Into another column: one `row.update` of the group's property, after a `page.move` when the place needs a new order key; within a column one `page.move`; with a sort on the view only the column changes | It lands where it was dropped, and a sort keeps its order |
| Keys on the board and calendar | Board: Space picks up, the arrows move, Space or Enter drops, Escape cancels; calendar: Alt and the arrows move a row by a day or a week; a press becomes a drag after 4 px | Everything by keyboard |
| New board, list, calendar and gallery views | Show only the title until properties are shown | Twenty properties would make cards hundreds of pixels tall |
| The calendar | Loads the view's rows up to 5,000 and says so past that; the week starts by the locale (Saturday in Arabic); our own month grid. `CgScheduler` was assessed (README and API, not measured) and not used: it ignores a date-time with no end, its all-day end is exclusive where a date value's end is inclusive, and it brings its own editor, toolbar and keyboard model. The month grid is a stand-in listed for Track U | As `CgGrid` for the table; the view is self-contained, so a swap later is cheap |
| Templates | Built in: Tasks, Projects, Reading list, Meeting notes and Contacts, in both languages, with views and sample rows around the person's today; row templates are rows with `isTemplate` | Something to start from in either language |
| CSV | Import on the device up to 5,000 rows (400 operations an apply), else the server's route; export by the device when it holds every row of the view, else the server's route; a text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is exported with a leading `'`, which import removes | A spreadsheet never runs a cell as a formula, and a round trip changes nothing |

M4.3 and M4.6, the server:

| Choice | Default | Reason |
| --- | --- | --- |
| The query engine | In memory: a database's queryable rows cached per database and `RowsVersion` (300,000 rows across databases, least recently used first, `Databases__CacheRows`), refreshed by reading only rows whose `Seq` moved; evaluated by the C# port of `queryRows`, in parallel above 4,000 rows; results kept briefly for paging; a keyset cursor. No typed value table | 270 ms p95 at 50,000 rows with a filter and a sort (budget 300); what runs is the port the vectors check, not a third translation into SQL |
| Recompute | Formula and rollup results inline in the operation's transaction (the row, and up to 1,000 rows relating to it; every row after a formula change, up to 5,000), else `ComputePending` and the worker's `recompute` job every 2 s | Edits show their results at once; big databases catch up |
| Limits | 500 properties and 1,000,000 characters of them; a view's config 100,000; queries 100 rows (500 at most); the rows route 500 (1,000); imports 50,000 rows and 20 MB of CSV, 1,000 rows a transaction, 20 a minute a person | Bounded requests and transactions |
| The formula language | Function names case-sensitive; `mod` divisor-signed and `%` dividend-signed; `round` half away from zero; rollup percentages as fractions; an empty expression is empty; a formula reading a broken one gives its error | One stated behaviour for both evaluators |
| The workspace export | Format version 2: `kind` on every page entry, rows with `databaseId` and `values`, `databases` (`{ id, properties, views }`, views in order-key order), and each database's `<title>.csv` beside its files (every property not deleted, title first; trashed rows left out) | The zip holds databases, and import reads them back from the JSON |
| Server search and backlinks | A date mention's text is in the search text (`cgw-ydoc`, as `text.ts`); a page holding a database block links to that database | Dates are found; a database lists where it is shown |

The app (the shell over the views):

| Choice | Default | Reason |
| --- | --- | --- |
| Where a view's rows come from | Every row on the device (a local workspace, or a full and complete hold): queried there, formulas and rollups computed there; else, online, the server's query in pages of 100, rows made since the view opened that its filter takes added at the end; else the rows on the device, marked as such | Offline works for every database a device holds; the feed keeps copies fresh, so remote changes need no refetch |
| Holds started by a view | Its database and the databases its relations point into | Titles of related rows and rollups need them |
| People | A synced workspace's members, kept per workspace in prefs for offline; the person alone on a local workspace | Person cells and filters work offline |
| A row's body | Made on its first open by someone who may edit it, when the server holds none; a row from a template copies the template's body | A reader writes nothing (Phase 3's rule) |
| New database | Offered wherever New page is (the section's ▦, a page's menu, the palette), from `TemplatePicker` (Empty adds three rows), and "Import a CSV file as a new database" beside it; the editor's "Database" opens the same picker | One way to make a database everywhere |
| A database's page | Up to 1,280 px wide; its title and icon as a page's; the view last chosen on this device; a block keeps its `viewId`, written when an editor picks another tab | Tables need the width; a block shows what its page shows |
| The glyph | `▦` where a database has no icon; rows keep a page's | The table view's glyph |
| A server import | Sends the outbox until nothing waits on that database (at most 8 passes), then imports | The database must be on the server first |
| The workspace export on the device | Format version 2, as the server's; a database held partially exports the rows the device has; row templates in the JSON, not the CSV | A backup keeps what a person made; the CSV is a view of the rows |

M4.7 and the proof:

| Choice | Default | Reason |
| --- | --- | --- |
| How the budgets are read (`bench/phase4.mjs`) | First rows: from the database page's route to the table's first row, the median of five opens after the first (the first open, while the server fills its query cache, is tracked); 60 frames a second and a board drag ≤ 16 ms: the frame interval's p95 ≤ 17.5 ms (a 60 Hz frame and timer jitter); a cell edit "local ≤ 16 ms": Enter to the cell showing the value, p95 of 40 edits, with the next frame gated at 33 ms as Q19 did for keystrokes; durable: to the store's transaction, p95 ≤ 1 s; the server query in CI's Linux server job (SQL Server), the rest in the Windows job | The plan's figures, measured where they can be, as Phases 1 to 3 measured theirs |
| A cell edit before the store answers | The session applies the change in memory first and reads the store again if the write is refused | A commit showed only after IndexedDB committed (28 ms p95 before, 14.9 ms after) |
| A database's own page | Fills its area; the view scrolls inside itself | It drew every loaded row and scrolled at 4.5 frames a second at 50,000 rows |
| Assets and operations | The engine uploads files before it pushes operations, in each pass | The server takes a row's file or a cover only once it holds the bytes; a file added to a row was lost |
| A new relation or rollup | "Add a property" opens its settings first; nothing is written until Done | A relation without a target was refused without a word |
| An inline database's header | The toolbar wraps under the tabs when both do not fit; the tabs keep at least `min(100%, 16rem)` | "Table" was drawn as "Tal" |
| Old builds in the specs | v0.2.0 on port 4279 and v0.3.0 on 4278 (`target/old-build/<tag>`); a visit is the only operation an old build may send | Each released build meets the documents of the one after it |
| The Arabic check | "CSV" is allowed, as key names are | It is the format's name in both languages |
| The e2e stack's import limit | `RateLimits__import` 10,000, as `push` | The specs and the bench import through the route |

## 2026-11-14: Phase 5

### Answered by you

| Question | Answer |
| --- | --- |
| Q16. Which ERP connectors follow Vendors | Customers, then items on hand, all read-only, in Track E4 for 0.5.0. Reports wait for a later release |
| Tracks S3 to S5 and E1 to E5: who builds them, and what must pass before v0.5.0 | Two sessions of their own, started now: one in `cashgear-sheet` for S3 to S5, one in `CashGear` and `ERPClient_React` for E1 to E5, each to its repository's rules. In the ERP: LocalDB only, never the live database, and the person's uncommitted files left alone. Workspace builds against its own mocks meanwhile. v0.5.0 is tagged once the contract suites and the acceptance checks pass against both tracks' real code run locally; the check against the deployed Sheet and an ERP test tenant is a step for you after deployment, recorded in `PROGRESS.md` |
| Whether a workbook can be shared outside its workspace | No. A workbook's own access list follows the pages' rules: owners and admins `full`, members `edit`, guests nothing unless named; entries by person or for the whole workspace, at the same five levels. A page's share link, and a reader without access to the workbook, see "You don't have access to this workbook", never a picture |
| Limits | 20 MB for a workbook the embed loads, 5,000 cells in one embedded range, 100 MB for a saved version (Sheet's proposal, 413 `limit.size`). A bigger workbook or range shows its picture and "Open in Cash Gear Sheet" instead of a live view |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Range import and view export | The server reads and writes xlsx with `DocumentFormat.OpenXml` (MIT, Microsoft): import reads a range's stored values and their types (a number in a date format is a date), export writes a view's shown properties as the first version of a new workbook. `sheet-embed.1` carries no cell values | One reader and one writer, on the side that holds every row past 5,000; it needs no Track S4; the embed contract stays small |
| A workbook's picture | Asked of the live embed (`requestPreview`) and sent by someone who may edit the workbook; one per version and view, drawn in the file's own (light) colours whatever the page's theme, as Sheet prints; PNG only, at most 2 MB and 4,096 px a side; kept as a blob beside the workbook and read by signed URL after the workbook's own check. The device keeps the last one it drew with its date, for offline | A reader cannot change what others are shown; offline shows what was last seen |
| The picture's key | Workspace's own hash of the view (`viewHash`), not one the embed computes: `sheet-embed.1`'s `preview` carries the view it drew and the version's ETag instead | Two sides need not agree on a hash; the contract is not shipped yet, so it can still change |
| Where Sheet is | One origin from the build (`VITE_CGW_SHEET`) for `frame-src`, the frame's address and the message check, and the API's `Sheet__Origin` for launch links; live `https://sheet.cashgearerp.com`, a local API's builds the mock Sheet on `http://127.0.0.1:4283` | As Sheet finds Workspace's API: from the build, never from a link |
| Where the ERP is | From the build: the ERP's API (`VITE_CGW_ERP_API`, live `https://api.cashgearerp.com`, local builds the mock on `http://127.0.0.1:4282`) and the ERP client's connect page (`VITE_CGW_ERP_CLIENT`, live `https://erp.cashgearerp.com`, which Track E named; the same build also answers at `https://app.cashgearerp.com`; local builds the mock on `http://127.0.0.1:4284`). The API's `Erp__ApiBase` is the only base a link may name | No ERP address is ever read from a link, a document or a message |
| ERP links | Several per workspace (a block names its `linkId`). The browser redeems the ERP's link ticket (`#/erp-link/{ticket}`), then a workspace owner or admin records the link; Workspace's record says where to ask, and the ERP checks its own link on every session. Unlinking here stops Workspace offering it; the ERP's own revoke is in the ERP client | Workspace holds no secret and grants nothing; the ERP stays the check |
| The ERP session | One per link per tab, in memory only, renewed at most every 5 minutes while the person works in the tab, ended on `pagehide` (`keepalive`) and when the app closes; never in a store, a log, a URL or an error | `INTEGRATIONS.md`, a user's session |
| The ERP view's query | 50 rows a page by default, the connector's `maxPageSize` at most; at most three sort fields; paged by an opaque `cursor` (an ERP may page by keyset or offset) | A sorted list cannot page by id alone |
| The desktop's "Open in Cash Gear Sheet" | Sheet's web app in the system browser | Sheet's desktop deep link for Workspace is not built yet (Track S notes) |
| Workbooks and ERP blocks in a local workspace | The block says to sign in; nothing is made | Both live on servers |
| Workbooks in search | Not in search; the workbook list filters by name | A workbook's content is not Workspace's to index |
| A workbook's trash | 60 days, then deleted with its versions and pictures by the worker, as pages | One retention rule |

Built in M5.1 to M5.7 (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| `sheet-embed.1`'s validators | Exactly the fields the table names, at every level; a parsed message is a fresh copy of them; URLs visible ASCII with a lower-case scheme and no user name or password; strong ETags; capital A1 ranges without leading zeros; `error.message` always present; `ready.contracts` 1 to 16 names; chart titles 1 to 255 characters | One strict reading both sides run as shared vectors (288 cases; Sheet's validators pass every one) |
| The 4,096 px rule | On the picture's own pixels; the block asks for `maxWidth * scale` and `maxHeight * scale` at most 4,096, `scale` at most 2 | Sheet only lowers density for the 2 MB rule |
| The sheet block's frame | 480 px high unless the block says otherwise; the picture until `loaded`, then the live view; one retry with a fresh URL on `source.forbidden` | The page does not jump, and an expired URL heals itself |
| "Open in Cash Gear Sheet" | A new tab with `noopener` in the browser, the system browser on the desktop | Sheet's tab owes Workspace's nothing |
| No access and deleted for good | Both are 404, both shown as "You don't have access to this workbook"; "deleted" only for a 410 outside the trash | A workbook's existence is not told to someone who cannot read it |
| Versions and pictures kept | The newest 10 versions of a workbook; the newest picture of each view, at most 100 a workbook | Bounded storage; Sheet keeps no history of its own here |
| A copy (Sheet's "Save a copy") and an export | Keep their source's access (a copy's maker at least `edit`; an export its database's) | Neither is ever seen by more people than what it came from |
| A workbook's record writes | `If-Match` optional on `PATCH` and on the permissions' `PUT`; a stale one is 409 `version.conflict`, as page permissions answer; `DELETE` and `PATCH {trashed: true}` both trash; no delete for good by a person | As pages |
| Sheet's session routes | Renew checks access again, End does not; rate buckets `ticket` (Redeem, 30 a minute an address) and `sheet` (600) | Ending always helps; a refused site cannot spend a ticket |
| Range CSV | Fields holding a separator, quote or line break quoted; text guarded as the database CSV is (`'` before `=`, `+`, `-`, `@`, tab, CR); error cells as their text; time-only formats as numbers | The app's CSV import takes it back exactly |
| IIS request limit | `web.config` allows 110 MB | The API's own 413 at 100 MB answers first |
| The web CSP's `frame-src` | The build's one Sheet origin only (the desktop keeps Sheet's Static Web Apps host too) | One origin is the allow-list |
| ERP column names | In the interface language (the schema carries both) | The page around the block is in that language |
| An ERP filter on a field the reader cannot see | Shows nothing, never dropped | A filter never widens what a block shows |
| Recording a link that answers 409 | "Already linked" only when the existing link has the same ERP link id; else "stale", and the person unlinks in settings first | Nothing is replaced without a person |
| The desktop's ERP sessions | Ended on `pagehide` only | A second close handler would let the window close before the shell finishes saving |
| Old builds in the specs | v0.4.0 joins on port 4277 | Each released build meets the documents of the one after it |
| A view with no picture yet | `GET …/previews/{viewHash}` answers 404, as INTEGRATIONS.md says; the browser logs it once per new view | A picture is a resource; the block shows the live view or its own text meanwhile |

## 2026-11-14: Production hosting

### Answered by you

- The web app on Azure Static Web Apps' Free plan, deployed from this repository's `main` by the
  workflow Azure wrote, with the custom domain `workspace.cashgearerp.com`.
- The Workspace API at `workspace-api.cashgearerp.com`, its own IIS site on the host that serves
  `api.cashgearerp.com`, not under UnifiedAPI's host name.
- Its database on that host's `MSSQLSERVER01` instance, a database of its own.
- A new private storage account and an app registration (service principal) for Blob Storage,
  rather than a container in `cashgearstorage`.
- Mail through the ERP's SMTP account (`smtp.gmail.com`, `info@cashgearerp.com`).

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The Static Web Apps build | The workflow builds with pnpm (`pnpm build` with the four `VITE_CGW_*` origins of OPERATIONS.md) and the action only uploads `apps/web/dist` | Oryx runs `npm install` in `apps/web` and cannot read `workspace:*`; as Sheet's workflow |
| Identities on a workgroup host | `IIS AppPool\CashGearWorkspaceApi` and `NT SERVICE\CashGearWorkspaceWorker`, made by `install.ps1` when `-ServiceAccount` is left out | No domain, so no gMSA; built-in identities have no password to keep |
| The Blob credential | A certificate made on the host, PFX without a password under `C:\CashGearWorkspace\secrets` readable by administrators and the two identities; only its public half uploaded | `DefaultAzureCredential` reads a certificate from a file only; the private key never leaves the host, and no secret is typed or shown |
| The HTTPS binding | By host name (SNI) from `WebHosting` | The host's other sites on 443 and its default binding stay as they are |
| SQL encryption on the host | `TrustServerCertificate=true` for the local instance | Its certificate is self-signed; the connection never leaves the machine |
| Storage account | `cashgearworkspace`, Spain Central (as `cashgearstorage`), Standard LRS, soft delete 30 days for blobs and containers, versioning | OPERATIONS.md step 3 |

## 2026-11-14: Phase 6

### Answered by you

| Question | Answer |
| --- | --- |
| Q17. SignalR scale-out | One node until measured: the hub runs in the API's one app pool, with nothing new to host. M6.6 measures 2,000 connections and 20 editors on one page; Azure SignalR Service only if those figures say one node is not enough. This settles D20's open point for 0.6.0 |
| Where the hub runs | In the API's own IIS site and app pool (`CashGearWorkspaceApi`), at `workspace-api.cashgearerp.com`; `install.ps1` turns on IIS's WebSocket Protocol feature. This settles Q6's "revisit for SignalR" |
| Notification channels for mentions and comments | In the app only: an inbox, updated live while connected. Email stays on the Later list |
| Comments for a share link's readers | No: a share link shows the page alone. Comments, mentions and presence are for the workspace's members |
| Presence in the sidebar | Yes: avatars beside the pages others have open, as well as in the open page's top bar, only on pages the viewer can see |
| Comments offline | Online only in 0.6.0: read and written while connected; offline the panel says so and keeps what it last showed in the session. No local store change (store schema stays 4) |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| What the hub relays | Only updates the worker has validated: the relay follows each joined page's validated head, never the push (SYNC_DESIGN.md, As built in Phase 6) | Q20 still holds: one bad update stops every other client's binding |
| The worker's validation loop | Every 25 ms when idle (was 100 ms plus a 50 ms sleep); nothing it decides changed | A push reaches the other editors well inside 300 ms |
| Connecting to the hub | A ticket from `POST /api/v1/realtime/tickets`: 32 random bytes, SHA-256 only, 60 seconds, one use; WebSockets only, no negotiation, the JSON protocol; the connection is the ticket's person and device, no cookie or bearer token read on that path; the upgrade's `Origin` must be one of `Web__Origins` | The only credential in the address is spent before anything can log it; a page on another site cannot open the socket |
| Payloads | JSON with base64 bytes (no MessagePack) | Measured enough in M6.6; one less dependency on both sides |
| One push for both transports | The HTTP route and `PushUpdates` call the same method (`PageGate`, then `DocService.PushCheckedAsync`); the hub caps a call at 1 MB of update bytes and the client sends anything larger over HTTP | Same checks, same answers, same sequence; a backlog is what HTTP's 4 MB batches are for |
| Sends | Frames and `PagePresence` go to this node's own connections (`PagePresence` only to followers who can read the page); `Awareness` through the page's group | Nothing is sent twice when a second node comes; a group cannot leave out who may not read a page |
| `ChangesAvailable` | At most every 250 ms a workspace (`Realtime__ChangesMs`), always the newest head; a client passes on it at most once a second | Every validation pass writes a feed change: unthrottled, each follower would get one every 25 ms |
| Access on the hub | Each connection's device, membership and joined pages checked again at most every 60 s (a sweep every 10 s) and at once on an `access`, `member` or `workspace` feed change or a device's sign-out; what is lost is left with `AccessRevoked`, a signed-out device is closed | The plan's 60 seconds, and at once for the changes the server itself makes |
| Limits | 50 pages joined a connection, 50 workspaces a call; 20 connections a device and 200 a person (the oldest closed); `Awareness` 1 KB and 20 a second; frames at most 1,000 rows and 2 MB (else `complete: false`); a relay pass waits at most 250 ms on its sends; the hub's push budget is the `push` bucket's | Bounded memory and messages; one stalled socket holds back no one |
| The client's connection | `@microsoft/signalr` 11.0.0 (MIT), loaded with the first connection in its own chunk; its own reconnect loop (`min(30 s, 1 s × 2^n) × 0.5…1`, a 429's `Retry-After` the least, at once on `online` and focus); keep-alive 15 s, timeout 30 s | A recycle's clients spread over half the wait; the first load is unchanged |
| The engine while connected | The periodic pass every 30 s; a pass on `ChangesAvailable` or `AccessRevoked` at most once a second; after a drop the next pass within 1.5 s; after a reconnect a pass only if a feed is ahead or something waits | A recycle must not make every client pass at once |
| The live page | The page on screen is joined (one at a time); its saves go every 60 ms at most (30 ms after the last key) and each through the hub at once, at most 200 updates and 1 MB a batch; `limit.size`, a 429 or a lost connection leaves it to a pass over HTTP | Presence is who has which page open; a page kept in memory but left is not one |
| Presence | The selection on every change (at most every 50 ms), every 10 s while on the page, `cursor: null` on blur and `null` on leaving; others dropped after 30 s silent and at once when the connection drops; names and colours from the members, never the message; one cursor per person and Yjs client | A person does not vanish from the top bar when focus leaves the editor; nobody can pose as another |
| Avatars | Initials on one of eight presence colours (`--cgw-presence-1` … `-8`, light and dark, a stable hash of the user id), one letter for an Arabic-script name; 4 in the top bar and 3 beside a sidebar row, then "+N" | Track U7 is not built: a stand-in; two Arabic letters side by side join into a word |
| Comment anchors | The block's id, two Yjs relative positions (the start sticking to its first character, the end to its last) and the quoted text (at most 1,000 UTF-16 units); a range only when both ends land in the block in order, else the quote nearest where the thread was last found, else the whole block; a caret, a whole-block selection or an atom block makes a whole-block thread | A moved block is written to Yjs anew, so its positions no longer resolve: the quote is what finds it |
| Who may comment | Create, reply, resolve and reopen at `comment` or above; edit one's own at `comment` or above; delete one's own, or any with `full`; deleting a thread's first comment deletes the thread; allowed on a trashed page | A person lowered to `view` cannot keep writing through their old comments |
| A comment's body | The document's inline nodes, a subset: text without marks or line breaks, `hardBreak`, `userMention`, `pageMention`; not empty (a character of text or a mention), at most 4,000 characters and 50 mentions | One reader of a body on both sides; a mention alone is a comment |
| Comment ids | UUIDv7 made by the client; a repeat create by the same person answers with what is stored; the same id from someone else, another page or thread is 409 `conflict` | Idempotent writes without letting a guessed id reach someone's thread |
| The comments panel | Closed when a page opens; Ctrl+Alt+Shift+M (by `event.code`) or a highlight opens it; Ctrl+Alt+M comments on the selection; in the composer Enter makes a line and Ctrl+Enter sends; replies only to open threads; a failed write stays with "Try again" and "Discard" | Chrome keeps Ctrl+Shift+M; nothing typed is lost |
| Notifications | `mention` (worker: once per recipient, page and block), `commentMention` (once per comment, also when an edit adds a mention), `reply` (the thread's earlier participants not mentioned in it); never the actor or anyone who cannot read the page; the excerpt is plain text cut to 200 units, mentions as `@` only | A person is told once; a name or title is never in an excerpt for someone who may not see it |
| The mention's actor | The pusher of the newest valid update the derive covered (else the newest valid update, else the page's `UpdatedBy`) | The worker derives a range of updates, not one person's edit |
| The inbox | `GET /account/notifications` across workspaces, newest first by an identity column (`Seq`, its cursor), 50 a page; an entry for a page the person can no longer read is neither shown nor counted; a removed member's entries in that workspace and a deleted account's are deleted | No title for someone who lost the page; nothing kept that nothing shows |
| Old builds in the specs | v0.5.0 joins on port 4276 | Each released build meets the documents of the one after it |
| Updates a minute to one page, from everyone | 12,000 (was 1,200 from Phase 2) | From Phase 6 an open page pushes about once a key: 1,200 stopped a page at four or five people typing, and `bench/phase6.mjs` had 1,755 of 2,953 pushes refused at 20 editors. 12,000 is 20 people at the per-person budget (600 a minute); none refused after |
| The network going while the hub is connected | The window's `offline` event closes the hub's connection at once (`HubTransport.drop`) and runs a pass, which says "Offline"; `online` brings both back | A socket the browser keeps open would carry live saves while every other request fails, and the connected pass is every 30 s |
| The recycle in the specs and the bench | The API process ended at once and started again through the e2e stack's control port (127.0.0.1:5289, `--e2e` only, `scripts/stack-control.mjs`); the worker keeps running | Harder than IIS's overlapped, draining recycle: nothing in flight is answered |
| Keystroke timing in e2e | From the typist's keydown (`Date.now()`) to the other page's first DOM state holding that many of the typist's characters, one machine's clock | Counting needs no markers in the text |
| The load bench | 20 editors at a key every 200 ms ± 20 % each, one update a key through the hub; 2,000 connections as 10 people × 10 devices × 20, 10 a page, presence every 10 s each; sanity caps of 2 GB, 50 % of a core idle, 200 % with presence and 90 s for the storm | The hub's own limits, unraised; caps far above what was measured, so a leak or a busy loop fails and noise does not |
| The typing cases on CI | `realtime.spec.ts` and `desktop-cloud.spec.ts` check p95 ≤ 300 ms on the reference machine; on CI's hosted runner they check that each page received the other's keys through the hub's frames and p95 ≤ 1 s, and record the server's own relay time beside them; the plan's server budget (relay p95 ≤ 150 ms) is gated on CI by `bench/phase6.mjs` | CI's four shared cores run SQL Server, the API, the worker and the pages drawn in software: over three runs its median key-to-screen time went from 90 to 350 ms by runner, with the same code passing on a retry. A second is the line between the live path and an HTTP pass |
| The relay budget on CI | `bench/phase6.mjs` holds the server's relay p95 at 20 editors to the plan's 150 ms on the reference machine (75.6 and 80.8 ms); on CI's hosted runner to 500 ms and to the last run on `main` (its first run: 282.5 ms, p50 49.4 ms) | The runner's four cores also run the 20 clients, Chrome, the desktop app and SQL Server. Each validation pass loads the whole document several times (its meta, the check, the state hash), which is what a crowded machine stretches: making it once a pass is a follow-up |
| Mail in the pickup folder | Written as `<name>.eml.partial`, then renamed to `.eml` | On Linux the writer's lock comes after the file exists: a test reading the folder in between made the write fail and the mail was lost (CI, the Phase 2 load test's invitations) |
| Phase 5's keystroke figures under Phase 6 | `bench/phase5.mjs` records the conditions it measured under (`conditions: 2`: the page live on the hub); its four keystroke figures (work and next frame, web and desktop) are compared only with a run on `main` under the same, so their regression check starts again from Phase 6's first run on `main`; every budget on the reference machine is unchanged (8 ms, 33 ms) | CI's run on the release commit measured the desktop's work per key at 6.6 ms against Phase 5's 3.5 ms (an earlier run 7.2 ms), the web's at 3.6 against 2.2. On the reference machine the figures hardly moved: unthrottled 4.5 ms web and 4.4 ms desktop (Phase 5: 4.4 and 3.9); with the CPU slowed 4×, 21 to 22 ms with live saves and 24 to 26 ms with Phase 5's 500 ms batches. The server's CPU while one person types a key every 35 ms (a push a key) doubled: the API, the worker and SQL Server used 7 s in a 5.7 s window, against 3.6 s with 500 ms batches and 1.2 s idle, the same with the server built for Release (about 55 ms of the API's CPU and 45 ms of the worker's a push, a validation pass a push, the relay polling every 20 ms): a follow-up with a profiler. That it is what CI's figures pay for is not shown (the next row) |
| The work per key on CI | `bench/phase5.mjs` and `bench/phase6.mjs` hold the editor's work per key (p95) to Q19's 8 ms on the reference machine and to 16 ms, a frame at 60 Hz, on CI's hosted runner, and there to the last run on `main` under the same conditions; the next frame stays at 33 ms everywhere. Both benches now record, of each key's work, the time it waited for the page's thread (from the keydown to the first listener) | The next CI run measured the desktop's work at 11.1 ms p95 on an AMD EPYC 7763 runner (web 5.4 ms); the median, not only the tail, doubled: desktop 2.6 and 3.2 ms in Phase 5's runs, 5.0, 5.4 and 8.1 ms in Phase 6's (web 1.9 and 2.0, then 2.5 to 3.9); the next frame's p95 stayed at 17 to 19 ms. Phase 6's own bench gave the desktop 7.2 ms while 19 type. The reference machine did not reproduce it: everything on four of its processors (its LocalDB too), and on four with the GPU off as CI draws, gave 5.1 to 5.5 ms p95 and 3.4 to 3.7 ms median. With the runner's cause unknown, the reference machine keeps Q19's budget and CI keeps a limit a person would not notice; where the time goes on CI (waiting for the thread or the app's own work) is what the new figure shows, and finding it is a follow-up |

### Decided from the measurements (2026-11-15)

| Question | Decision |
| --- | --- |
| Q17. SignalR scale-out | One node, no backplane and no Azure SignalR Service in 0.6.0. M6.6 measured 2,000 connections on the one API process at about 0.6 GB working set (0.1 to 0.2 GB more than without them), 13 % of one core idle and about half a core with presence from every connection every 10 s; all 2,000 back about 9 s after a recycled API answered (the clients' own backoff, not the server's capacity); 20 editors on a page relayed at p95 76 to 81 ms. Revisit past about 5,000 to 10,000 connections on a node, or when a second node is wanted for availability: every send already goes to the node's own connections, so a second node is a backplane's configuration (SYNC_DESIGN.md, As built in Phase 6) |
| Payloads | Stays JSON with base64 bytes: the 300 ms and 150 ms budgets are met with room, so the binary framing SYNC_DESIGN.md kept for Phase 6 is not needed |

## 2026-11-15: Phase 6 follow-ups (text reported saved, then lost)

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The device's own updates the worker refuses | They go to repair. The device sends its whole state as one update by the repair route, and the page comes back from the start (SYNC_DESIGN.md, Pull). They are no longer set aside at once | The 0.6.0 kill test found a device whose snapshot held a key no update carried (`5057581`). The server refused everything typed after that key, as referring to content it lacked. The device then set its own refused updates aside, so text it had reported saved was gone. A whole state carries what was missing, and the worker takes from it only what it adds, so other people's structs in it are no forgery |
| When a refusal is still kept aside | The old way (the store's corrupt area, `doc.refused`) applies only when no repair can carry the updates. That is when the repair's own update is refused too, the account cannot edit (a reader, held back, or the route answers 403), the page is gone (404, 410), the client is too old (426), the state is over 1 MB (413), or the epoch changed. In the last case the epoch change's reset sets the page's edits aside first | What the server will never take still never reaches anyone, and nothing typed is dropped from the device |
| Where a refusal is kept until its repair lands | A preference per workspace, `sync:refused:<workspaceId>`: each page's refused update ids, and the repair sent for them (its update id, the ids it carries, its sequence once answered). It is written before the cursor moves past the answer that reported the refusal, and the repair is written before it is sent. Each write reads the preference again first. The store schema is unchanged (4) | A stop at any moment either reads the answer again or sends the repair again under the same id, which the server keeps once. Every tab has its own engine over the one store, so a write keeps other tabs' pages |
| Deciding a repair | A repair is decided by the first pull or frame whose window passes its sequence: valid if it is not among that window's refused updates. A refused update at or below the cursor the device held before an answer was reported before, so it is not counted again when a repair's pull lists everything from the start. A repair whose window went by without this engine seeing it (another tab took it) is sent again under its id, and that answer decides it | The server's `rejected` lists the caller's refusals after `after`, and a repair's pull starts at 0 |
| What the person sees | Nothing when the repair works: the text was saved, and the server now has it too. Refused updates count as waiting in the sync status until their repair passes the worker. The state-hash check waits while a refusal waits | "Synced" means the server holds it. A notice for something the person cannot act on and that cost nothing would only alarm |
| The save status and the session's own changes | "Saved" now also waits for the session's changes to the open page (`WorkspaceSession.writeState`). A title, an icon, a cover, a row's property or a move counts from the moment it is asked for, before it joins the write queue, until the store has it. A title waiting on its 400 ms pause shows "Unsaved changes". A visit is not counted | `database.spec.ts` "a row opens as a page" lost a row's new title across a restart twice on CI (Edge, then Chrome), and once in Phase 5. The test pressed Enter in the title, waited for "Saved" and restarted. The title shows at once and is in IndexedDB a few milliseconds later, but the status followed the document alone and already said "Saved". The page was closed with the write still open, and IndexedDB aborts an uncommitted transaction when its page goes. A person who closed the tab at once lost a title the app had called saved. The test was right to trust the status; the status was wrong |
| The cell edit's next frame in Phase 4's regression check | A regression must also be more than one frame (17 ms) over the last run on `main`, not 5 ms; the 33 ms budget is unchanged | The figure moves by a whole frame between CI's runs with nothing changed in its path: the desktop's read 16.6, 9.9, 16.4, 10.1 and 17.4 ms, the last two on the same processor (run 43707259854 failed on that last pair), and the web's 16.1, 11.6, 20, 13.8 and 12.8 ms. A 5 ms margin is less than the step it moves by |

## 2026-11-15: Phase 7

### Answered by you

| Question | Answer |
| --- | --- |
| Which connectors become editable first, and who builds Tracks E6 and E7 | Vendors only, with the fields Sheet already edits: name, group, mobile, payment method, address and tax file with Edit; currency and blocked with AdvEdit; the account, bank account, credit limit and the modified stamps never. Through `api/connect/Connectors/vendors/Commit` and `CommitStatus`, reusing the ERP's Sheet commit and audit code, with a column naming the Workspace page. E6 and E7 are built in a session of their own in `CashGear`, on LocalDB only, committed locally and not pushed, as E1 to E5 were. Workspace builds against its mock meanwhile. v0.7.0 is tagged once the suite and the acceptance checks pass against UnifiedAPI run locally |
| The first plugin blocks | Chart, then kanban, both over a database view, on one new node `pluginBlock` (document schema 6). Chart: bar, line, pie or a single number from a view's rows grouped by a property (count, sum, average), drawn with the UI library's `CgChart`. Kanban: a compact board over a view grouped by a select or status property; moving a card writes that row's property. The page stores ids and settings only |
| AI: mode, provider and default | Bring your own key, Anthropic only, off for every workspace until an owner or admin turns it on and enters a key. The key is kept on the server encrypted with ASP.NET Core Data Protection and never returned to any client. Calls go through Anthropic's official C# SDK; `claude-opus-5-5` by default, `claude-sonnet-5-5` or `claude-haiku-5-5` selectable. Use is metered and audited per workspace without content. ERP records reach the provider only when someone asks AI to prepare changes in an ERP block, from their own session, and are never stored. Tests use a mock provider; real calls only with a key set in the environment |
| AI search over content | Search, then answer: the question runs through the existing server search with its permission filter and Arabic normalisation; the newest text of the top pages the person can read goes to the model, which answers with links to its sources. No `PageEmbeddings` table in 0.7.0, and nothing new is stored |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| "Snapshot an ERP view" (`INTEGRATIONS.md`'s bridges, listed for Phase 7) | Not built | It writes ERP data into a Workspace table, which the hard limits forbid; the plan's Phase 7 tasks do not name it |
| `pluginBlock` | One node in the `body` group, an atom, with `type`, `version` and `props` (JSON text), all optional with defaults; document schema 6, step 5 → 6 only raising `meta.schemaVersion`, as versions 2 to 5. A later plugin type needs no schema change | `INTEGRATIONS.md`'s plugin blocks; the plan asks for a schema rise with its migration test |

Built in M7.1 to M7.4 (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| Who may change ERP data in a block | Whoever the ERP gives `edit` on the connector, whether or not they may edit the page; the block must know its page and block id | Workspace adds no permission of its own (plan, Phase 7 risks); the ERP checks every privilege and value |
| Where pending ERP changes live | One draft per block in the tab's ERP services (`pageId#blockId`), memory only; they outlive the block's frame unmounting far from the viewport and a reconnect; gone when the page is left (after the warning), another person signs in, or the app closes | The frame unmounts beyond 2,400 px; nothing of the ERP may be stored |
| Editing in the table | "Edit data" opens the editable fields' cells; a changed cell is marked by a tint, a bar at its inline start and "Changed" (or "Prepared by AI") for screen readers, its old value in its title. A cell refuses a value not of its type, too long, past its scale or range, empty when required, or not an active code; the ERP checks again | A read-mostly table stays a table; the local check saves a round trip and is never a permission |
| `commitId` and retries | `crypto.randomUUID()` per payload; Commit reuses the review's id when nothing changed since, else a new one. After a lost answer (none, 500, 503, 429, unreadable) `CommitStatus` first, then the same request: at most 3 resends, waiting `Retry-After` or 1, 2, 4 s (at most 8 s), then "Try again" (CommitStatus first). A 401: unknown until connected again, then CommitStatus by itself. Nothing can be edited meanwhile | The contract's client rules: the payload under an id never changes |
| Workspace's audit of a commit | Outcomes `committed`, `conflict`, `refused` (400 per field or the whole commit), `failed` (CommitStatus said nothing was written, retries spent), `unknown` (CommitStatus not answered, or the session ended); dry runs not reported; best effort. Any reader of the page may report; the link must be a live link of the page's workspace; the row also names the ERP link id and company | Says who tried what from which page and how it ended, never a value; the ERP's audit is the authority |
| A conflict | For each field the ERP changed the person picks Mine or Cash Gear ERP's; fields it did not change keep the person's value on the record's new version; then they review again (no commit from the conflict screen) | A stale value is never written unseen |
| The block's data while changes wait | Its connector cannot be changed; a draft for other data (a collaborator re-pointed the block) is offered for discard | Changes never apply to other data |
| Leaving with ERP changes | In-app moves are held by the router (the page stays on screen) and asked about in a dialog; the browser's own `beforeunload` question; the desktop asks before its window closes (`onCloseAsk`, before the saves are flushed). "Leave and discard" forgets that page's drafts | The plan's leave-page warning, on every way out |
| AI's prepared ERP changes | The records on screen (at most 500, the request at most 400,000 characters) and the editable fields with their active codes go to the AI; each proposal for the block's own records and fields is checked as a typed one, marked "Prepared by AI", and committed only by the person on the review screen. `@cgw/erp/ai` is types only; the block's own code adds the proposals | No path to Commit |
| The mock ERP's users | alice stays view-only (as the real FULL key); gina has Vendors' Edit, faris Edit and AdvEdit (`ERP_TEST_KEY_EDIT`, `_ADVEDIT`); `V-1005` is locked | Phase 5's specs keep their users; the suite's roles map one to one to Track E6's keys |
| A plugin block's line in text | Copy and export only; the local search index, the server's derived text, search and Markdown write nothing | Props are settings; the server cannot run a definition, and search must agree on both sides |
| Inserting a chart or a board | The slash menu writes the type and the definition's version with no props; the block's own set-up asks for the database (the linked-view picker) | One insert path; the frame is where the choices are, as the ERP view's |
| The chart's numbers | Counts from the query (exact at any size); sums and averages from the rows, at most 5,000, said when cut | A count needs no rows; a sum over a server-queried database pages through rows |
| The kanban | `@cgw/database`'s own board, given a view never stored (the base view's filter and sorts, the block's columns, hidden columns and cards); its view changes go to the props | Moves behave exactly as the board view's; nothing writes another view |
| Plugin blocks elsewhere | A copied page's plugin props follow a copied database (`databaseId`, `viewId`); on a page shared by link they show the database block's "shared placeholder" note; a type is dotted lower-case words of at most 64 characters, a version a whole number from 1 | As a database view block's ids and share note; third-party names stay apart from first-party ones |
| Who sees and uses AI | Every member reads `enabled`, `provider`, `model`, `models`; owners and admins also whether a key is set, when, by whom, and this month's requests and tokens. Guests do not use AI (403 `access.denied`). The client offers it when signed in, the workspace on the account, not a guest, online, and AI on with a key | Members need to know whether to offer it; the key's history and the bill are the admins' |
| The key on save | 20 to 500 visible ASCII characters, no spaces; not tried against the provider when saved (the first completion says `ai.keyInvalid`). Removing it turns AI off; turning on with none is 400 `ai.keyMissing`. The settings' field is a password field, cleared after Save, never prefilled | Saving never spends the workspace's money or sends its key anywhere; the key is shown once, when typed |
| The provider call | Anthropic's C# SDK 13.8.0 (Apache-2.0); the base address always named (`https://api.anthropic.com` unless `Ai__AnthropicBaseUrl`, ignored in Production) and no credentials read from the environment; `max_tokens` 16,000 for the low-effort actions and 32,000 for the others; the SDK's 2 retries; a 10-minute timeout; the server-side refusal fallback (`fallbacks: "default"`) for Opus 5.5 and Sonnet 5.5, none for Haiku 5.5 | The SDK would otherwise follow the host's `ANTHROPIC_BASE_URL`; thinking counts against `max_tokens`; the skill's defaults for these models |
| Failures before and after the stream starts | The stream starts only once the provider accepted the call. Before: 502 `ai.keyInvalid`, 503 `ai.limit` (after the SDK's retries), 502 `ai.provider`. After: an `error` line with the same codes or `ai.refused`, after any text sent | A refusal of the key shows without reading a stream; partial text is never presented as complete |
| `ask`'s retrieval | The question's words (3 letters or more, at most 6, longest first) searched together, then each alone, through `SearchService` under the person's filter; ranked by words matched; the top 8 with up to 8,000 characters of derived text each. No readable page found: nothing is sent, the answer is an empty `sources` and `done` | Server search ANDs its terms; asking a model with nothing to cite costs money and invites invention |
| Content in a prompt | Between tags, with the instruction that it is content, never instructions; no tools are offered | A page another member wrote may say anything; its worst effect is a proposal the person reads before accepting |
| `generateDatabase`'s answer | `rows: {values: [...]}[]`, each row's values an array in the properties' order; every property carries `options`. Accepted: the first property is the title; types text, number, select, multi-select, date, checkbox, url, email, phone; options for names rows use, at most 50; a value that does not read as its type left empty | Structured output needs closed objects; no guessed data, the same rules as a person's input |
| `AiUsage` retention | Kept with the workspace, deleted with it; no age limit | The month's totals read from it; nothing in it is content |
| The mock provider | `tests/mocks/ai` on 4286; the server's tests start it; the dev and e2e stacks point at it unless `CGW_AI_BASE_URL` says otherwise | No test or dev session reaches the real provider by accident |
| Where AI is offered | A panel beside the page, sharing its side with the comments (one at a time); opened by "Ask AI" in the bubble toolbar (a selection: rewrite), "AI…" in the page menu, the palette's "Open AI", and "Ask AI: “…”" in the palette while a page is on screen. No shortcut | One place for every proposal; AltGr+letter chords collide on some layouts |
| What a page action sends | The page's text as this tab holds it, its title first, mentions as the names the reader sees, at most 100,000 characters (refused before sending when longer) | "Only content the user can read"; the newest text, not the worker's derived copy |
| Accepting a proposal | Rewrite: in place when the range still reads the same, else after its block; summary: the page's top; to-dos and answers: after the selection, else at the end; answers end with a "Sources:" line of page mentions; a new page under this one (its section's top for a row or a page not editable here); a new database under the page with a block showing it, rows as proposed. Every proposal can be copied; on a page not editable here Copy is the only way in | Never overwrite what someone typed meanwhile; each accept is one undoable edit or the session's ordinary operations |
| Ids a change makes without an id | The block-id plugin's mint now joins the change that made the blocks in Undo history (out of it only when that change was) | It was kept out of history, and the binding writes a batch to Yjs as its last transaction says, so a duplicated block (Ctrl+D), a pasted one and any block inserted without an id could not be undone: latent since Phase 1, found by stream E |

## 2026-11-15: After 0.7.0 (what a refused operation says)

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| "This is no longer available to you." | Only for `not.found`. Every code the shell does not name now falls to "The server did not accept a change to “…”, so the change was undone." | Every code fell to it before, so a refusal unrelated to lost access (`invalid` on a create sent twice, at first run) read as if something had been taken away |
| `invalid`, `request.invalid` and codes the app does not know | That notice, with a link to the page as the server has it; a version naming no page when the server's answer names none | The engine takes back the server's record after a refusal, so the person's change goes away: undoing it unsaid is worse than saying so. Only a client bug or a client older than the server's rules produces these; a create the server already holds stays silent (`sentTwice`, engine.ts) |
| `tree.section`, `section.notEmpty`, `page.notTrashed` | Each says what another device did meanwhile: the page moved under went to another section, so the page stayed (a refused create: the new page or row was not made); pages were put in the section, so it was not deleted and is back; the page was restored from the trash, so nothing was deleted. The two that name a page link to it | The local planner refuses the same rules, so the server refuses these only after a change elsewhere |
| A notice with no page | Names none | Its title would read "Untitled" (a refused create, a section) |
| `access.denied` | Keeps its text, which speaks of a recovered page | Asked for unchanged; an operation refused for access (a guest making a section, a cover file not readable) still reads that way, a follow-up |

## 2026-11-15: Phases 8 to 10 (the Later list reviewed)

Phase 7's definition of done asks for "Later" to be reviewed with you. The plan's "Later" list and
what Phases 3 to 7 left for later were put to you in one batch; two answers were then checked
with you. The phases are in `IMPLEMENTATION_PLAN.md`.

### Answered by you

| Question | Answer |
| --- | --- |
| Editor and database items | All four offered: bulk cell editing (multi-cell selection, copy and paste with Sheet and Excel, board columns and gallery cards dragged), import (Markdown folders, a Notion export, Word `.docx`), the timeline view, and a public page site |
| Collaboration and account items | Email notifications for mentions and replies. Groups in permissions, comments offline, passkeys and single sign-on stay on "Later" |
| ERP, AI and plugin items | All three: Customers and Items on hand editable (Tracks E8 and E9), AI search by embeddings, third-party plugins in sandboxed iframes. "None yet" was ticked with them; asked again, the answer was all three |
| Platform and hardening items | The reliability follow-ups (the web kill test's loss after "Saved" on run 43746282731, the server's work per push, CI's work per key), Track U's components with the stand-ins listed since Phase 4, and the workbook gaps (workbooks in the workspace export, a workbook's version history, Sheet's desktop deep link). The Linux build stays on "Later" |
| How to split them | Three phases, each its own release, all planned now and built one at a time: Phase 8 (`v0.8.0`) hardening and moving in: reliability, Track U, bulk cell editing, import, email. Phase 9 (`v0.9.0`) publishing and views: the public site, the timeline, the workbook gaps. Phase 10 (`v0.10.0`): Customers and Items on hand editable, embeddings, third-party plugins |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| What was not offered as a choice | Kept on "Later" with its reason: snapshotting an ERP view (it would store ERP data in a Workspace table, which the hard limits forbid), embedded presentations (no app yet), a mobile app, `@cashgear/app-kit` (D1), SQLite on OPFS (D11), Yjs 14 (its binding), a backplane (Q17's measurements), AI's subscription and local-model modes, ERP reports, pins holding rows' documents, a screen-reader pass on the grid, an end-to-end test of access lost without a feed change | Each needs something that does not exist yet, or a measurement says it is not needed |
| A workbook's version history | In Phase 9 | It was listed beside the smaller deferrals kept on "Later", but the "Workbook gaps" choice you picked named it in its description; the choice wins |
| The order of the phases | Reliability first in Phase 8, before more features; Track U in Phase 8, so Phase 9's timeline is built over the library (U18) | Text reported saved and then lost is the worst failure the app can have; the hard limits put generic components in `CashGear.React.UI` |
| Track U's numbering | U9 to U17 are the stand-ins Phases 4 to 7 listed in `PROGRESS.md`; U3 gains the drag copy and edge scrolling; U18 is the timeline | One list in the plan for what the track builds |
| Track S6, E8 and E9 | Added to the plan's track sections now and to `INTEGRATIONS.md` by the phase that needs them; E8 starts once E1 to E7 are pushed (yours) | Those repos change only as agreed tracks; nothing is built on unpushed work in another repository |
| Embeddings, as found on 2026-11-15 | Anthropic offers no embedding model; its documentation (platform.claude.com, "Embeddings") points to Voyage AI: `voyage-4` over an HTTP API, and `voyage-4-nano` open-weight under Apache-2.0. Phase 10's question starts from this | The 0.7.0 AI is Anthropic only, so embeddings need a second provider or a local model |
| Version numbers | `v0.8.0`, `v0.9.0`, `v0.10.0` | One version per phase, as before |

## 2026-11-16: Phase 8

### Answered by you

| Question | Answer |
| --- | --- |
| Track U: who builds it, and on which branch | A session of its own in `CashGear.React.UI`, on the branch both pins follow, `claude/cashgear-react-ui-library-xq8tsz` (the library has no `main`). Workspace moves its pin as each component lands; Sheet moves its own pin when it chooses |
| Strict durability | If Chrome is shown to lose IndexedDB writes it reported complete with the whole process tree ended: document writes use strict durability and "Saved" waits for it, as long as the 1 s durability budget still holds |
| Paste past the last row, and taking a paste back | A paste past the last row adds rows, at most 1,000 a paste. The notice after a paste offers Undo, which writes the old values back (databases have no undo yet) |
| Where import runs, and its limits | On the device, so it works in a local workspace and the server never opens an uploaded archive. At most 2,000 pages and 500 MB an import |
| Email: the choices, the default, the sender | On by default: mentions and replies still unread, at most every 15 minutes; a daily digest or off by choice. Sent from the SMTP account already set (`Smtp__From`) |
| Chrome's own loss of writes it reported complete (asked after M8.1 found it) | Build a journal of unsent document updates in the Origin Private File System in Phase 8, which "Saved" also waits for. Asked because strict durability does not prevent the loss: Chrome's LevelDB on Windows can leave a torn log record when killed between a record's two writes, and a later start then drops the next session's writes silently or deletes the origin's whole IndexedDB |

### Defaults picked (say if any should change)

Reliability (M8.1):

| Choice | Default | Reason |
| --- | --- | --- |
| Which of the web store's writes are strict | What this device made and the server may not hold yet: a page's own updates, the session's operations, an asset's bytes, a log a repair replaced. What came from the server (acks, pulls, frames, cursors, the feed, settled operations) stays relaxed | Your answer's condition holds: Chrome is shown to lose writes it reported complete with the tree ended. Strict closes the operating-system crash and power-cut hole relaxed leaves, at about 3 ms a write; the server's data can be fetched again and is most of the store's traffic while live |
| A block-sized first write at each start, to start past a torn log record | Not done | Measured worse: Chrome's open then fails on the checksum and deletes the whole store (20 of 20) |
| The journal | Every document update this device makes (a save, a repair's merged update) also goes to a file of the tab's own in the Origin Private File System (`cgw-journal/<tab>.<generation>.cgwj`) through a dedicated worker's `FileSystemSyncAccessHandle`: a length, a CRC-32, the page id, the update id, its local sequence and the bytes, flushed. "Saved" waits for it and for IndexedDB's strict commit. At open each tab cuts its own file at the last whole record | Your choice. A file the page writes itself never appends after a torn record, which is what Chrome's LevelDB does |
| What the journal does not hold | Operations (titles, moves, properties), assets and preferences | Document updates are what is typed; operations are small, few and in the outbox too |
| When an update leaves the journal | Acknowledged by the server, covered by a local-only page's compaction, set aside, or its page removed; forgets reach other tabs over a `BroadcastChannel`; a gone tab's file is taken over and removed at the next start of any tab | A tab never writes another's file; no sweep of its own |
| At each start | Every journal file that can be read is checked against the store by update id and local sequence: an update with no row in its page's log, at or past the log's next sequence, goes back in as unsent; one below it was taken by a compaction, repair, set-aside or removal and is forgotten; one whose page is not in the store (Chrome deleted it) waits until the workspace comes back from the server, then goes in as unsent and is pushed as the device's own | A forget lost in a crash never brings an update back; the server keeps an update id once and Yjs a struct once, so nothing applies twice |
| Bounds | 64 MB of needed updates a tab (past it the journal is skipped, `full`, until forgets make room); updates for a page that does not come back kept 30 days; the store waits for the journal's recovery at most 3 s, else it is off for the session | Bounded in space and time; a worker that does not answer never holds the first editable page |
| Where the journal cannot run | Off with the reason (no sync access handle: WebKit before 15.2; no OPFS: Firefox's private windows; a worker that does not start), the store as before | Your answer: degrade to today's behaviour and say so |
| A refused operation's notice | The engine names the refused operation (`refused: { type, fields? }`) and the shell picks a text by it for `access.denied` (a new section, a cover file not readable, a move, a new page or row, the workspace name, the trash, and others): what was refused, and that it was undone. A document's `access.denied` (set aside) keeps the recovered page's text | The decision of 2026-11-15 left this for Phase 8 |
| What the kill test records | Each completed log write the page saw before the kill, the save status's changes with its text, the store's sequences, the journal at every start, LevelDB's and Chrome's own log lines; kills during a live push counted (`killsWhile.hubPush`); the compaction probe matching `compactDoc`'s stores | A failure says whose it is without another run. Since Phase 6 no kill while pushing through the hub was counted, and since Phase 4 no kill aimed at a compaction |
| CI's kill-test run counts | 25 runs a kill test, as before; the 1,000-run evidence is taken locally, a phase at a time | Chrome's loss is about 1 in 3,000 sync kills and likelier on a crowded runner: CI's counts cannot bound it |
| CI's work per key (Phase 5 to Phase 6) | Recorded, not changed: turning the hub off shows the live page costs about 0.6 to 0.8 ms of work a key at the median and about 1.5 ms at p95 on four processors, Chrome's processes twice the CPU while live; the save status and the relay's frames back to the typist ruled out. `bench/phase5.mjs` and `bench/phase6.mjs` now record each part's CPU over the typing (`bench/cpu.mjs`), and Phase 5's keys also typed off the hub as a control | What is left is the save every 30 to 60 ms and its push, and the server's work per push, on CI's four shared processors; the server's half (below) is the remedy that needs no product change |
| The sync status at a start | "Syncing" from the moment an account is signed in, not "Signed out" until the first pass ends | The desktop showed "Signed out" for about 210 ms at one start in five (the kill test's 1,000 runs) |

The server (M8.1, M8.5):

| Choice | Default | Reason |
| --- | --- | --- |
| A validation pass's loads | Each state a pass checks is loaded once (`cgw-ydoc`'s `Loaded`), and its meta, its tree and the state hash are read from that load: one update, or a batch that passes, loads one document; a batch with a refusal one for the batch and one for each update tried alone. The passed state's state vector is kept for the next pass's forgery check | 0.7.0 loaded the document three times an update and decoded the state about nine times; the checks, their order and their texts are 0.7.0's (`ValidationLoadTests`) |
| Round trips of a push | Worker: a pass in four. API: the page gate in one query; the push's transaction in one round trip for up to 500 updates (the same steps, outcomes and texts); the relay's heads and one-row frames on its own open connection. Raw SQL only in named, tested methods; ids as `binary(16)` in RFC order; lists as one OPENJSON parameter | EF's work per statement was most of a push: SQL statements a push from 16.5 to about 4 (API) and 14.7 to about 5.7 (worker) |
| The hub's push | The gate's read and the push's transaction in one batch when that read alone decides the caller may edit (the private section's owner; an owner or admin in a shared section; a member no page of the chain restricts or has a row for); otherwise the gate decides on the row read and the push follows; a request its own checks refuse takes the two steps. The HTTP route keeps two steps | The same answers and texts in the same order (`RealtimeTests`, 14 callers over both); the push step's CPU 27 % lower |
| Measuring the server's CPU per push | In process (`Phase8Bench`, `PHASE8_BENCH=1`: 900 keys after 450 warm-up) and over real processes (`bench/phase8-server.mjs`: 0.7.0 built from its tag and this build, each a stack of its own on its own ports and database, alternately; one typist at a key every 35 ms with presence as the app sends it, a second member on the page; 60 s of warm-up; CPU per push = (typing - idle) / pushes) | A few hundred calls measure the JIT, not the code; the acceptance is the API's and the worker's own CPU |
| A derive that loses a deadlock | Done again from the start, up to 3 times (SQL Server error 1205); its references deleted by seeking the page's index | Seen once in the suite; a derive is idempotent and its transaction rolls back whole |
| The delay and spacing of mail | One setting, `Mail__NotificationDelaySeconds` (900): a notification is mailed once unread that long, and a person gets at most one mail in that time, holding everything waiting | Your answer's "still unread, at most every 15 minutes" |
| The digest | A day from the last mail and from choosing the digest, with everything waiting | Once a day, with no time zone known of a person |
| Old notifications | Not mailed after 3 days, nor anything made before mail was last turned on | A backlog after a stop, or a turn back on, is no news |
| The unsubscribe token | Data Protection (`Cgw.Mail.Unsubscribe.v1`) of the account id and `MailSettings.Stamp`, no expiry; turning mail on again after off gives a new stamp, which voids every earlier link. Both processes share one key ring | A replayed old link must not undo the person's own later choice |
| The unsubscribe addresses | `List-Unsubscribe: <{Api__PublicUrl}/mail/unsubscribe?token=…>` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; a GET there shows a button, a POST turns mail off; `POST /api/v1/mail/unsubscribe {token}` too; the same answer for any token | RFC 8058; a scanner opening the link turns nothing off; no oracle for tokens |
| The queue's content | No address, subject or body: a mail is made when it is sent, from the notifications that name it, each checked unread and readable then | "Access checked again when sending", exactly; nothing personal kept beside the notifications |
| Retries | After 1, 5 and 15 minutes, 1 and 4 hours, then given up; a failure logged by its type and SMTP status only | An SMTP server's temporary failures pass in minutes; logs never hold content |
| The daily cap | 1,500 notification mails in any 24 hours (`Mail__DailyCap`); what is over waits | Below Google Workspace's 2,000 a day, leaving room for the account mails on the same account; a personal Gmail account allows 500 |
| Account mails | Stay in the API's in-memory queue | Each answers a request the person can make again |
| The mail's words and headers | The inbox's sentences, the name and title in `<bdi>`, `lang` and `dir` on the HTML, a plain-text part, `Auto-Submitted: auto-generated` | As the inbox reads; no auto-replies (RFC 3834) |
| The mail settings in the client | A section after the account's in Settings, signed in only; each choice saved at once; a failed write puts the saved one back | As the other settings |

The library's components (M8.2):

| Choice | Default | Reason |
| --- | --- | --- |
| The pin | `@cashgear/ui` moved from `ef1277e` (Phase 0) to each Track U commit as it landed, in every package that names it, with `pnpm-workspace.yaml`'s build allowance | One version of the library everywhere; Sheet keeps its own pin |
| What the library lacks for a stand-in | The stand-in stays for that case, and the gap goes to Track U's session; never a change to the library from here | The hard limit: other repos change only as their track |
| The option picker | Kept the app's own: `CgOptionPicker` matches names with its own folding and takes no matcher, which would drop Workspace's Arabic search rule (`normaliseText`) | Search must agree on the device and the server; a `normalize` or `filter` prop is asked of Track U |
| The import's folder picker and section select | Kept: `CgFilePicker` has no folder mode, and the library has no single-choice select | Asked of Track U |
| Two library defects found by the swaps | `CgCommandMenu`'s detail and shortcut on the active option (4.36:1) and `CgMentionArea.getValue()`'s empty lines: a local override and the composer reading its own area | Asked of Track U; the shell's workarounds go when it lands |
| The block handle's drag | A pointer drag (`cgTrackDrag`) instead of HTML5 drag; the one handle stays ProseMirror's | The library's helper is pointer-based, as the board's has been since Phase 4; touch works the same |
| The comments drawer's size | `min(20rem, 85vw)` | `CgDrawer` now takes `min()`; unchanged at 390 px and wider |
| Two live regions in a database view | The table's row count (`role="status"`) and `CgLiveAnnouncer` side by side; specs find the count by its footer | Each says something different; the announcer speaks moves and pastes |

Bulk cell editing (M8.3):

| Choice | Default | Reason |
| --- | --- | --- |
| Where the notice after a paste or a clear is | The view's own notice under the table: what changed and what was left, Undo and Close; it stays 15 s, longer while the pointer or the keyboard is on it; Ctrl+Z on the table runs its Undo | It sits next to the cells it speaks of and works over any host. An embedded database scrolled far away (its frame unmounts) loses its notice and Undo |
| Undo of the rows a paste added | They go to the trash (`page.trash`), not deleted for good | The least destructive way to take them away; another device may have edited one since |
| Undo of a cell changed since the paste | Keeps its newer value; the notice counts it | Undo never overwrites a later edit, here or elsewhere |
| Options a paste needs | Made as a type change makes them (`convertProperty`: ids derived from the database, the property and the name), in one `db.update` first in the paste's batch; Undo leaves them | Every device makes the same option for the same name; removing them on Undo would empty values others may have set to them since |
| What a paste reads beyond the conversion table | A paste-only reading (`clipboard/read.ts`) of what Excel and Sheet show in the device's language (`navigator.language`). Numbers, before the table: the locale's separators where it places them, `٬` `٫`, Arabic-Indic digits, one currency symbol or code before or after, a minus before or after or accounting parentheses, a percent as the fraction on a percent-formatted property and the number as written otherwise. Dates, after the table's ISO: the locale's numeric short date (its order from `formatToParts`), `/` `.` `-`, two-digit years by Excel's 1930 to 2029 window, four-digit years from 1900, an optional time with AM, PM, `ص` or `م` on the device's clock. People: an exact member email (any case) or an exact display name only one member has. Checkboxes: the table's words and Excel's German WAHR and FALSCH. Everything else refused as before | Excel copies what it shows. The conversion table and its C# port read canonical text and never see a paste, so they are unchanged. `1,234` is 1.234 on a German device, so the locale reads numbers first; a date that does not fit the locale's order is refused, not guessed; the 1900 floor keeps a Hijri date from being stored as a Gregorian one; a name two members share could pick the wrong person |
| Files and related rows pasted as text | Refused and counted | Titles and file names are not unique; the tab's own copy carries their ids |
| A paste of what this tab copied | Recognised by its text; each value converted from its own type (`convertValue`) | Dates, people, related rows and formatted numbers as shown do not read back from their text; Sheet does the same |
| Copy's text and HTML | As shown (number formats, dates in the interface language and time zone, names); checkboxes TRUE or FALSE; no CSV guard; the HTML a plain table in the interface's direction | "Pastes into Excel as shown"; the export's guard is for files that travel |
| What a paste reads, and where it writes | `text/plain` as TSV, an HTML table only when there is no text; from the selection's first cell, the clipboard's size; a single value fills a larger selection; whitespace alone clears a cell | As Excel and Sheet paste |
| Rows past the last row | Added after every row, as a row made in the view (the last pasted row's group, the filter's values), at most 1,000 a paste; none while the view has rows still to load (counted, the notice says so) | Your answer; rows past the loaded ones would land at the database's end |
| Delete and Backspace | More than one cell: every editable cell cleared in one batch, with the notice and Undo; one cell as before | One cell is a keystroke to retype; a range is not |
| Selection keys and pointer | Shift with the arrows, Home, End, PageUp or PageDown; Shift+Space whole rows; Ctrl+Space whole columns; Ctrl+A everything; Escape lets go (by `event.code`); a handle at the start of each title cell for whole rows; Shift and a click on a header for whole columns | Excel's and Sheet's keys; the table's geometry stays as it was; a plain click on a header has opened its menu since Phase 4 |
| Copy and paste on the grid | The browser's `copy` and `paste` events on the focused grid, `beforecopy` and `beforepaste` cancelled so Chromium and WebKit offer them with nothing selected | No clipboard permission; the same in WebView2 and WKWebView |
| A board's column order | The view's `group.order` (group keys), one `view.upsert`; queries and the C# port ignore it | Per view; the property's option order stays for sorts, pickers and other views; syncs as view settings do |
| A gallery's card order | The rows' order keys (`page.move`), as a board's moves within a column; a sorted gallery does not drag cards (a note says why) | One manual order per database, as the table and board have |
| Titles of a large batch in search | More than 50 titles in a batch: indexed one row at a time in the background | A paste's new rows are found by search without the paste waiting for 1,000 document opens; a device CSV import indexed none before |

Import (M8.4):

| Choice | Default | Reason |
| --- | --- | --- |
| Where an import lands | One new page at the end of a chosen section (the sections the sidebar offers "Add a page in"); an import whose root is one page makes that page the top; several get a page named after the zip or folder ("Imported from Notion" for a Notion export) | Never writes into an existing page; one page holds everything, so removing it removes the import |
| What the 2,000 pages count | Pages, databases and rows, the top page included | Rows are pages; it keeps every database under the device's 5,000-row limit, so every row is planned on the device and `POST /databases/{id}/import` is not used: one write path and one rollback, and the server never sees the CSV |
| A failed or stopped import | Its top page trashed and deleted for good in one `apply`; its search entries deleted; asset bytes stay on the device (the local store has no asset removal; the server's 30-day sweep takes unreferenced uploads). A member without full access in a synced workspace cannot delete for good: the import then stays in the trash | The planner's delete takes pages, databases, views, rows and documents together |
| Planning and write order | Everything read and planned in a worker (`import.worker.ts`); the main thread writes assets, then operations 500 an `apply` (parents first, relations, rows, rows' relations), then each page's first document | The page stays responsive on 500 MB; no reference reaches the server before its asset |
| XML for Word | Our own reader in `@cgw/doc` (`xml.ts`): no DTD, depth capped | DOMParser does not exist in a worker; no entity expansion; `@cgw/doc` stays DOM-free |
| Markdown or Notion | Read with Notion's rules when most `.md` and `.csv` names carry a 32-hex id | A person picks the wrong kind easily; ids left in titles help nobody |
| Notion's cells | Dates `Month D, YYYY` to `YYYY-MM-DD` (a time to that local instant on this device); a column is a relation only when every page its cells name (`Name (path.md)`, a notion.so address, or plain names in a text or select column, every name a title in exactly one database) is a row of one database of the export, two such columns naming each other's rows both ways paired as reverse relations; a files column only when every part is a file of the export that can be kept; people columns (told by their names) and anything naming pages or files outside the export stay text, reported | A typed property cannot hold both; an export holds names, not members; files outside it cannot be fetched |
| Row pages | Matched to the CSV's lines by title, in order; a page with no line becomes a row with its title only; pages under a row go beside its database (both reported) | Notion's CSV has no id column |
| Links | Text equal to the target's title: a `pageMention`; other text: the link mark to `#/p/<id>`; alone on a line to a child page: a `childPage` block; to a child database: a `databaseView` block; to another file: a `file` block; a notion.so address by the page's id | How the editor itself links pages |
| Folder pages and order | `X.md` beside `X/`, `X/X.md` (this app's export) or `X/index.md`, else a page made for the folder listing its pages; siblings in the order the parent links them, then by name | The three layouts people use; Notion links children in order |
| Word | Empty paragraphs left out; the first paragraph in Title style is the title; headings deeper than 3 are 3; code by a code style or monospace runs; tracked changes read as accepted; comments, footnotes, text boxes, equations, charts, shapes, objects, headers and footers counted in the report, not imported | What a person sees in Word, within the schema |
| Markdown in for paste | Hard breaks, `===` headings, a list's start, `<url>` bookmarks, autolinks and CommonMark escapes apply to a paste too; links, images, HTML, front matter and equations only with an import's options | Resolving them needs the import's files |
| Limits beyond your answer's | 20,000 files; a ratio of 1,000:1 past 1 MB; archives in archives 2 deep; 32 path parts; pages 24 deep; images 16,384 px a side and 100 MP; files 25 MB; a database CSV 20 MB; lists 32 deep | Each bounds memory or stack against a hostile file, well above real exports |
| Paths and names | `..`, absolute paths, C0 controls and DEL left out and reported; zip names without the UTF-8 flag read as UTF-8 when valid, else Latin-1, reported as possibly garbled | macOS, 7-Zip and others write UTF-8 without the flag; Windows' own zip writes the OEM code page, which cannot be known |
| Files kept | Typed by their bytes as the server sniffs them, only the server's allowed types; images on the web kept as links, not downloaded | The engine's upload is never refused; an import makes no network call of its own |
| Guests | The import is not offered | The server refuses a guest's pages |

## 2026-11-17: Phase 9

### Answered by you

| Question | Answer |
| --- | --- |
| The site's address and host | `pages.cashgearerp.com`, an origin of its own: its own IIS site and its own small process (`Cgw.Sites`) beside the API on the API's host, with no sign-in code and no cookies, reading the database and storage. As in Phase 2, the package and the install script are built and rehearsed here; the DNS record, the certificate and running the install are yours |
| Custom domains | Not in 0.9.0: every site is `pages.cashgearerp.com/<slug>`. Custom domains go on "Later" |
| Search engines | Not indexed unless the publisher turns indexing on for that site: every page sends `noindex` and `robots.txt` disallows the site until then |
| Databases on a published page and on a share link | Their rows, read-only, through the block's own view (its filter, sorts and shown properties), and a full-page database by its first view; on published sites and share links alike. Row pages stay closed. Supersedes Phase 4's note on a share link |
| Workbooks on a published page | A placeholder, as on a share link: nothing of a workbook leaves its workspace (Phase 5's answer stands) |
| The timeline in Arabic | Time runs right to left in Arabic, left to right in English |
| Tracks U18 and S6 | Two sessions of their own, started now: U18 in `CashGear.React.UI` on the branch both pins follow (`claude/cashgear-react-ui-library-xq8tsz`), pinned here by commit as in Phase 8; S6 in `cashgear-sheet` on its `main`, to its own rules. Workspace uses a stand-in and Sheet's web app meanwhile |
| Who may publish | Anyone with `full` on the page. A workspace setting for owners and admins, on by default, turns publishing off, and turning it off takes every site of the workspace down at once |

### Defaults picked (say if any should change)

Publishing (M9.1):

| Choice | Default | Reason |
| --- | --- | --- |
| What a site holds | A share link's scope, decided when it is read: the root and its subtree, never restricted pages, pages hidden from the workspace, what is under either, or trashed pages; the root trashed, deleted or moved into a private section answers 404 until it is back. Never comments, presence, history or Yjs updates | One scope rule for everything readable without an account (DATA_MODEL.md); a site never shows a page the publisher could not have shared by link |
| Who publishes, and where | `full` on the page, in a shared section of a synced workspace; never a private section or a row. A guest with `full` on a page may publish it, as they may make its link | A share link's rule; a row's access is its database's |
| The switch turned off | Every live site of the workspace is unpublished at once (each audited, reason `publishing.off`) and publishing is refused while it is off; turning it on again brings no site back | Your answer's "takes every site down at once"; a site coming back by itself after an emergency stop would surprise |
| A site's address | `pages.cashgearerp.com/<slug>` and `/<slug>/<pageId>`; a slug is 3 to 63 of `a-z`, `0-9` and `-`, unique among live sites of every workspace, freed when unpublished; reserved words and anything starting with `_` refused; the client proposes one from the title (an Arabic title gives `page-` and 8 hex of the page id) | One origin for every workspace (no custom domains in 0.9.0); ids in page addresses keep a rename from breaking links |
| The site's own words | English or Arabic, chosen by the publisher (default: their interface language): navigation, placeholders, counts and dates, `lang` and `dir` on the page; each block keeps its own direction | The reader's `Accept-Language` would double the cache and make a page read differently to each visitor |
| People on a site and on a share link | No names: a person's mention reads `@` and "someone", person, created-by and edited-by cells are empty | A member's name is personal data the publisher did not type; a share link carried none before |
| A database's rows on a site and a share link | Through the block's own view (its filter, sorts and group; a title search on a share link), never a filter, sort or group the reader sends; only the view's shown properties' values leave the server; related rows' titles only when their database is in scope; row pages closed. A database block on a site shows its first 100 rows, a full-page database 500 a page | Your answer. A filter on a hidden property would let a reader probe its values; a relation must not name rows outside the scope |
| Charts and boards on a site | A chart drawn on the server as SVG with its data as a table; a board as columns of cards; both from their view's rows as above | The site runs no script; the table keeps the chart's numbers readable |
| Files and images on a site | `/<slug>/files/<assetId>`, a redirect to a signed blob URL of a few minutes, checked against the site on every request (shown by a page in scope, or a file cell of a shown property of a database in scope); images inline, other files as downloads | The page's HTML can be cached while each file is still checked; the blob account's signed URLs are the existing path |
| The Sites process | Its own process and IIS site (`CashGearWorkspaceSites`): no Identity, cookies, antiforgery, CORS or session; no Yjs library; reads SQL and Blob with the API's configuration names. Every answer carries `default-src 'none'` with one hashed stylesheet and images from the site and the blob account, `nosniff`, `no-referrer`, COOP and CORP `same-origin`, never `Set-Cookie`; no script at all (toggles are `<details>`) | Your answer: a published page must not be able to read the app's or the API's session, and a process with no session code cannot hand one out |
| Development and e2e address | `http://localhost:5290`, not `127.0.0.1` | The API and web app are on `127.0.0.1`, and cookies are per host, not per port: the session test needs another host |
| Caching | The slug's site and scope cached at most 30 s in the Sites process; rendered HTML cached in memory by the site's version, the page's derived sequence, the scope's titles and icons and every shown database's versions; every answer `Cache-Control: no-cache` with a strong `ETag` | An unpublish holds within 30 s, inside the criterion's minute, and a reader's browser asks again every time |
| Indexing off | `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` on every answer; `robots.txt` disallows everything but indexed sites | Your answer; both forms, since a crawler may read only one |
| Audit | `site.publish`, `site.update`, `site.unpublish` (reason `person` or `publishing.off`), `workspace.publishing` | Each publish and unpublish, as the plan asks |

The timeline and the date window (M9.2):

| Choice | Default | Reason |
| --- | --- | --- |
| The view's settings | `timeline: {start, end?, lane?, scale?, undated?}`: a date property (its own range gives the end), an optional second date property for the end, an optional select or status property for lanes, `day`, `week` (default), `month` or `quarter`, and the list of undated rows beside (default on) | The plan's "a date property's range or two date properties"; Notion's choices |
| The window | `window: {propertyId, endPropertyId?, from, to}`, inclusive dates: a row is in it when its span meets the window (start from the property, end from the second property, else the property's own end, else its start; an end before the start is the start), counted by calendar date in the query's offset; a row with no start is never in a window. Applied after the search and filter, before sorts and groups | The plan names `{propertyId, from, to}`; a timeline of two date properties needs the second; the filters' date rule, so the device and the server agree (shared vectors) |
| Undated rows | Their own query: no window, a filter `isEmpty` on the start property | A window can only hold dated rows |
| An older build that meets a timeline view | It draws it as a table (its fallback since 0.4.0) and may send it back as a table. New builds send `viewTypes: 6` with every `view.upsert`; an upsert without it keeps the stored type when it says `table` and keeps every stored setting it does not carry. A real change of type by an older build is taken | The plan's risk: the server keeps what an older client does not send. Only the server can tell what was sent from what was dropped |

Workbooks and Sheet's desktop app (M9.3):

| Choice | Default | Reason |
| --- | --- | --- |
| A workbook in the export (format version 3) | Each workbook the exporter can read that has a version: its newest version as `workbooks/<name>.xlsx`, its id and name in the manifest. A sheet block's own view (sheet, range, chart, height) is already in the page that holds it; pictures are drawn again by the embed | "Its name and view settings": a workbook keeps no view of its own, the blocks do |
| Workbooks on import | Made again in an import done while signed in, once the new workspace is on the server (`POST /workspaces/{id}/workbooks`, then the bytes as version 1), with every sheet block pointed at the new workbook; a local import keeps the blocks and its report says how many workbooks it skipped | The plan; a local workspace has nowhere to keep a workbook (Phase 5) |
| Uploading a version | `POST /workbooks/{id}/versions` for someone with `edit`: the xlsx with `If-None-Match: *` or `If-Match`, as Sheet's own save | Import needs it; one rule for every save |
| A workbook's history | Its kept versions (the newest 10) with time and saver; one opened read-only in the embed by its own signed URL; restore copies the old bytes as a new newest version saved by the restorer, with `edit` or above, audited `workbook.restore`; a reader is refused | The plan; a restore never removes a version |
| Sheet's desktop app | Opened by `cashgear-sheet://workspace/launch#ticket=…` when the system says something handles the scheme, else Sheet's web app as before; a desktop ticket redeems only from the desktop origins and a web ticket only from Sheet's web origins; no PKCE (INTEGRATIONS.md, S6) | A program that could take the link could already read Workspace's own sign-in from the keychain; the ticket stays one use, 120 s, in the fragment |

Built in M9.1 to M9.3 (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| What of a row leaves a share link or a site | The view's shown properties and those it lays rows out by (its group, a calendar's date, a timeline's start, end and lane, a gallery's cover property); never a person, created-by or edited-by, a formula that reads one, or a rollup whose relation leaves the scope; a relation cell only rows of databases in scope; a view grouped by a person read ungrouped; a row's times only when the view shows a created or edited time | The layout properties' values are what the view already shows by position; people are never named; an aggregate out of the scope would sum what the scope does not hold |
| A share link's database definitions | Every live property's definition (names, types, options, formulas); values only through the query | A view draws by its definitions; values are what is guarded |
| A share link's query | The view's id, paging by an opaque offset (never sort keys), a title search, today and the offset; a window only on a visible property; never a filter, sort or group from the reader. A block grouping another way gathers its view's rows (pages of 500, at most 2,000) and groups them on the device | A members' keyset cursor holds sort values, which may be a hidden property's; a window on a hidden date would probe it |
| A file a share link or site reads | Content and covers of pages in scope, a row's cover, a file in a file cell of a property some view of its database shows | A file of a property every view hides is never shown |
| CSRF on `/api/v1/shared/*` | Not checked: those routes never read the session | The token is a header no other site can send |
| The older build's settings kept | The settings a build before 0.9.0 cannot know (anything but `filter`, `sorts`, `group`, `properties`, `calendarBy`, `cover`, `cardSize`, `wrap`) that it did not send; one it knows is taken as sent, even removed | Otherwise an older build could never turn `wrap` off by dropping it |
| A site's root deleted for good | The worker's purge unpublishes it (reason `page.deleted`, audited by the system) | Nobody can reach the page to unpublish it, and its slug would stay taken |
| Headings, dates and names on a site | The page's title the one `h1`, the document's levels as `h2` to `h4`; dates as `1 December 2026` in the site's language with Western digits, an instant with its UTC time; a page outside the site named "a page", never linked, and a child-page block for it drawn as nothing | One `h1` a page; no reader's time zone without script; a restricted page's title must not leave |
| Views and charts on a site | A board as columns of cards, a gallery as cards, a table, list, calendar or timeline as a table; a chart grouped only by a shown property and measured only by a shown number, formula or rollup (else its placeholder), as bars, a line or a pie in SVG coloured by the stylesheet's classes, its numbers always as a table | No script to draw a calendar or a timeline; no hidden value through an aggregate; the CSP allows no inline style |
| A huge or hostile document on a site | Tables cut at 2,000 rows and 100 cells a row, with a note; blocks nested past 40 levels a placeholder; JSON parsed to depth 512 | A hostile document must not make a page that cannot be drawn |
| Slugs the Sites process looks up | Only well-formed ones reach the database; anything else is the 404 page; an unknown slug is remembered 5 s | Junk addresses cost nothing |
| `robots.txt` for an indexed site | `Allow: /<slug>$` and `Allow: /<slug>/` | `/<slug>/` alone would not allow the root address |
| The Sites process on IIS | Its own app pool and identity (`IIS AppPool\CashGearWorkspaceSites`, `db_datareader` only, read access to the Azure certificate file); bodies over 64 KB refused; `Server` and `X-Powered-By` removed; the API refuses to start in Production without an https `Sites__PublicUrl` (`install.ps1 -SitesHostName`, default `pages.cashgearerp.com`) | It only reads; a production API must give real addresses |
| Where publishing is in the app | A second view of the share dialog ("Publish to the web"), for `full` on a page that is not a row: what will be published, indented by depth, and how many pages are left out (never their titles), the slug, the site's language, indexing; then the address, Save changes with `If-Match`, Unpublish after asking. Settings has the switch for owners and admins (off asks with the number of sites it takes down) and the live sites | One place for who can read a page; the plan's list before publishing |
| A workbook's history in the app | "Version history" in `#/workbooks` and in a sheet block's menu; a version shown read-only in the embed (its first sheet's used cells, at most 420 px high); restore asks first, sends `If-Match`, and is never offered for the current version | Both places show a workbook |
| Workbooks an export cannot read | Counted and said; with the account out of reach none are read, the pages exported anyway, and said. "Export this page" holds the workbooks its sheet blocks show | An export keeps data; a missing workbook is said, not fatal |
| An import while signed in | The new workspace goes to the account, then its workbooks are made there, whether or not the export holds workbooks; an upload that fails leaves the workspace on the device, whole, and says its workbooks were not made | A workspace made while signed in already goes to the account (since 0.2.0); one rule for both |
| Is Sheet's app installed | Asked of the system on every click; on macOS opened through LaunchServices' `LSOpenCFURLRef`; a desktop request answered with a web link opened in the browser as before; `CGW_SHEET_APP` and `CGW_OPEN_URL_FILE` for tests, as `CGW_AUTH_URL_FILE` | An install between clicks counts; no Objective-C runtime or new crate |
| The slug proposed for an Arabic or too-short title | `page-` and the page id's last 8 hex digits | A UUIDv7's first 8 hex digits are its time (a step is about 65 s), so pages made a minute apart would be offered the same address |
| A window on a property that is not a date | The start must be of kind date (a date, a created or edited time, a date formula or rollup) and not deleted, else nothing matches; an end property that is not one is not used; a window that does not read matches nothing on the device and is 400 on the server | One kind rule with the filters; never a silent full scan |
| Where `viewTypes` is added | At push (`http.ts`), to every `view.upsert` | Every builder of a view upsert is covered, and the store never holds it |
| Views that read their own rows | The calendar and the timeline (`ownRows`): the database view runs no query for them and gives them its own (`ViewProps.request`); their rows with no date come by a query of their own, which a share link asks by `undated` | The window is the view's; a share link takes no filter from a reader |
| The calendar's bound | 5,000 rows a window ("Showing the first N rows of these weeks"); the whole-database cap and its note go | As decided; a month of more than 5,000 rows is still bounded |
| What the timeline fetches and draws | The days shown first, then those days and as many again on each side, out to whole months (asked again only when the days shown leave it), the two drawn merged in the view's order until the wide one is in; its lines are the rows the days shown hold, in the view's order | A scroll of less than a screen asks nothing new; `CgTimeline` cannot bring its lines to the days shown, so a first screen of every row would be lines with no bar in sight (asked of Track U) |
| A new timeline view | The first date property, sorted by it ascending, by weeks, the undated list on, only the title shown; the zoom written to the view by an editor, a reader's kept on the device until the page closes | Bars fall away down the lines; the view's settings are shared |
| Lanes and a dropped row | The select's or status's options in order, then "No {property}" for rows with none or a deleted option; a row dropped from the undated list takes that day, and the lane under the pointer | The brief's order; U18's `laneAt` |
| Moves and resizes | One `row.update` each, by pointer or keys (Alt and an arrow a day; Alt, Shift and an arrow the end; Ctrl, Shift and an arrow the start; mirrored in Arabic, where time runs right to left); a date stays a date, a date with a time keeps its time | U18's keys, none on AltGr |
| The Projects template | Its "Timeline" view (a calendar since Phase 4) is now a timeline by Dates, laned by Status, by months | The name always meant it |
| Old builds in the specs | v0.7.0 on 4274, v0.8.0 on 4272, beside this build's 4273 | Each released build meets the views of the one after it |
| A server query's rows kept on the device | After the answer is returned, not before: one answer at a time, in the order answered (`kept()` waits; a search that pulls a row waits for it) | The timeline's first bars waited on IndexedDB's write of each 500-row page (about 150 ms a page); measured 930 ms to the first bar before this and the days-first fetch, 120 to 215 ms after (budget 500) |

## 2026-11-18: Phase 10

Tracks E1 to E7 were found pushed to `CashGear`'s `main` (its `origin/main` holds `85dbb246` and
`89729d72`), so Track E8 may start. The ERP's own edit rules were read first (read only, nothing
run): the customer screen (`CustPageVM`, `CustomerCmdService.Update`) writes nearly every
`CustTable` field with the Customers unit's (3004) `EditRec` alone; an item's master fields
(`InvTable`, unit 4001) are written by `ItemCmdService`; stock (`InvSum`) moves only by posting,
unposting and the rebuild; neither `CustTable` nor `InvTable` nor `InvSum` has a rowversion.

### Answered by you

| Question | Answer |
| --- | --- |
| Track E8: which fields, which privilege, who builds | Split as Vendors. Customers (`customers.1`, unit 3004): name, group, mobile, second mobile, payment method, address and tax file with Edit; currency, price list, credit limit and blocked with AdvEdit; account, national ID, governorate, city and the created and modified stamps never. Items on hand (`itemsOnHand.1`): the item's name and group with the Items unit's (4001) Edit, a change applying to every row of that item (two rows of one item changed differently are refused); unit, site, warehouse, location, on-hand quantity and value never. A version is a hash of the values read under lock, so any change since the read is a conflict, as for Vendors. E8 (the connectors' `Commit` and `CommitStatus`, the audit naming the page) and E9 (the suite's new cases against UnifiedAPI) in a session of its own in `CashGear`, LocalDB only, committed there; pushing is yours. Workspace builds against its mock meanwhile |
| The embeddings provider and what is embedded | Voyage AI's API (`POST https://api.voyageai.com/v1/embeddings`) with the workspace's own Voyage key, a second key beside Anthropic's, under Data Protection and never returned, set by owners and admins in Settings' AI section; `voyage-4` (32K context, multilingual), 1,024 dimensions, documents and the question embedded as their own input types. Off for every workspace until turned on; off sends nothing to Voyage and deletes the workspace's vectors. Embedded: each page's and row's title and the worker's derived text, in chunks of about 2,000 characters; never comments, workbooks, database property values or ERP data. Metered in `AiUsage`, audited without content. Tests use a mock provider beside `tests/mocks/ai`; one live check with your key in `VOYAGE_API_KEY` |
| Where vectors are kept and searched | `PageEmbeddings` rows in SQL Server (the host's SQL Server 2019 has no vector type), each vector as bytes (1,024 int8, 1 KB a chunk); searched exactly in the API process from an in-memory copy per workspace, loaded on its first search and kept current by a sequence, capped in memory with the least recently used workspace dropped first; hits mapped to pages, then the same permission check as ordinary search at query time. No vector ever leaves the server |
| The live checks (asked on 2026-11-18, after the build) | Track E8 and E9 started then, in a session of their own; v0.10.0 is tagged after E9's suite passes against UnifiedAPI on LocalDB. No Voyage AI key: the live check against Voyage (`A_real_embedding` and `tests/e2e/meaning-live.spec.ts`, both skipped without `VOYAGE_API_KEY`) is yours, as Phase 7's Anthropic check was; 0.10.0's search by meaning is proven against the mock provider, and its similarity floor (0.3) is tuned on the mock |
| Third-party plugins | Owners and admins add, update, turn on or off and remove a plugin, audited. A plugin is a bundle they upload: a zip of a manifest (a type such as `vendor.name`, a version, names in English and Arabic, what it reads) and `index.html` with its scripts and styles, at most 5 MB; never loaded from its author's server. Served from an origin of its own, `plugins.cashgearerp.com`, by the Sites process under a second host name (one more DNS record and certificate: yours), `http://localhost:5291` in development, and only by a short-lived ticket the API makes for a member. Each frame `sandbox="allow-scripts"` (no same origin, pop-ups, top navigation or forms), a CSP with no network, `plugin-frame.1` over a `MessageChannel`. It reads its block's props, the theme, direction and language, and a database view's rows only when its manifest asks and the block names a view, as the reader may read them, never a person's name; it writes its own props only, when the reader can edit the page. No network at all |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| A field shared by a key | `ConnectorSchema.fields[].scope`: `record` (the default when absent) or `key`. A `key` field's value belongs to every record of the same `key` (Items on hand: the item's name and group). The client applies an edit of one to every record of that key the block holds; a commit's records of one key must carry the same `to` for each `key` field they change (else 400 `request.invalid`), the ERP writes it once a key, and the answer holds every record of each changed key the user may see | Your answer: one change applies to every row of an item. An optional attribute an older client ignores, so `erp-connect.1` stays the contract |
| Versions without a rowversion | The read's own version (a hash of the values the user sees, `ConnectorRules.ContentVersion`), computed again inside the commit's transaction with the rows read under an update lock | Strict versions, as Vendors': any change since the read to a value the user sees is a conflict |
| `maxCommitRecords` | 500 for Customers and for Items on hand, as Vendors | One budget (Phase 7's review of 500 records) |
| The mock ERP's Customers and Items on hand | Their fields as the real `customers.1` and `itemsOnHand.1` (Track E4's connectors), with Phase 5's specs moved to them; gina gains Customers' Edit, faris Customers' AdvEdit and Items' Edit | The suite runs the same cases against the mock and UnifiedAPI |
| Embeddings and completions | Two switches in one settings section: embeddings may be on while AI completions are off (search by meaning needs no Anthropic key); `ask` uses meaning only when both are on | Search by meaning is search, not a model's answer |
| The models offered | `voyage-4` (default), `voyage-4-large`, `voyage-4-lite`; a model change embeds every page again | One embedding space per workspace; Voyage's 4 series |
| The vectors' type | Asked of Voyage as `int8` at 1,024 dimensions, scored by their integer dot product | 1 KB a chunk in SQL and memory; Voyage's own quantisation |
| Search by meaning in the palette | Word results as before, then the pages only meaning found under "Related by meaning", asked once the person pauses, online, with embeddings on; a floor on similarity so a question with no near page shows none | A nearest page always exists; showing an unrelated one as a result would mislead |
| Plugins on a share link, a site, offline or in another workspace | A placeholder naming the plugin (no frame): a frame's ticket needs a member, and the bundle a connection | The frame ticket is the only way to the bundle |
| A plugin's database | Chosen by the person with the linked-view picker and kept in the block's props under a key the frame cannot write (`$view`); rows as the share link's (the view's shown properties, no people), at most 500 | A plugin must not name a database of its own choosing |
| A plugin with rows | Its props are at most 16 KB a write, and installing it is trusting it with what it is shown: it could copy shown values into its props, which every reader of the page receives (said in the add dialog) | No network stops it sending them anywhere else; props are page content any editor could type |
| Frame tickets | 32 random bytes kept only as their SHA-256 (`PluginFrameTickets`), as the hub's tickets; the Sites process loads no Data Protection, and `install.ps1` denies its identity the key ring's table | The first build used Data Protection tickets, which put the key ring in the public process: it could have opened the AI keys' ciphers in the SQL it reads |

Built in M10.1 to M10.5 (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| A shared field's edit | Made on every record of its key the block holds on screen and in its draft; one read later while editing takes it (`adopt`); reverting and a conflict's choice act on the whole key; the review lists the records the ERP adds ("not shown here"), and "Commit changes: n" counts the person's own | One value a key in every commit, and the person sees everything the commit writes |
| A conflict without fields | A note that the record changed in a field the person did not change, and no choice needed | The contract allows empty `fields` (a stock movement) |
| The mock's ownership rule | gina, like bob, sees only the customers she created and not their national ID; faris sees every customer | The suite's ownership case needs a user with Customers' Edit under the rule |
| The question by meaning in the palette | After a 500 ms pause, 3 to 1,000 characters, 10 hits, shown after the word results; a failure shows nothing more | "After the person pauses"; a letter or two means nothing |
| Search by meaning in Settings | Its own part of the AI section: switch, Voyage AI key, model (voyage-4 recommended, -large most accurate, -lite fastest), use, progress; turning off is not asked again (the note says it deletes what was made) | One section, as decided |
| When a page is embedded | Unchanged for `Ai__EmbeddingsSettleSeconds` (30; the e2e stack 1); passes every 2 s over pages changed, every page every 5 minutes | A big workspace's pass reads a few rows; a restored page (its `UpdatedAt` unmoved) comes back within 5 minutes |
| The similarity floor | 0.3 for every model (`Ai__EmbeddingsFloor`, per model `Ai__EmbeddingsFloors__<model>`) | On the mock an unrelated page scores 0.00 and a related one 0.5 to 0.8; checked against voyage-4 by `A_real_embedding` |
| The API's copy of the vectors | One array a workspace, trusted 20 hours without a full load (changes are kept 24), scored in parallel from 16,384 chunks | Within the changes' retention |
| `ask` by meaning | Meaning's top 8 fused with the words' top 8 (reciprocal rank, k = 60); a failure of the meaning search leaves the words alone | `ask` must not fail because search by meaning did |
| Usage | Completions' totals no longer count `embed` and `search`; the embeddings' are `{month, requests, tokens}` | Two providers, two keys, two bills |
| Plugins in the change feed | None: the list is read on start, after Settings' changes, and when a frame's ticket answers 404 | A feed type needs the sync engine; 0.9.0 ignores unknown types anyway |
| A bundle's files | Under `workspaces/{workspaceId}/plugins/{pluginId}/{bundleHash}/`; an update keeps the plugin's id and deletes the old bundle's files once the new row is in; two adds of one type at once, the second 409 | The workspace's purge takes them; a ticket names its bundle, so it opens nothing once the row changes |
| A third-party plugin on a published site | "The plugin {type} is shown in Cash Gear Workspace only" (and in Arabic) | A site draws no frame |
| A plugin's props write | The plugin's whole props merged over the block's (its `$` keys and keys not sent kept), one undoable edit, at most one each 250 ms, answered `saved` or `refused` | Props are page content; the merge keeps a newer build's props (Phase 7's rule); the throttle keeps a chatty plugin within the keystroke budget |
| A type with no third-party host | `plugins.has(type)` is true for a third-party type only with a host and a plugins origin; else the editor's own "needs a newer version" placeholder | A share link, a local workspace or an older build has no host |
| AI refusals in the client | The code is read from the answer's error (openapi-fetch reads a failed body itself); every AI refusal had come back as `server.error` since 0.7.0 | Found by stream E; `ai.disabled`, `ai.keyMissing` and the rest now reach their own text |

## 2026-11-18: After 0.10.0 (the Later list reviewed)

Phase 10 was the last planned phase. The plan's "Later" list, with what Phases 8 to 10 left for
later (added to it the same day), was put to you in one batch, grouped by theme.

### Answered by you

| Question | Answer |
| --- | --- |
| What comes after Phase 10 | Plan Phase 11, in a new session, from the themes below; it asks its own questions in one batch, as every phase has |
| Themes for Phase 11 | Sign-in and permissions (groups in permissions, single sign-on, passkeys); ERP at scale (ERP reports, Q16, and the ERP's Query paging without reading a company's whole table); AI and plugins (a plugin's own network access, plugins in the change feed, embedding database property values, an approximate vector index, `voyage-4-nano` or another local model, AI's subscription mode); databases (a chart view type, moving a timeline bar between lanes, a screen-reader pass on the grid, pins of every row's document) |
| Not chosen | Publishing (custom domains, the Sites process's rate limit, publishing in the change feed, an index of row files), offline and platforms (comments offline, Linux, a mobile app), import (Notion's people and outside relations, attachments' bytes before first opened), scale and upgrades (a backplane, Yjs 14, SQLite on OPFS): they stay on "Later" |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| How many phases | Left to Phase 11's planning: four themes may be one phase or split into releases, as Phases 8 to 10 were | The planning session sizes them against the code, and asks |
| ERP reports and Query paging | Planned with Track E work in `CashGear` (E10 onward) as an agreed track | The hard limits change other repos only as agreed tracks |
| Moving a bar between lanes | Its component work in Track U (`CgTimeline`) | The hard limits put generic components in `CashGear.React.UI` |

## 2026-11-19: Phase 11

The four themes chosen after 0.10.0 were sized against the code and this repository's ERP partner
(read only, nothing run): groups touch every place access is decided (six copies of the rule in
`Access.cs`, the push's own SQL in `DocService`, workbooks' copy in `WorkbookAccess`); the
framework (ASP.NET Core Identity 10.0.15) has passkeys built in, unused; nothing signs in from
outside today (`UserLogins` is mapped and empty); 0.10.0's ERP connectors read every row the user
may see and search, sort and page in C#; the ERP has AP aging, stock balance on a date and a trial
balance as services; Track E8's four commits are on the ERP's `origin/main`. The plan's Phases 11
to 13 follow from it (`IMPLEMENTATION_PLAN.md`).

### Answered by you

| Question | Answer |
| --- | --- |
| How the themes split | Three releases, all planned now and built one at a time: Phase 11 (`v0.11.0`) groups, passkeys and single sign-on; Phase 12 (`v0.12.0`) the chart view, lanes on the timeline, the grid with a screen reader, row documents in pins, ERP reports and the ERP's queries paged in SQL; Phase 13 (`v0.13.0`) a plugin's network, plugins in the change feed, property values by meaning, an approximate index, a local embedding model, AI by subscription |
| Groups | Owners and admins make and manage groups; a group holds members, admins and owners, never guests; a group is given access to pages and workbooks as a person is; at the page that decides, the person's own row first, then the highest of their groups' rows, then the workspace's (today's rule, extended) |
| Single sign-on | OpenID Connect, set up per workspace by its owners for email domains the workspace proves by a DNS `TXT` record; the first sign-in makes the account with no password; the workspace may require it for those domains, owners keeping their password; no SAML. Proven against a mock provider, and against a real one when you have a test app |
| Passkeys | Beside the password: added in Settings, the ceremony on the API's own sign-in pages, then sign in with either; a passkey answers where the password is asked again (deleting the account); every account keeps its password |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The deciding page with groups | The nearest page, walking up, that is restricted or has a row for the caller: their own, one of a group they are in, or the workspace's (not for a guest). There: their own row; else the highest of their groups' rows; else the workspace's; else, restricted, none | Your answer; a group row is a row for each of its people, as a person's is for them |
| Who is in a group | Members, admins and owners; a member made a guest, or removed, leaves every group, with an `access` change | Your answer: never guests |
| A group's name and limits | 1 to 100 characters, unique in the workspace by search's normalisation; at most 200 groups a workspace; a group may be empty | Bounded; two groups read alike would be shared by mistake |
| What members see | Every group's name and people (as they see members); guests see no group, and a group's row on a page a guest can open is not named to them | Members choose groups in the share dialog; a guest sees only people named on pages they can see |
| A group's change | Its people changed or the group deleted: one `access` change for each person who gained or lost a membership (targeted at them, as a member's role change is), so the four feed readers stay as they are; deleting a group deletes its rows on pages and workbooks | Their tabs fetch their tree again and the hub re-checks them; a row naming no group means nothing |
| Older builds and group rows | A permissions `GET` sends group rows only with `?principals=group`; a `PUT` that does not say `principals: ["group"]` keeps every stored group row | 0.10.0's share dialog knows only people and the workspace, and its save would delete what it was never shown (Phase 9's rule for views) |
| The relying party for passkeys | The API's own host (`workspace-api.cashgearerp.com`), every ceremony on the API's own pages; user verification required, no attestation, discoverable credentials | A wider id (`cashgearerp.com`) would let the ERP, the sites and the plugins origin ask for assertions; the app's own origin is not the API's |
| Adding a passkey | On the API's page, opened from Settings, within 10 minutes of a sign-in (else that page asks for one first); at most 20 an account, named by the person | An open session alone must not be enough to add a way in |
| Passkeys in development | WebAuthn takes no IP address as its relying party: the passkey specs run against a build of the app and the API on `localhost` | The app and the API are on `127.0.0.1` in development for their cookies (Phase 2) |
| Proving a domain | A `TXT` record `cgw-verify=<token>` at `_cashgear-workspace.<domain>`, the token 128 random bits shown to owners; read through `DnsClient` (Apache-2.0); a domain verified by one workspace cannot be by another until it removes it | .NET has no `TXT` lookup; the server tests run on Linux in CI, so no Windows API |
| Reading the provider | Its discovery document and keys through `Microsoft.IdentityModel.Protocols.OpenIdConnect`, which the server already carries; the code flow written in the sign-on module (no handler per workspace at start) | Providers are added at run time; no new package for the protocol |
| The email from the provider | The id token's `email`, any case, in a verified domain of the provider's workspace; `email_verified: false` refused; the account linked by (provider, `sub`) in `UserLogins` from then on | The domain's owner controls its people's identities; a changed email at the provider keeps the same account |
| A first sign-in | Makes the account (display name from `name`, else the email's local part; locale from the browser as a sign-up's) with no password, and a membership as a member when the workspace allows it (on by default) | Your answer |
| Sign-on required | Per domain; refuses that domain's password and passkey sign-ins, password resets and new password sign-ups, except for the workspace's owners; a session through the provider lasts `SsoSessionHours` (24) from that sign-in, then the provider is asked again; a desktop's refresh token ends with it | Your answer; no SCIM, so the session's length is what bounds someone removed at the provider |
| Who sets up sign-on | Owners only; admins and members do not see the section | The settings decide who can sign in as whom |
| Version | `v0.11.0`, `v0.12.0`, `v0.13.0` | One version per phase |

Built in M11.1 to M11.3 (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| One rule in code | Every copy in `Access.cs` decides through `Access.Speaks`; the push's SQL fast path falls back to the full check when a group of the caller's has a row on the chain; the caller's groups read in the same query as their rows, a batch's people's groups in one | One place the order lives; no extra round trip on the push (`AccessOracleTests` holds it) |
| Keeping access on a move | A group's nearest row copied as a group row, and an own row for anyone the copies would give something else (someone in two groups whose nearer row is the lower) | A page never falls back to looser access; the oracle failed without the second half |
| A group's change in the feed | One `access` change per person added, removed or in a deleted group, `revoke` when the group holds any row, else `grant`; a rename writes none; deleting a group raises no page's version | Their tabs fetch their tree again; nothing else changed for anyone |
| `If-Match` on a group | Optional, as on a page's list; a stale one 409 `version.conflict` | A client with no version to send is not refused |
| Leaving every group | Removed, made a guest, or the account deleted: memberships go in the same transaction, the groups' versions rise, the audit names them | A guest is never in a group |
| The picker | The library's `CgComboBox`: the workspace, then groups (an icon and "Group · People: N"), then people, searched by name or address; a group deleted meanwhile is taken out of the list and the dialog says "Save again" | One picker that scales to a large workspace |
| Words of new screens | A section of the catalogue loaded with its screen (`i18n/sections.ts`: groups, passkeys, single sign-on), and the library's buttons, icons and overlay code in one chunk (`ui-core`) | The picker had taken the initial JavaScript to 349.0 kB of 350; 0.11.0's is 347.6 kB |
| Identity's schema 3 | `CgwDb` maps `UserPasskeys` itself; `IdentityOptions.Stores.SchemaVersion` stays at its default | Identity reads the host's options, so the worker, Sites and `dotnet ef` would map no passkeys, and schema 3 would narrow Phase 2's keys in the API alone |
| A ceremony's challenge | Written to `PasskeyChallenges` once verified (six minutes) and refused after; single sign-on's `state` the same way (`OneUse`) | Identity keeps the state in a cookie a copied request carries again; synced passkeys' counters are always 0 |
| Which pages run script | Only those with a ceremony (sign-in, adding, confirming, deleting with a passkey), with `connect-src 'self'`, trusted types required and the script's integrity | The least script on pages that take a password |
| Re-authentication | On the API's page itself, by the password or a passkey; an account with neither (single sign-on), a sign-in of the last 10 minutes; `auth_time` and `amr` in the session; a session from before 0.11.0 counts as long ago | No proof token to keep and expire |
| Sign-in audit | Every sign-in `account.signin` with `{platform, method}` (`password`, `passkey`, `sso`), replacing `signin`; failures keep their names with `method` | One action, the method telling them apart |
| Lockout | A wrong passkey answer counts toward its account's lockout; single sign-on is never refused for one | Anyone could otherwise lock a required domain's account out of its only way in |
| Removing a passkey | Stops its ceremonies at once; the sessions it made stay until signed out in Settings → Devices | A passkey is a way in, a device a session |
| Adding a passkey on the desktop | In the system browser (`openExternal`, no return address); the list read again when the window has the focus back | The server returns only to http(s) app addresses |
| Reading a provider | Its discovery and keys through IdentityModel 8.23's `ConfigurationManager` with a retriever of our own; in Production https and public addresses only, no redirects, 10 s, 1 MB; keys refreshed hourly and at once for an unknown key; `iss` in the answer checked (RFC 9207), `azp` when present | `Protocols.OpenIdConnect` is only in the graph at 7.7.1 beside OpenIddict's 8.23; owners type the issuer, so no SSRF into the host's network |
| A session through the provider | Its end on the device (`Devices.SsoWorkspaceId`, `EndsAt`), checked by the device gate, the hub's re-check and `/connect/token`; a desktop inherits the confirming browser's end | Required sign-on must find every session not made through the provider |
| The address and the account | The id token's `email`, its domain exactly a verified domain; another `sub` with a linked address is linked too; an account never confirmed is linked with its password removed | The domain's owner controls its identities; an unproven sign-up must not keep a way in |
| A changed provider | A new issuer, client id or secret clears `TestedAt`; a domain's required stays on | Untested again; turning required off by itself would surprise owners, who keep their password |
| Limits | 50 domains a workspace; issuer 500 ASCII characters with no query or fragment; client id 1 to 256 and secret 1 to 500 visible ASCII characters; session hours 1 to 720; DNS read fresh on each Verify, 5 s, 2 tries | Bounded |
| Single sign-on in Settings | Owners of a synced workspace only (nobody else gets the section or a request); the secret write-only with "A secret is set", Remove and Keep; requiring sign-on always asks first; values as written in `lang="en"` | The routes are owners' only; the warning must never be skipped |
| The tests' provider | `tests/mocks/oidc` on 4287, keys made at start in memory, each fault kept until reset, a realm per test | No test reaches a real provider; parallel tests never share a queued person or a fault |
| Measuring CPU per push | `bench/phase8-server.mjs` against 0.10.0 built from its tag, a member typing in 20 groups on a page shared with 20 other groups (the fast path weighs each row and still decides) | An owner's push never reads the page's rows; the budget is the fast path with groups |

## 2026-11-19: Phase 12

Sized the same day as Phase 11's planning (`IMPLEMENTATION_PLAN.md`, Phase 12): the chart block's
drawing and settings exist in `@cgw/plugins` and the site draws charts as SVG; an older build reads
an unknown view type as a table and could send it back as one; 0.10.0's ERP connectors read every
row the user may see and search, sort and page in C#, and advertise `maxRecords` without enforcing
it; the ERP has AP aging, stock balance on a date and a trial balance as services, and no AR aging.
Read before asking (nothing run): `CashGear.React.UI`'s branch holds 13 pushed commits after
Workspace's pin `0490cbd` (its Blazor-parity work, R0 to R9); the ERP's `main` is at its
`origin/main` (`5efc473d`), with a clean tree.

### Answered by you

| Question | Answer |
| --- | --- |
| The reports | AP aging by vendor, stock balance on a date and a trial balance: the three the ERP already has as services, as read-only report connectors in `erp-connect.1` (Track E11). No AR aging in 0.12.0 |
| Tracks U19, E10 and E11: who builds them | Sessions of their own: one in `CashGear.React.UI` for U19 (on its branch's tip, so the pin's bump brings R0 to R9 too and Workspace adapts to them in the same bump), one in `CashGear` for E10 and E11, LocalDB only, committed there; pushing the ERP is yours. Workspace builds against its mocks meanwhile |
| The ERP's order and search once paged in SQL | Exactly 0.10.0's answers: the same records in the same order, Arabic searched as now, held by the suite against both on the same records |
| A chart view over a large database | Counts from the query's group counts at any size; sums and averages over at most 5,000 rows on the device, marked partial past that, as the chart block |
| Pins of row documents | Every row's document of a pinned database that has one, up to 5,000 a database, through a batch pull so a pin stays inside the person's rate limit; Settings' progress counts them |
| Screen readers | NVDA and Narrator on Windows and VoiceOver on a Mac, each by hand once from a written script of keys and what each must say (yours where the speech cannot be read here; there is no Mac here), and the grid's accessibility tree checked in CI on every run |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| What a build's `viewTypes` says | The number of view types it knows; absent, or anything but a positive whole number, is 5 (every build before 0.9.0); 1 to 4 read as 5; more than the server knows is every type | No build ever knew fewer than five: reading 3 as three would turn a calendar sent back as a table into a table |
| An upsert from a build of N types | `table` for a stored type at index N or later keeps the stored type; stored config keys a build of N does not know and did not send are kept, by one table (`DatabaseOps.ConfigKeysByTypes`: 5 the 0.8.0 keys, 6 `timeline`, 7 `chart`); a change to another type it knows is taken; from a build that knows every type, the view as sent | A 0.9.0 to 0.11.0 build (6) keeps a chart it sends back as a table, a 0.8.0 build a timeline and a chart; the next view type adds one row |
| What a chart view shows | Exactly its title, its group's property (live, and one rows can be grouped by) and its measure's (a sum or average of a live number, formula or rollup), whatever its `config.properties` says (`ChartView.Shown`, `Sharing/ChartViews.cs`); then only those whose values may leave. For a share link's rows, a site, and the files either may read | A property added after the view was made is in no `hidden` list; a chart draws nothing else, so nothing else leaves through it |
| A chart view's `properties` in the app | Written by the client on every write of the view (`updateView`, so the toolbar's Group too): the title, the group's and the measure's shown, in that order, every other hidden, widths kept | The view type has no Properties menu; an older build's table then shows what the chart draws |
| A chart view a share link may not read | 403 `chart.hidden` when its group's or measure's values never leave a link (a person, created-by or edited-by, a formula reading one, a rollup out of the scope), whatever else the request asks; the chart says it in its body ("…grouped or measured by people, or by values a link doesn’t share."), an alert with no retry, in the view and the block; a site draws its placeholder ("This chart is not published") | The client must tell it from a missing view (404); trying again cannot help |
| A chart view with no group, or a group gone or not groupable | A share link answers its rows ungrouped, titles only (`groups: null`); a site draws the placeholder; the app says to choose a group (an editor's and a reader's words differ) | Nothing hidden is read; the site has no words for choosing |
| A measure on a property gone, or not a number, formula or rollup | A count, on a share link and a site as in the app; nothing of the property is read | The chart block's rule (Phase 7) |
| A chart view on a site | The chart block's drawing, now one routine for both (SVG, its numbers as a table); untitled, "Count by {group}", "Sum of {measure} by {group}", "Average of {measure} by {group}" («العدد حسب {0}», «مجموع {0} حسب {1}», «متوسط {0} حسب {1}»); sums and averages over at most 5,000 rows in all, read group by group in the query's order, "Based on the first 5,000 rows" past that (the chart block too, which read 5,000 a group with no note); a database page whose first view is a chart, the chart alone; nothing to draw, "No rows" and no table | As the app reads them (`ROW_CAP` across groups); the chart block on a site keeps its Phase 9 title ("Count: Tasks"), so its fixtures stay |
| The batch pull | `POST /api/v1/workspaces/{workspaceId}/docs/pull`: 1 to 100 distinct pages of the workspace, each checked and answered as the single route would, in the request's order, one page's refusal never failing the batch; a page of another workspace 404 in its item; 400 `request.invalid` for 0, more than 100, a repeated page or no `pages` | A pin of 5,000 row documents in 50 requests |
| Its rate limit | A window of its own, `pull`, 120 batches a minute (`RateLimits__pull`), not the account's 1,200; the single route keeps `user`. Partitioned as every per-person policy is, which as built meant by address until 2026-11-21 (CLAUDE.md, Phase 12) | On the shared 1,200 a batch of 100 would allow 120,000 page reads a minute, 100 times the single route; 120 lets a 5,000-row pin through more than twice a minute and caps reads at ten times the single route's |
| Its size | At most 8 MiB of update bytes an answer: the page that would pass it and every page after it are `deferred` (status 0; an item's code, not an entry of `Codes`), unread, refusals too; a page is answered whole when nothing before it in the answer carried updates, so always when it is first | The client asks again with the deferred pages first, and every request makes progress |
| A row's level in one batch | Its database's, decided once a database a request (`PageGate.OpenInAsync`) | The rule (`Access`); a member's 100 rows took 296 to 315 ms in process, 540 to 677 before |
| Pins with row documents | A pinned database holds the document of each live row that has one (`docHeadSeq > 0`): its templates, then at most 5,000 rows (`PIN_ROW_DOCS`, the local row limit) in row order (order key, then id); fetched with the pinned pages, those first, by the batch pull: 100 pages a request, 2 requests a pass, the next pass 100 ms later while some remain | 5,000 in about 25 short passes and 50 requests; typing's pushes never wait long behind them. Templates are what rows are made from offline |
| A pinned database above 5,000 rows | Held in part, as before; its documents those of the first 5,000 rows, in row order, of the rows this device holds (those its views' queries returned) | It never reads the whole table to choose; offline, each row its views show opens |
| A 429 or 503 on the pins' batch | Only the pins wait, for `Retry-After` (60 s if none); the pass goes on and the status stays as it was. A 429 on any other route backs the loop off as before | A pin's background fetch must not hold back what is typed, nor show an error |
| A server without the batch route | A 400, 404 or 405 on the request itself turns the batch off for the session: pages one by one (24 pinned a pass, as in Phase 3), with a console warning | An older API answers an unknown route 404 `not.found`, the code of a workspace the account no longer has: through the pass's catch it would have removed the workspace from the device |
| A grouped table's row numbers (the accepted reading of "group lines not counted") | The row count and indices count the header, each group's header and every row of an expanded group, loaded or not (a collapsed group's rows not); a row's place in its group of the group's count is its `aria-posinset` and `aria-setsize`; the true total is the grid's description (its foot, "Rows: 300"). Ungrouped, the count and indices are exactly the query's total | A tree grid's group must be a row, and Chromium numbers every row of a grid (an index not above the previous raised, the count raised to the highest): no ARIA keeps a group's header out |
| The table's "New" line | Not a row: `aria-hidden` (its button out of the tab order), reached by the keys with no active descendant, said by the live region ("New row: press Enter to add one."); Enter still adds a row there, and the toolbar's New is the same action in browse mode | As a row Chromium counted it: the count was the total and two, and in a grouped table each group's New line moved every later row by one |
| `Connectors?kinds=` | A comma-separated list; absent or empty, `entity`; names the ERP does not know left out; reports after the entities (AP aging, stock balance, trial balance). The client asks `entity,report`; `kinds: null` asks without, as an older build does | A later kind asked of an older ERP lists nothing more |
| `parameters` on an entity's query | Absent, `null` or `{}` passes, anything else 400 `request.invalid`, as 0.10.0's `ConnectorQuery` does (INTEGRATIONS.md reworded) | The contract had said "stays 400"; the ERP's 0.10.0 lets `{}` through |
| The large seed's `debitLimit` | `0.00` for every eleventh vendor, where the rule had none | The ERP's `DebitLimit` column is not nullable (Track E10) |

Built in M12.1, M12.3, M12.4 and M12.5/M12.6's Workspace side (the streams' choices, each in its note):

| Choice | Default | Reason |
| --- | --- | --- |
| The chart's words | `database.chart.*` (the chart block's 29, moved word for word from `plugins.chart.*`, and the view's), in `packages/database/src/i18n/chart-en.ts` and `chart-ar.ts`, merged into the app's instance with the first chart drawn (`useChartT`); only `viewType.chart` and the Projects template's view name at start | Initial JavaScript is at its budget; the move takes about 0.5 kB off it |
| `CgChart`'s own words | Passed in both languages (`database.chart.canvas.*`: its data table's toggle, "Category", the series' and points' names, the keyboard instructions, what it announces), by the view and the block; the English its defaults | They were English in Arabic, the block's too |
| `viewType.chart` in Arabic | «مخطط بياني» | The timeline is «مخطط زمني»; «مخطط» alone reads as either. The block keeps «مخطط» |
| How a chart view reads its rows | A count from `DatabaseView`'s own query (its group counts at any size); a sum or an average by a query of its own, 500 rows a page, group by group to 5,000. Not `ownRows` | The toolbar's Group editor lists the groups from `DatabaseView`'s query, whose notices stay every view's; 5,000 rows in 10 pages, not 50 |
| A new chart view | Grouped by the first status, else select, else groupable property (the board's rule); a count; bars; no title | A chart needs a group; the board's choice is one people know |
| The kinds a chart view offers | Bars, a line, a pie (no number: a view's chart is always grouped); a kind it does not know drawn as bars; a pie leaves out empty groups | The shared shape's `ChartKind` |
| A chart of no rows | "No rows to chart." even when its select or status has groups of none | Bars of zero say nothing; the block's words |
| Who says a chart view's query failed | The chart, in its body (`ownErrors` on the view type): `chart.hidden` in its words with no retry, anything else "Rows could not be loaded." with Try again for the query that failed; `DatabaseView` says nothing above the tabs | A share link's refusal was said twice |
| A reader's Layout | Drawn, every control disabled, nothing written | As the timeline's, calendar's and gallery's for a reader |
| The chart's settings | One `ChartControls` (kind, measure, its property, title) for the view and the block: the block passes its own classes and its "Group by" between kind and measure, its DOM unchanged; the view's group is the toolbar's | One set of controls |
| The Projects template | A fourth view, "Progress by status" (the average Progress by Status, as bars) | Every view type is used by a template (its test); a chart people find |
| A workspace import | Keeps every view type the build knows (`KNOWN_VIEW_TYPES`) | It kept a list of six of its own, so an exported chart view came back as a table |
| "Load more" in the grid | A row at the index of the first row not loaded (in a group, level 2, the place loaded + 1 of the count), its cell an id of its own | It stands for the rows to come and adds none; the active descendant changes, so the reader reads the row that lands there |
| A group's header | The row itself is the active descendant (not its cell); Right expands, Left collapses (mirrored in Arabic), Enter and Space still toggle | Its expanded state, level and place are the row's; the tree grid pattern |
| The grid's description | `aria-describedby` its foot ("Rows: 300", "Rows: 100 of 5200") | The true total on entering, grouped or not |
| Column headers | `aria-label` the property's name ("Untitled" without one), `aria-description` its type; `property.header` removed | The resize handle's label would otherwise join a name from contents |
| The row's header | The title cell, `rowheader`, named by `aria-labelledby` its text; every other cell `gridcell` | The handle's "Select the row" and "Open" stay reachable in browse mode, out of the name |
| Editing announced | By the table's `CgLiveAnnouncer` when it starts, is saved (the editor wrote a value: its env's `setValue` watched) and is cancelled, naming the property and the row's title; a saved title by its new text ("Saved: Name, …"); a checkbox toggled is saved; a picker closed by Escape after a choice is saved | Exactly what happened to the value, with no change to the cells |
| The grid's words | `database.grid.*`, merged with the first table drawn (`table/words.ts`) | Nothing new at start |
| Virtualised rows | In ascending DOM order (the active or edited row kept outside the window sorted in) | Chromium raises an index not above the previous row's |
| The grid in e2e | Counts, indices, places and sizes from Chromium's own tree (`chrome://accessibility`, `edge://accessibility`, the browser launched with `--force-renderer-accessibility`); roles, names and levels from CDP; browsers only | CDP's Accessibility domain has none of the numbers; Chromium's are after its own corrections; WebView2 has no such page |
| `cell.open` in Arabic | «افتح» (was «فتح») | Axe's `label-content-name-mismatch` on the active row's Open button |
| Held pages whose head moved | One alone by its own route; more by the batch pull, at most 10 requests a pass, the rest the next pass | A pinned 5,000-row database whose documents move together would otherwise be 5,000 requests in one pass |
| A page the batch refused (403, 404, 410) | Not asked again until its record comes anew (the feed, a tree, a rows page); any other status asked again a later pass | Else a page the server will never give is asked every pass |
| A page whose cursor moved between asking and the answer, or of another epoch | Pulled by its own route | A hub frame or an opening can move it; the single route knows epochs and paging |
| Once every document of a pinned database is held | Not read whole again until its hold or record changes, a row is removed, or a changed row (from the feed, a fetch or a query) lacks its document; a database held in part is read whole on any change | Edits of values elsewhere would otherwise read 5,000 rows every pass |
| Counting them | `OfflineProgress.rows`, `rowsHeld` and `rowsToFetch` beside the pages' counts (`pinned`, `held`, `toFetch` stay pages only); a second line in Settings → Offline only when a pinned database holds row documents, the numbers formatted for the language, its words a section loaded with Settings (`offlineRows`) | The page lines and the e2e texts that hold them stay; "row pages" is the app's word ("Open as a page") |
| Unpinning | Nothing evicted: held row documents stay and are kept fresh, no longer counted, none fetched for new rows | Phase 3's rule for pages: unpinning keeps what is held |
| A report parameter sent `null` | As absent: its default; `""` for a lookup is `null` | One rule for every type; no report needs a non-null lookup default |
| A choice value not among its options | `type` | It is not of the choice's type |
| `dateTo` before `dateFrom` | One `range` error on `parameters.dateTo`, not checked when either date is already wrong | The contract's table |
| `totals` and `labels` | `totals` each `total: 'sum'` field among the answer's fields (the request's `fields`, else every field the user may see), always on a report's answer; AP aging's `labels` all five bands whatever `fields` asks | Fewer fields asked, fewer totals; the client uses what it shows |
| A report's cursor | Bound to its parameters as resolved (a `today` default included), so another day's is refused | Another day is another query |
| A report's own order and its ties | AP aging `balance` descending, then `vendorName` ignoring case, then ordinal, then the account; stock balance item, site, warehouse, location; trial balance `balance` descending, then the account | The contract's orders and a final key, so the keyset is total |
| The keyset | The last record's sort values and its own-order key: Vendors' record id, Customers' account, Items on hand's tuple, a report's own-order fields | E10's "sort values and id": the own-order key is the id or orders exactly as it |
| `maxRecords` reached mid-page | The page cut at it (10,000) and `nextCursor: null` | "At most `maxRecords` records through its cursors" |
| The mock's 0.10.0 readings | A search over 200 characters after trimming is 400; `equals` on a decimal takes a number, a decimal string or `""`, on a date or date-time any string, matched exactly | 0.10.0's `Parse` and `TypeProblem` |
| A report's `idField` | `null`: rows keyed by their `keyField` | A report has no surrogate id |
| The mock's reports | As the suite's README ("Reports") reads them: scales (quantity 3; amounts and share 2; unit cost 4), `unitCost` cost over quantity half away from zero (`null` at 0), `share` a percentage at 2 places (`null` at a total of 0), AP aging's ledger and bands, a place a row once it has a movement up to `asOf`, inactive items never, the company's time zone Africa/Cairo at the mock's clock; users: alice and erin `accountmgr` with cost, bob `warehouse` without, gina `payable`, faris `warehousemgr` with cost, carol and dan none | Only mock-only cases check exact values; every case has a user who may and one who may not |
| The large seed | Kit's records of the three entities replaced by 100,000 each, Dot's kept; the reports' ledgers always from the usual seed. Against a real ERP `ERP_TEST_KEY_SCALE` (every field, no record rule) and `ERP_TEST_KEY_SCALE_ADMIN` (links that company); without both `scale.test.ts` skips | Tenant isolation stays testable; the large seed needs a company of its own |
| A report's words | `packages/erp/src/i18n/reports.ts`, merged under `erp` when `ErpView` first draws | `@cgw/erp/i18n` is in the start catalogues |
| A reader who may not edit the page | Sees the parameters read-only; the report runs with the stored ones | The "As of" date is context they need; the filter is never theirs to change |
| What a block stores of its parameters | Only what differs from the report's defaults: an absent date shows its default as a placeholder ("Today", "Start of this month", the date), so `today` keeps tracking the day; "All" on a lookup with no default removes the key; nothing left stores `null`; choosing other data writes `parameters: null` | The block holds only what the person chose |
| Stored values the view cannot use | A value of a type it does not take, or a name the schema no longer lists, left out of the request (its default applies) and kept in the attribute | As fields a reader cannot see are kept |
| "The first N of M" | Shown whenever `total` is above the schema's `maxRecords`, for entities too | E10 |
| A report's table | A totals row (`<th scope="row">` "Total", then each shown column's total, empty where none) and a "Report" tag beside the title | Native table semantics; it says what kind of block it is |

Built in M12.2 with Track U19 (`CashGear.React.UI` `d493b4c`, pinned 2026-11-20):

| Choice | Default | Reason |
| --- | --- | --- |
| `CgTimeline`'s lane move (U19, as built) | `moveBetweenLanes` (off by default; needs `lanes`, `onItemMove` and `labels.movedLane`): a bar's body dragged onto another lane's lines or its header line, collapsed or not, while it moves by whole days, the lane marked, the lines scrolling at the top and bottom edges, Escape cancelling; Alt+ArrowUp and Alt+ArrowDown on a focused bar to the lane above or below, never mirrored, not with Shift, Ctrl or Cmd; `onItemMove`'s details gain `lane` (a key, or `null` for the last lane of unlisted items), absent when it did not change, in the one call with the dates; the focus follows the bar to its new line (the lane's header when collapsed) | One call, so the caller writes one change; up and down are not a direction of time |
| Which timelines move bars between lanes | Every timeline with lanes (a select or status) that can write its dates; a reader none | The lane is a value the row already has |
| A bar moved to another lane | One `row.update` holding the lane's property (`null` for "No {property}") and, when its days changed too, its dates in their own forms; a move of its lane alone writes no date | The plan's one edit; a date written unchanged would be an edit of nothing |
| Its words | "Moved {title} to {lane}: {start} to {end}." and "Moved {title} to {lane}, {start}." («نُقل {title} إلى {lane}: من {start} إلى {end}.», «نُقل {title} إلى {lane}، {start}.»); with lanes, the move hint names Alt and ArrowUp or ArrowDown («Alt مع السهم الأعلى أو الأسفل ينقله إلى المسار الذي فوقه أو تحته») | What happened, in the order the reader needs it |
| The library's R0 to R9 in the first screen | Their text labels, small hooks and field internals (`CgUiText`, `uiLabels`, `useCgId`, `useDirection`, `useAsyncOperation`, `useControllableState`, `useDebouncedCallback`, `useFormReset`, `InputShell`, `listBox`, `validation`, `useFieldControl`) in the `ui-core` chunk (`apps/web/vite.config.ts`) | Each was a chunk of a few hundred bytes in the first screen's graph: 350.5 kB of initial JavaScript, 348.6 kB grouped |

Built in Tracks E10 and E11 in the ERP (`CashGear` `da2fface` to `98deed36`, 2026-11-20; the readings
the contract left open, each in `INTEGRATIONS.md`'s as-built paragraphs):

| Choice | Default | Reason |
| --- | --- | --- |
| A host not on SQL Server 2017 or later, or whose probe fails | 0.10.0's path in C# (the ERP's SQLite tests too) | The fold and `TRIM` the SQL path relies on are checked, not assumed |
| Text stored with an unpaired surrogate (only a raw T-SQL script can) | Searched and matched by `equals` as stored; sorted exactly | 0.10.0 only ever saw U+FFFD for it, through SqlClient |
| Items on hand's own order | Its own plan (places numbered once, the page item by item, the count and the page on two connections at once); the general path where an item's or a place's keys are stored differently on its rows | The first page within 500 ms with no index; 0.10.0's answer there was the database's choice |
| Two places its order takes as one (a `NULL` and an empty location) | Broken by place number | 0.10.0 left that order to the database |
| `maxRecords` | By the cursor's position (the matches at or before it, counted with `total` in one scan), not a count carried in it | No cursor, forged or not, reads past the first 10,000 |
| A report's access | Each report page's roles alone, so the suite's report users are its own (`reports.test.ts` apart, its README) | The ERP's pages check no unit |
| A report's `today` | The host's local day | The ERP keeps no company time zone |
| `unitCost` | The page's: cost over quantity at 2 places, half away from zero, `0` at a quantity of 0 or a negative result | What the ERP's own page shows; the mock keeps 4 places and `null`, mock-only cases |

## 2026-11-21: Another account's workspaces on a shared device

Found in production: after a sign-out, the next account to sign in on the same browser saw the first
account's synced workspaces, which a sign-out had left on the device ("a sign-out forgets the
account, not the data", Phase 3), and every route of them answered 404 to it.

### Answered by you

| Question | Answer |
| --- | --- |
| What happens to an account's synced workspaces on the device at a sign-out, or when another account signs in | Hidden, plus a choice to remove them: the app shows the signed-in account's synced workspaces and the ones kept on this device only, signed out only the latter; Sign out in Settings → Account has "Also remove this account's workspaces from this device", which removes them once everything waiting is on the server. Hidden data is kept, so signing in again brings it back with unsent edits |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Whose workspaces are shown | A synced workspace to the account it was synced for (`accountId`) only; "On this device only" ones to anyone; the account is the sync engine's remembered one (`remembered`): kept through a 401, forgotten at a sign-out or when the server says no one is signed in | A session that ended elsewhere still shows its own pages with "Sign in to sync N changes", as Phase 3 designed |
| At the start | The account kept in the store's prefs (`sync:account`), read by the session before the first paint | A signed-in person never sees their workspaces vanish and come back while the account check runs |
| A page of a hidden workspace opened by its link | "This page does not exist on this device."; the workspace switcher, notices, the inbox and recovered pages never open one | One rule, `WorkspaceSession.shows` |
| Removing at a sign-out | What waits is sent first (one pass); if anything of the account still waits (operations, document updates, refused updates being repaired, pages set aside and not recovered), nothing is removed and the person stays signed in, told the count; otherwise the account signs out and its workspaces are removed as a lost workspace's are, what was set aside from them dismissed | No edit is ever lost to a removal; the server keeps everything |
| What a removal leaves | Set-aside entries of those workspaces, dismissed (never listed) but their bytes still in the store; the stores have no call to delete one yet | A follow-up if it matters: the three stores would each need it |
| The workspace list after a sign-in | Read at the account's first pass (`passes` reset in `setAccount`), not up to ten passes later | A removed workspace, or another account's, came back only after about 15 s on the desktop |
| Where the sign-out's words and controls load | With Settings (`cloud/SignOutSection.tsx`, its words a section, `signOutWords.ts`); the rule and the removal in the session and the engine, in the first screen: +0.66 kB of initial JavaScript (348.58 to 349.24 kB of 350) | Only Settings offers it; the rule must hold from the first paint |

## 2026-11-21: Rate limits per person

Found in Phase 12 (CLAUDE.md, Phase 12): every policy meant per person counted by address, as the
limiter ran before authentication (since Phase 2). People behind one office address shared each
window (the account's 1,200 a minute, `ai`, `meaning`, `frames`, `pull`), and one person on two
addresses had two.

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Where the limiter runs | Two passes of the one limiter (`Program.cs`): OpenIddict's routes (`/connect/*`) before authentication, every other route after it and before authorisation | OpenIddict answers a refused grant, authorisation or revocation inside the authentication middleware, so a limiter after it never sees those; a person is known only after it |
| Whose window | `user`, `push`, `search`, `preview`, `import`, `realtime`, `ai`, `meaning`, `frames`, `pull`: the person signed in, by cookie or bearer token alike, one window on every address; a caller not signed in, the address's. `anonymous`, `signin`, `token`, `ticket`, `sheet`: the address's, whoever asks | A person's web and desktop are one person; guessing and floods from one address stay bounded by the address |
| `/connect/authorize` and `/connect/logout` | `signin`'s 20 a minute an address, counted in the first pass, apart from the sign-in forms' 20 in the second (until now one window for both) | The two passes have their own counters; no password is typed on those two routes, and the forms keep their 20 |
| The work before a person's window | Authentication: a cookie's or token's check (a device's state cached 15 s, a token's entries read) before the window is counted | The window cannot be the person's before the person is known; a caller without credentials costs almost nothing there |

## 2026-11-21: Phase 13

Sized on 2026-11-19 (`IMPLEMENTATION_PLAN.md`, Phase 13) and again before asking, against 0.12.0
(nothing run): every build ignores a change type it does not know (`entityRecord` and `batchOf`
drop it), so a `plugin` change needs no rule for older builds; a row's values and its stored formula
and rollup results are JSON on `DatabaseRows`, and a recompute raises the row's `Version` but not its
`UpdatedAt`; the plugins origin sends one CSP for every plugin. `voyage-4-nano` (`MongoDB/voyage-4-nano`
on Hugging Face) is Apache-2.0, about 340 million parameters on Qwen3 with bidirectional attention,
mean-pooled, 2,048 dimensions by default with Matryoshka cuts to 1,024, 512 and 256, and in
voyage-4's embedding space; it is published as safetensors with its own model code, with no official
ONNX build (one community int8 conversion exists).

### Answered by you

| Question | Answer |
| --- | --- |
| A plugin's network | The https hosts its manifest names (`network: {hosts}`: at most 10 exact host names with an optional port; no wildcard, IP address or Cash Gear host), shown to and approved by the owner or admin who adds it; an update naming a new host keeps only the hosts already approved until one is approved in Settings → Plugins; a plugin that reads rows and has a network approved for both in one step, told that it can send what it is shown; each bundle served with its own CSP, `connect-src` exactly its approved hosts. `network` is an optional field of `plugin-frame.1`'s manifest, not a new contract: every reader since 0.10.0 leaves unknown fields out, so 0.12.0 serves such a plugin with no network |
| Property values | Text, number, select, status, date, checkbox, URL and email values, as "Name: value" lines after the row's title in its own chunks; never a person, created-by or edited-by, or a formula or rollup that reads one; other formulas and rollups included, embedded again when their results change. Multi-select, phone, a relation's titles and files left out |
| The approximate index | In the API process past 200,000 chunks a workspace, exact below; at least 0.95 of the exact search's first ten found. Each chunk's sign bits (128 bytes) scanned first, the best few thousand scored exactly from the int8 copy already held, fetching wider until enough pass the permission filter; nothing to train; kept current by `EmbeddingChanges` |
| The local model | After the spike, `voyage-4-nano` on ONNX Runtime (MIT) in the worker and the API, on the processor, at 1,024 dimensions as int8, a third choice in Settings beside Voyage's API; vectors of its own (choosing it embeds everything again). A model package of its own, exported once from Voyage's official weights by a script here, its hashes pinned in code, copied to the host once and kept across updates (`install.ps1 -LocalModel`); never in the repository or in every deploy package. AI's local mode on the desktop stays on "Later" |
| The subscription | Cash Gear's Anthropic and Voyage keys in the host's environment only (`Ai__Subscription__AnthropicKey`, `Ai__Subscription__VoyageKey`, set by `install.ps1` from the session as the SMTP password is); a workspace's owners or admins choose its own key or Cash Gear's, for completions and for search by meaning apart; an allowance a month per workspace in tokens (input and output alike; completions and embeddings apart), a default and per-workspace overrides set in the environment by whoever runs the server (no default: not offered); each call reserves its most before it is sent and settles after, a reservation a crash left lapsing after 15 minutes; the use shown against the allowance in Settings; past it, 429 `ai.limit` with `reason: "allowance"`, and the worker's embedding waits for the next month; no billing in 0.13.0 |
| The spike | On the reference machine first, then once on the production host over Remote Desktop at a quiet hour (nothing installed there, its folder deleted after). Downloads, each into a folder of its own under `target/`: the official weights `MongoDB/voyage-4-nano` from Hugging Face (about 704 MB); for the one export to ONNX, a throwaway Python environment (PyTorch for the processor, Transformers 4.56 or later, ONNX Runtime's quantisation tools); for the server, `Microsoft.ML.OnnxRuntime` and `Microsoft.ML.Tokenizers` from NuGet (both MIT). The model's own code is read before it runs |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| A plugin's hosts outside Production | Also `http://localhost:<port>` and `http://127.0.0.1:<port>`, so the e2e stack's test host can be named; Production takes https only | The tests need a host they run; a plugin in production never talks plain http |
| An allowance's month | The calendar month in UTC, as the usage totals since 0.7.0 | One month for what is shown and what is enforced |
| A value's line | At most 1,000 characters, cut on a word; a value as the CSV export writes it | A long text property must not crowd the row's own text out of its first chunk; the CSV's text is already the agreed reading of every type |
| The approximate index's numbers | 4,096 candidates scored exactly; eight times as many when the permission filter leaves fewer than asked, then every chunk; the copies' cap 1,280 MB (from 1,024), a copy sized to its rows before it loads | At 1,000,000 clustered chunks 4,096 found every one of the exact search's first ten (recall 1.0) at under 20 ms; a million chunks with their bits are about 1.1 GB |
| The local model's threads and memory | Half the processors, at most 8 (`Ai__LocalModel__Threads`); loaded on first use, unloaded after 30 minutes unused | At 8 threads a chunk takes what all 24 take on the reference machine, and the API keeps the rest; the model is about 1 GB in each process |
| A reservation's estimate | The input's characters halved, plus the output limit (a batch of chunks: their characters halved) | Tokens are never fewer than a character in two for English or Arabic text; an estimate too high only holds room for a moment |
| Settings while pages are embedded | Read again when Settings opens and every 5 s while pages wait | The month's use and the progress move without a reload, and nothing is asked when nothing waits |
| "Stop network" | Approves no host (`approvedHosts: []`), at once; the manifest's hosts then wait as an update's new ones do | One switch an owner can reach for, kept apart from turning the plugin off |
| CI's Windows job's limit, and a kill test that stops | The job's limit 180 minutes (from 150), each kill test step's 20; `kill-test.mjs` ends the app when a run makes no progress for 5 minutes (`--stuck-minutes`), so the run fails saying where it stopped, and ends the test if it is still stopped after that | The job took 128 minutes before Phase 13, whose specs and budgets add about 12; run 44934797669's desktop kill test printed nothing for 48 minutes until the limit, and the same build passed it here in 2 |

### The spike (M13.4): results, and what they decided

Run on 2026-11-21 on the reference machine (Xeon E5-2680 v3, 12 cores, 24 threads, AVX2, no AVX-512
or VNNI), the model's own code read first. `voyage-4-nano` at the revision
`587d8d6dcaec029a9779c2098d6af020e4a07c01` (692,919,112 bytes of safetensors), exported to ONNX by
`scripts/local-model/export.py` as the card runs it (cosine 1.000000 with the card's own run): input
ids and mask to the mean-pooled vector cut to its first 1,024 and normalised. .NET with ONNX Runtime
1.31.1, one text a run:

| Input | Tokens | All threads, median / p95 | 8 threads, median / p95 | 4 threads, median / p95 |
| --- | --- | --- | --- | --- |
| 2,000 characters, English | 402 | 458 / 462 ms | 402 / 586 ms | 851 / 945 ms |
| 2,000 characters, Arabic | 804 | 1,048 / 1,052 ms | 1,006 / 1,079 ms | 1,672 / 1,775 ms |
| A question, English | 18 | 39 / 41 ms | 36 / 41 ms | 53 / 68 ms |
| A question, Arabic | 24 | 47 / 51 ms | 42 / 52 ms | 68 / 86 ms |

Loading takes about 3 s and 1,060 MB of working set. What it decided:

- **Kept, not quantised.** Dynamic int8 broke the model (cosine 0.10 with fp32; MatMul alone 0.89 to
  0.94); weight-only 8-bit kept it (0.9993 to 0.9999) but ran slower (822 ms a chunk), and 4-bit lost
  it (0.95 to 0.98). The package is fp32 with the token table in fp16 (cosine 1.0, the same speed,
  311 MB less): `model.onnx` 1,075 MB, 572 MB zipped.
- **The budget** (`Phase13LocalModelBench`, `bench/phase13.mjs --local-model`): a 2,000-character
  chunk in either language p95 at most 1.5 s, a question p95 at most 100 ms, at the threads the
  server gives the model. Arabic, about twice English's tokens, is the case that binds. A page of 20
  chunks then embeds in under half a minute on the worker, and a question adds under a tenth of a
  second to search by meaning.
- **The tokenizer is the server's own** (`QwenTokenizer`, about 200 lines, no package) rather than
  `Microsoft.ML.Tokenizers`: byte-level BPE over `vocab.json` and `merges.txt`, NFC first, Qwen2's
  split written over code points (.NET's `Regex` reads `\p{L}` per UTF-16 unit and split 17 of 3,000
  cases with letters outside the BMP differently). 20,000 of 20,000 cases gave Hugging Face's
  `tokenizers` tokens exactly (English, Arabic, both digit sets, emoji and joiners, CJK Extension B,
  mathematical letters, every kind of space, CRLF, contractions in any case); added tokens are never
  matched in text. It loads in about 0.5 s and tokenises an Arabic chunk in under 1.5 ms.
- **Threads** (above, Defaults picked).

The host's own run, on 2026-11-21 at 21:20 its time over Remote Desktop (with your word): the same
graph with random weights, which times as the real one does (445 against 454 ms, 1,011 against
1,048 on the reference machine), from a 6.7 MB package unpacked in a scratch folder and deleted after
with its 1.3 GB of weights; nothing installed. The production host is an AMD EPYC 9575F with 12
logical processors, AVX2, AVX-512 and VNNI, and 32 GB; the server gives the model 6 threads there:

| Input | All 12 threads, median / p95 | 8 threads | 6 threads (the server's) | 4 threads |
| --- | --- | --- | --- | --- |
| 2,000 characters, English (402 tokens) | 204.6 / 239.4 ms | 249.6 / 267.3 ms | 243.0 / 311.5 ms | 344.2 / 358.6 ms |
| 2,000 characters, Arabic (804 tokens) | 435.3 / 527.6 ms | 449.8 / 486.3 ms | 513.0 / 551.4 ms | 738.3 / 889.4 ms |
| A question, English (18 tokens) | 20.7 / 22.6 ms | 21.3 / 23.5 ms | 23.9 / 27.8 ms | 27.9 / 30.4 ms |
| A question, Arabic (24 tokens) | 23.5 / 43.4 ms | 26.2 / 28.5 ms | 26.7 / 30.7 ms | 32.2 / 34.4 ms |

Loading took about 1.3 s and 740 to 760 MB of working set. The host runs the model about twice as
fast as the reference machine, so the budget, set where the reference machine meets it, holds there
with room: at the server's 6 threads an Arabic chunk's p95 is 551 ms of 1.5 s and a question's
31 ms of 100.

## 2026-11-22: After 0.13.0 (the Later list reviewed)

Phase 13 was the last planned phase. The plan's "Later" list, with what Phase 13 left for later
(billing for Cash Gear's subscription, added to it the same day), was put to you in one batch:
product themes, then groundwork.

### Answered by you

| Question | Answer |
| --- | --- |
| Product themes for the next phases | Publishing (custom domains for published sites, a rate limit in the Sites process, publishing changes in the change feed, an index of row files for the site's file check); AI, further (AI completions on a local model, on the desktop or the server, and billing for Cash Gear's subscription) |
| Groundwork with them | None for now: the import gaps (Notion's people and outside relations, attachments' bytes before first opened), scale past one node (a backplane), and upgrades (Yjs 14, `@cashgear/app-kit`) stay on "Later" |
| Not chosen | Platforms and offline (a Linux desktop build, a mobile app, comments offline), larger organisations (SAML and SCIM, the test of access lost without a feed change): they stay on "Later" |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| What comes next | Plan the next phases, in a new session, from the two themes; it sizes them against the code, asks its own questions in one batch, and says whether they are one release or two | As after 0.7.0 and 0.10.0: a planning session sizes before anything is promised |
| Not offered as a choice | Embedded presentations (no app yet), SQLite on OPFS (it needs COOP/COEP, which blocks embeds), and snapshotting an ERP view (the hard limits forbid ERP data in a Workspace table) stay on "Later" with their reasons | Nothing to choose while their reason stands |

## 2026-11-22: Phase 14

The two themes chosen after 0.13.0 were sized against 0.13.0 the same day (`IMPLEMENTATION_PLAN.md`,
Phases 14 and 15; nothing run): the Sites process routes by path alone and writes every link under
the slug; Phase 11 already proves a domain by a DNS `TXT` record; nothing on the host makes
certificates, and IIS takes a binding for a new name only from an administrator, unless one
catch-all binding over its Centralized Certificate Store serves them all; publishing writes no
change to the feed; the Sites process has no rate limiter; a site's file check is a `LIKE` over a
database's rows. Found while sizing, by reading: a file in a row's file cell is in `AssetRefs` only
once the row's own document is derived, so until then no other member can read it and the clean-up
deletes it 30 days after its upload (M14.1 shows it by a test first, then fixes it).

### Answered by you

| Question | Answer |
| --- | --- |
| How the themes split | Two releases: Phase 14 (`v0.14.0`) publishing: custom domains, publishing changes in the change feed, a rate limit in the Sites process, an index of rows' files; Phase 15 (`v0.15.0`) AI further: completions on a local model behind a spike, and billing, whose questions (the payment provider, what is charged) are asked when it starts |
| Certificates for a site's domain | Automatic, after a spike on the host: the worker gets a Let's Encrypt certificate by ACME for each proven domain, the Sites process answering the HTTP-01 challenge; kept in IIS's Centralized Certificate Store and renewed before it ends; one catch-all binding on the sites' IIS site (443 by the store, 80 for the challenge) added once by `install.ps1`, so no step per domain. If the spike finds the host's other sites would not keep their bindings, an administrator's step per domain by a script instead |
| Who adds a domain | Owners and admins prove a host name for the workspace by a DNS `TXT` record in Settings → Publishing, as single sign-on's domains; whoever may publish a page chooses one of those for its site; one site a host name |
| The spike and a test domain | On the production host over Remote Desktop at a quiet hour, after you sign in: IIS's bindings read, the catch-all tried on a scratch site and removed, nothing else changed. You give a test host name outside `*.cashgearerp.com` (one the wildcard does not cover) and accept Let's Encrypt's subscriber agreement yourself in the server's settings; tests use Let's Encrypt's staging environment |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| What a domain serves | The site's root at `/`, its pages at `/<pageId>`, its files at `/files/<assetId>`, a `robots.txt` of its own (its site's indexing); `http://` redirects to `https://` once the certificate is live; the slug's address (`pages.cashgearerp.com/<slug>/…`) redirects there (302) from then on, and serves as before until then | One address a site once it has its own; 302 because a browser keeps a 301 after the domain is removed |
| A host name | Lower-case ASCII after IDNA (an Arabic name as its `xn--` form), 4 to 253 characters, two labels or more, no wildcard, port or address; never one of the server's own (the API's, the web app's, the sites', the plugins') nor `localhost`; in development and the e2e stack also `*.localhost`. At most 20 a workspace | A name a certificate can be made for; Chrome sends `*.localhost` to the loopback address, so the tests need no DNS |
| Proving it | A `TXT` record `cgw-verify=<token>` at `_cashgear-workspace.<host>`, 128 random bits shown to owners and admins, read on Verify through Phase 11's reader (`IDomainDns`, moved into the core for the worker too; the mock's stand-in in development); a name verified by one workspace cannot be by another until it removes it. Pointed by a `CNAME` to the sites' host, or by `A`/`AAAA` records holding its addresses; Settings says which is missing | Phase 11's rule and code; the challenge needs the name to reach the host |
| Proof kept | Read again before each renewal and once a day while attached; a record missing on two reads a day apart detaches the name, stops it serving and deletes its certificate (audited `site.domain` with reason `proof.lost`) | A name given up at its registrar must not keep serving one workspace's site, nor be served after another proves it |
| Certificates | RSA 2048, renewed once a third of the lifetime is left (Let's Encrypt's 90 days today, shorter lifetimes later), a failed order retried after 1 h, 6 h, then daily; the ACME account's key as Data Protection's output in the database (the worker holds the key ring), never a file; each certificate as a PFX in the store's folder (`Sites__CertificateStore`), under a password from the environment only (`Sites__CertificatePassword`), the folder readable by administrators, the worker and the store's account alone | IIS's store reads PFX files under one password, so the private key of a site's certificate is a file by necessity, as the Azure client certificate's is (OPERATIONS.md); the ACME key, which could order a certificate for any proven name, is not |
| Let's Encrypt's terms | No order is made unless `Sites__Acme__AgreeToTerms` is `true`, set by whoever runs the server; `Sites__Acme__Directory` names the directory (production's, or staging's), `Sites__Acme__Email` an optional contact | Accepting the subscriber agreement is the operator's act, never the code's |
| The rate limit | One address 300 requests a minute for pages and files across every site (a sliding window of six 10 s segments); the plugins host 1,200 (a frame fetches many files); an IPv6 address counted by its /64; `robots.txt`, `/health/live` and ACME's challenges outside it; past it 429 with `Retry-After` and a page in English and Arabic (the limiter runs before the site is read) | The limit is what stops a flood reaching the database, so it cannot know the site's language; an IPv6 client holds a /64 |
| Publishing in the feed | A `site` change (`entityId` the root page, `upsert` or `delete`) for each publish, change and unpublish, whatever the reason (a person, the switch, the purge), to whoever can read the root page; a `publishing` change (`entityId` the workspace) for the switch and the workspace's domains, to everyone in it; older builds ignore both | A site's page id must not reach someone who cannot see the page; a publisher choosing a domain needs the list |
| Rows' files | `DatabaseRowFiles` (`RowId`, `PropertyId`, `AssetId`, `DatabaseId`, `WorkspaceId`) written with a row's values in the same transaction on every server path (the ops' flush, a type change, a deletion for good, the purge, a CSV import), every files property counted, a deleted one too; filled for existing rows once by the worker (`RowFilesFillJob`, done when `JobStates` holds `rowFilesFill:done`), and until then the clean-up deletes nothing; a row's file readable by whoever can read its database and held by it for the clean-up; the site's and share link's check by it, still for a property some view shows | The index and the values cannot drift if one transaction writes both; the clean-up's 30 days must not end while a row holds a file, nor before the rows written by 0.13.0 are in the index |
| Version | `v0.14.0`, then `v0.15.0` | One version per phase |

## 2026-11-22: Phase 14, the host spike

Run on the production host (Windows Server 2022, IIS 10) over Remote Desktop with your sign-in, by
`deploy/iis/domains-spike.ps1`: its report first (nothing changed), then three tries on a scratch site
and a name nobody uses (`<random>.cgw-spike.invalid`), each removed after.

What the report found: Default Web Site holds the host's only catch-all binding, `http *:80:` (and
`https *:443:*.cashgearerp.com` with no certificate of its own); HTTP.sys's `0.0.0.0:443` gives the
`*.cashgearerp.com` certificate to any name without an SNI entry of its own (`vaultapi.` and
`www.kitchino.info` rely on it); every other name is bound by SNI to a certificate in
`LocalMachine\WebHosting`; win-acme (`\win-acme renew`, daily) renews the per-name certificates by
HTTP-01 from memory (`SelfHosting`) and the wildcard by a manual DNS record; Centralized SSL
Certificate Support is installed and off; port 80 is open.

| Try | Result |
| --- | --- |
| 1. The store's catch-all, `https *:443:` with SslFlags 2 | Refused by IIS: a binding with SslFlags other than 0 must name a host |
| 2. A store binding by name (SslFlags 3) | Not served: the scratch name got the wildcard certificate. IIS adds no HTTP.sys store entry (`ccs=443`) for a binding made by script, and such an entry is port-wide, ahead of the `0.0.0.0:443` fallback that `vaultapi.` and `www.kitchino.info` need. Every other name kept its certificate |
| 3. `site-bindings.ps1` over a PFX as the worker writes one (AES-256) | The name served by its own certificate and the scratch site's file; every other name kept its certificate; the file removed and the script run again, the bindings, HTTP.sys's entry and the certificate were gone. The redirect below added for a moment: the scratch name's `/.well-known/acme-challenge/<probe>` went from 404 to `302 https://pages.cashgearerp.com/.well-known/acme-challenge/<probe>`, its `/` stayed 200, and `www.cashgearerp.com` (bound on 80 by its own site) answered as before |

### Answered by you

| Question | Answer |
| --- | --- |
| The test host name | `docs.test.cashgearerp.com` (two labels under the domain, so the wildcard does not cover it) |
| Port 80 for ACME | Default Web Site holds the catch-all `http *:80:`: send ACME's path alone (`/.well-known/acme-challenge/*`) from it to `https://pages.cashgearerp.com/.well-known/acme-challenge/*`, which the Sites process answers |
| The store's account for the try | You made a local account (`cgw-ccs`) for try 2. The store was dropped after it, so nothing needs the account |
| How names are bound, after try 2 | A scheduled task on the host, as SYSTEM every 2 minutes: an https binding by name for each certificate the worker writes, removed when it is gone; never a name another site binds; it reads no database |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| No Centralized Certificate Store | The task imports each `<host>.pfx` into `LocalMachine\WebHosting` (not exportable, friendly name `cgw-site <host>`) and binds the name by SNI with that certificate, swapped after a renewal; a marked certificate no name uses is removed. Replaces the store and the catch-all of 2026-11-22's "Certificates" answer: the store's folder is now just the worker's folder, readable by administrators, SYSTEM and the worker | Tries 1 and 2: the store needs a host name per binding anyway, plus a port-wide HTTP.sys entry that would stand between the host's unbound names and their certificate. Binding by name is how every other site on the host is bound, and needs no account or second password |
| The PFX password for the task | Read, as SYSTEM, from the worker service's environment in the registry (`Sites__CertificatePassword`), or `CGW_SITES_CERT_PASSWORD` when run by hand | No second copy of the secret anywhere |
| A file the task cannot read | Its name stays bound as it was (logged), rather than taken off the web | A changed password must not take every site down |
| http by name too | The task also binds `http *:80:<host>` on the sites' site, so a renewal's challenge and a plain-http visit reach the Sites process (which sends the visit to https); the redirect on Default Web Site matters only for a name's first certificate | Without it `http://<host>/` would show Default Web Site's page |
| The Sites process on its own host | Answers `/.well-known/acme-challenge/<token>` by the token alone (`SiteReader.ChallengeAsync(null, token)`), from the domains' rows of an order under way, never cached, outside the rate limit | Where the redirect lands; a token is the CA's random value and its answer is published by the order anyway |
| The redirect | A `location` `Default Web Site/.well-known/acme-challenge` with `httpRedirect` to `https://<sites host>$V` (302, exact destination), added by `install.ps1 -CustomDomains` to whichever site holds the catch-all; with none, the sites' site takes the catch-all. win-acme's in-memory validation listens on HTTP.sys's `http://+:80/.well-known/acme-challenge/` while it runs, which comes before any IIS site, so it is unaffected | Your answer; the spike's third try |
| The task's script | `<Root>\scripts\site-bindings.ps1`, the folder changeable by administrators only (it runs as SYSTEM); log `<Root>\logs\site-bindings.log` (names and thumbprints, its last 2,000 lines) | A script SYSTEM runs must not be writable by anyone else |

"Later" reviewed after Phase 14 (you answered): kept as it is, nothing moved (Phase 15 is next), with
Phase 14's two deferrals added: more than one host name a site, and names proven by DNS-01.

Seen on the host and not Workspace's to change (said to you, nothing done): the `*.cashgearerp.com`
certificate that `pages.`, `plugins.`, `workspace-api.`, `api.` and the host's fallback use ends on
2027-01-02 and is renewed by hand (win-acme's manual DNS validation); `cg.` (started) and
`blockhub.`, `blockhubapi.` (stopped) are bound to a certificate for `assissto.cashgearerp.com` that
ended on 2026-04-05.

## 2026-11-24: Phases 16 to 18 planned

A comparison with Notion, PowerPoint and Word, read from the code and nothing changed, found what the
workspace lacks: automations (multi-step rules, triggers, actions, a run log), forms that start them,
tasks in depth (recurring rows, reminders, sub-items, dependencies, buttons, a unique id), slides,
Word's output (an export to Word and PDF, a print layout, suggestions) and an integration surface (a
public API, outgoing webhooks, connectors). You chose the first three for the plan. They were sized
against 0.14.0 the same day (`IMPLEMENTATION_PLAN.md`, Phases 16 to 18; nothing run): a person's edit
to a row ends in `DatabaseOps.FlushAsync`, which holds the old and new values and keeps neither, while
a type change, recomputed values, a CSV import and the tree write rows without it; the worker's jobs
poll their own columns; nothing acts but a member, and the worker writes with no actor; the server
never makes a page, and `cgw-ydoc` cannot build one; `SafeFetcher` already connects only to public
addresses it checked; the server refuses a property type it does not know, with no count of types as
views have; a share link only reads, and nothing takes a row or an upload without a session; a date
holds no time zone; `CgTimeline` draws no links, and the library's recurrence is inside `CgScheduler`.

### Asked by you

| Question | Answer |
| --- | --- |
| What to plan | Automations (multi-step rules, triggers and actions, the run log), a form builder whose answers start them, and tasks in depth (recurring rows, reminders, sub-items, dependencies on the timeline, buttons, a unique id), as the plan's other phases are, committed and pushed to `main` |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Where they go | After Phase 15, as Phases 16, 17 and 18; nothing in them needs Phase 15, so they can go before it if you say | Phase 15 is planned and next |
| The split | Three releases: rules (the engine, a rule acting for its author, buttons, webhooks); forms (the form view and a public link that writes, through the API, never the Sites process); runs that wait, approvals and the tasks' views | Each builds on the one before; the riskiest change to the server, a rule acting for a person, comes first |
| Buttons | In Phase 16, not with the tasks | A button is one of a rule's triggers |
| Track U | U20 (`CgTimeline`'s links between bars) and U21 (`CgScheduler`'s recurrence exported), both for Phase 18 | The library has neither as a component of its own |
| The questions | Each phase's batch asked when it starts, as Phase 15's are | Answers given phases ahead go stale |
| Not planned | Slides, Word's output and the integration surface stay out of the plan until you choose them ("Embedded presentations" is already on "Later") | You chose the first three |

## 2026-11-24: Automations first, and Phase 15's answers

You moved the three new phases ahead of AI, further, so that automations is the current phase. As
each phase is its release (`v0.N.0`), they were numbered again: Phase 15 Automations (`v0.15.0`),
Phase 16 Forms, Phase 17 Workflows and tasks, Phase 18 AI, further (planned on 2026-11-22 as
Phase 15, its milestones now M18.1 and M18.2). Entries above this one keep the numbers they were
written with. Phase 15's questions were then put to you in one batch.

### Answered by you

| Question | Answer |
| --- | --- |
| The order | Automations, forms, workflows and tasks before AI, further: Phases 15 to 17, then 18 |
| What starts a rule | A row added; properties changed, to or from a value; a date property's day or time reached, with an offset; a schedule, daily, weekly or monthly at a time; a button pressed. Only people's edits through the operations and buttons: a CSV import, a type change and recomputed formulas start nothing in 0.15.0 |
| Who a rule acts as | Its author, whose access is checked again at every run; a run its author could no longer make stops, says why in the run log and tells the author in the inbox; a row's editor shows "Automation" with the author's name |
| What it does, and a new row's body | In order, each step under conditions over the row: set properties; add a row to a database the author can edit, with a template's values, icon and cover; notify people, groups or a person property's people, in the inbox and by their mail setting; call a webhook. A template's body is copied by the worker through a new `cgw-ydoc` call that writes a new page's first update, its block ids made once by the server, held to S1's rules by tests; never into an existing page. Nothing reaches the ERP |
| Who manages rules and webhooks, and the limits | Rules on a database by whoever has full access to it, from its views' toolbar; Settings → Automations lists every rule for owners and admins, with a switch for each and one for all. Webhooks by owners and admins only: https to a public address checked by `SafeFetcher`'s rules at every connect, POST only, no redirect followed, JSON of the properties the rule names (never a person's email), signed by HMAC-SHA256 with a secret per webhook under Data Protection, 10 s, retried after 1 m, 5 m, 30 m and 2 h, then given up and logged. A change a rule made starts other rules up to 3 deep; a rule at most 100 runs a minute and a workspace 1,000; 50 rules a database; runs kept 30 days |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Rules as records | Synced as views are: `automation.upsert` and `automation.delete`, the feed's `automation` change to whoever can read the database, ignored by older builds | The pattern every record since Phase 4 follows; older builds skip a type they do not know |
| A run's changes | Ordinary operations with ids of their own, through `DatabaseOps`' checks as the author; devices merge them by Phase 4's per-property rules; a replay changes nothing (`AppliedOps`) | No second write path; a worker that restarts mid-run cannot apply a step twice |
| Row events | Written in `FlushAsync`'s transaction (the row, the properties changed, old and new values) only while the database has a rule switched on, and taken by the worker | The push's cost stays as it is for every database without a rule |
| Time zone | The workspace's, an IANA name owners set in Settings, first the creating person's browser's; a day with no time is that day in the workspace's zone | A date holds no zone; a schedule and a date trigger need one |
| The button | The twenty-first property type, with a `propertyTypes` count beside `viewTypes` so the server keeps a type an older client did not send; a client offers it only once its server's `/version` says it knows it; pressed offline, a notice, and the press is never queued | Production's server has been deployed after its web app; a button runs on the server |
| The new inbox kind | `automation` (a rule's notice, and a run that stopped), mailed by the person's mail setting; its page the row, its actor the rule's author | Notifications need a page and an actor; older builds drop a kind they do not know |
| Version | `v0.15.0` | One version per phase |

Picked while building it (2026-11-24):

| Choice | Default | Reason |
| --- | --- | --- |
| Rules on a device | Held in no local store (the store's schema stays 4): saved through the outbox, so a rule saved offline goes when the device is back; the planner checks a rule's shape only (as a view's) and the editor checks it whole by `checkAutomation` before saving, the server again; the screens read the server's routes and read again on the feed's change | Rules run on the server only; a device has nothing to do with them offline, and a store schema is expensive to change |
| The rules' code in the app | `@cgw/workspace/automations`, an entry of its own, imported by the rule editor when it loads; the package's root exports only its types. The web build keeps the library's flyout, menu and drag code in one chunk (`ui-overlay`) | The initial JavaScript was 349.6 kB of 350 at 0.14.0; with this, 349.5 |
| A workspace made before 0.15.0 | No time zone (read as UTC) until owners or admins set one, or the first rule saved there gives it the saver's browser's | Nothing to ask; the first person to use rules is the likeliest to be in its zone |
| What writes row events | `Databases.EventRules`, the count of rules switched on that start on a row's change (`rowAdded`, `propertyChanged`), kept by `RecountAsync` with every save, deletion and switch, and 0 while the workspace's rules are off; a button's press writes its event by its own route whatever the count | A flush reads the count from the record it holds already: no extra read on a push |
| Depth | A person's change is depth 0, a rule's run one deeper than the change that started it; a run that would be the fourth is recorded `stopped` with reason `depth`, and the row is as the third left it | "Up to 3 deep", each run recorded with what started it |
| The limits | Counted over the last 60 s of runs started (skipped ones not counted); a run past one is recorded `skipped` with `limit.rule` or `limit.workspace` | A run never vanishes without a record |
| Dates and schedules | Looked at every 15 s; a date rule's dates read by its one property (`JSON_VALUE`) and held while the database's rows and the rule are unchanged; a day without a time reached at the trigger's `at` (09:00 by default) in the workspace's zone; in a clock's gap the first minute after it, in a repeated hour its first; a schedule's missed run (the worker stopped) runs once, then the schedule goes on from now; nothing due before a rule was switched on runs | A pass over 50,000 unchanged rows reads none; a rule switched on must not fire for the past |
| A new row's body | `cgw-ydoc`'s `cgw_copy_body` copies the template's body with block ids made from a seed (the run and step), written as the new page's first validated update in the create's transaction | The API loads no Yjs library; the same run taken again makes the same ids |
| The press | `POST /databases/{id}/rows/{rowId}/press` with the press's own id, for someone who may edit the row, answered 202; offline the app says "press it again once you are online" and sends nothing | A press is not a change to queue; the same press sent twice is one |
| The webhook's secret and signature | `cgwh_` and 64 hex digits, shown once; `X-Cgw-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>` with `X-Cgw-Timestamp`, `X-Cgw-Delivery` (one id over every attempt) and `X-Cgw-Webhook`; the body fixed when the run made it | The receiver can check the bytes it got, drop a replay and a call it has had |
| A webhook's values | As a person reads them: options by name, people by id and name (never an email), files by id and name, related rows by title only when the author can read their database | The rule acts as its author and sends nothing they could not read |
| Retention | Hourly: runs, their deliveries, changes taken and rules deleted, after 30 days | "Runs kept 30 days"; a deleted rule's row stays as long so the feed can tell its readers |
| Webhooks in tests | `Automations__AllowLoopback` (`true`, never in Production) lets a webhook call http on a loopback address: the server's tests' receiver and the e2e stack's mock (`tests/mocks/net`, which now records headers) | A real receiver must be reachable; production's rule never loosens |
| The paste budget | Phase 8's paste (100 lines of 10 cells into a 100-row table) with one rule on its Amount changing: a run for each row, the rule's own limit (100 a minute) the paste's size | "A paste that starts a rule in each row"; a larger paste of one rule is the limit's job, not the runner's |
| The push budget | `bench/phase8-server.mjs --rows`: a person changing one row's Points through the operations route at a key's pace, against a database with ten rules switched on that the edits never start (rules on its Status), and the same with none; the same build both sides | A push pays for its event being written and matched; a rule that runs is the run's own work |
| The dates budget | `Phase15Bench`: the worker's time on the dates in a pass after one row of 50,000 changed (every row's date read again), p95; the first pass and passes with nothing changed tracked | The worst a pass meets on a database being edited |
| The old build | v0.14.0 served on 4269 for `old-build.spec.ts` | The next free port below 4270 |

## 2026-11-24: Phase 16

Phase 16's questions were put to you in one batch when it started (`IMPLEMENTATION_PLAN.md`,
Phase 16: Forms, sized against 0.14.0 on the same day).

### Answered by you

| Question | Answer |
| --- | --- |
| Who may answer, and where a link's page is drawn | Members who can edit the database, in the app, offline too, as a row they add; and anyone with a form link, one a form, made by whoever has full access to the database, with its own switch, an optional closing date and a maximum number of answers. The link's page is drawn by the Sites process, under a path no slug can take on the sites' host (`/_form/{token}`), as HTML with no script, in the form's language, and posts to the API's `POST /api/v1/forms/{token}`, which adds the row and sends the browser to the form's thank-you page. The link shows the form's questions and nothing else |
| Questions | A form's questions are its database's properties in an order, each with a label, help text and whether it is required: title, text, number, select, multi-select, status, date, checkbox, URL, email and phone; a select question may show only some of its options. Files, people and relations are asked of members in the app only (nothing takes an upload or shows a person without a session). Questions on pages, a page shown or skipped by earlier answers, decided on the server between pages for a link |
| Abuse | An address answers a form at most 10 times a minute and 100 a day, past which it is answered 429 while others answer on; a hidden field a person never fills (an answer that fills it is dropped); an answer at most 64 KB; no CAPTCHA, which would be a third-party script on a page with none (on "Later") |
| What an answer starts | Both: an answer adds a row, so it starts the database's "a row added" rules as any row does, and rules on a new trigger, "a form answered", that name its form; each once, with the answer's values. A link's row shows the form as its creator (no person). The form's settings offer "Tell people of new answers", which makes a rule with Phase 15's notify step |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The view type | `form`, the eighth (`KNOWN_VIEW_TYPES`, C#'s `ViewTypeOrder`), `viewTypes` 8, with `ViewConfig.form` (its title, description, pages of questions, each page's condition, the thank-you text, the language); an older build draws it as a table and keeps its type and `form` (`ConfigKeysByTypes`: 8 → `form`) | Phase 12's rule for the chart, unchanged |
| A form link | A `FormLinks` record of its own (a form view's, one live a form): its token 32 random bytes kept as its SHA-256, as a share link's is, never a share link's scope; its switch, closing date, maximum and count of answers; deleted for good (a new link is a new token). Audit `form.link.create`, `form.link.update`, `form.link.delete` | A link that writes must never read; a share link's scope reads a subtree |
| A link in a private section | None, as for share links: a database in a private section makes no form link, and one moved there stops taking answers | "A page in a private section takes no access list and no link" (Phase 2) |
| The answer route | `POST /api/v1/forms/{token}`, `application/x-www-form-urlencoded` only, outside antiforgery (it has no session, and a session cookie sent with it is ignored), every value checked by the C# port's coercion and the form's own rules (required, the options shown, the pages its conditions show), the row added through `DatabaseOps` with no member in the workspace's lock. It answers 303 to the thank-you page; an unknown or deleted link 404; a link switched off, closed or full 303 to its page, which says so; a value refused 303 to the form's first page naming the question; past an address's limit 429 with `Retry-After` and a fixed page in both languages holding nothing of the form | A plain HTML form with script off reads only a navigation; nothing the person typed is drawn on the API's origin |
| Pages between | The Sites process takes a page's `POST /_form/{token}`, checks its answers, decides the next page by the conditions and draws it with the earlier answers in hidden fields; it writes nothing. The last page posts to the API, which checks every page again | The Sites process stays a reader; the API's origin draws no text of a form |
| The Sites process's policy | A form link's pages say `form-action 'self' <the API's origin>`; every other page keeps `form-action 'none'` | Only a form posts |
| An answer's address | In its audit entry (`form.answer`: the link, the row, the address), never with the row | The row is the database's; the address is for abuse |
| A member's answer | `page.create` of a row with `formId` (the view) and the answers as its values, through the outbox, offline too; the server keeps `Pages.FormId` when the view is a form of that database. A member who cannot edit the database sees the form's questions and that they cannot add rows here (with the link when there is one) | The rows' ordinary path; nothing new to sync |
| The row's creator | A link's row: `CreatedBy` empty and `FormId` its form, shown in created by as the form's name; a member's: the member | No principal stands for a form |
| Conditions | A page's `when`, in `queryRows`' filter language over the answers so far, evaluated by the shared rules on the device and in the C# port (held by vectors); relative dates in the workspace's time zone | One filter language, as Phase 15's steps |
| On a share link and a site | A form view shows no rows anywhere outside the app: a block naming it draws the form's title and, while its link takes answers, a link to it; a share link's query of it is refused (403 `form.rows`) | "The link showing nothing of the database but its questions" |
| The trigger | `formAnswered` (a form view), beside `rowAdded`: the row's `added` event carries its `FormId`, `EventRules` counts the trigger, and each rule runs once on it | One event, two triggers, runs unique by rule and event (Phase 15) |
| The day's limit | Counted in the API process's memory, partitioned by address (an IPv6 address by its /64) and link; a restart of the API starts the counts again | One API process (DECISIONS.md, production hosting); the minute's limit is what holds a flood |
| The form's language | `en` or `ar`, the words and direction of its link's pages (as a site's), first the maker's app language | The person answering is not signed in |
| Version | `v0.16.0` | One version per phase |
| The old build | v0.15.0 served on 4267 for `old-build.spec.ts` | 4268 is the passkey specs' build |

Picked while building it (2026-11-24):

| Choice | Default | Reason |
| --- | --- | --- |
| A link's token kept twice | As its SHA-256, by which the Sites process and the answer route find it, and as Data Protection's output (purpose `Cgw.Forms.Link.v1`), from which the members' route gives the database's readers its address again | "Share form" shows the address as often as it is opened; the Sites process holds no key ring and needs only the hash |
| A block naming a form, outside the app | On a site, "This database is not published", as for any view a site does not draw; on a share link, the form's questions with nothing to send. This replaces the default above ("its title and, while its link takes answers, a link to it") | The Sites process cannot read a link's token (no key ring), and a page must not give out a form's link its author never put on it |
| Pages between, and the last | Every page of a link posts to the Sites process (`POST /_form/{token}`: `q.<propertyId>`, `at` the page, `go` `next` or `back`, the trap `website`), which checks the page and draws the next or the same one with what is wrong; after the last a 307 sends the same post on to the API, which checks every page again | With script off a form's `action` cannot change with the answers; a 307 keeps the method and the body, and the answers carried in hidden fields are checked whole where the row is written |
| The trap | An answer that fills `website` is answered as one taken (303 to the thank-you page) and adds nothing: no row, no count, no audit entry | A bot learns nothing from its answer |
| Dates on a link | A date question is a date field, or a date and time field when its property has times, read in the workspace's time zone (`FormPosts`) | The person answering has no session to give a zone |
| Counting an answer | One `UPDATE … SET Answers = Answers + 1` that holds the switch, the closing date and the maximum, in the workspace's lock, before the row is made; nothing counted, nothing made | Two answers at once cannot pass a maximum, and a link switched off takes nothing after it |
| The size | 64 KB by the request's `Content-Length`, 413 before anything is read, in the API and in the Sites process | IIS's limit is the whole site's, and the test server ignores a route's own |
| A link's settings | All at once (`PUT …/form/link`: the switch, the closing date, the maximum), the count kept; one link a form (409 `form.linkExists`) | One record a form; a change never half applies |
| A link and its count in the feed | Neither: the form's route is read when the view opens and after each change of the link or answer from this tab | Only full access changes a link, and a change of the feed for every answer would reach every reader of the database |
| Offering a form | "Add a view" offers a form, and the Contacts template makes its contact form, only once the server's `/version` counts eight view types (`DatabaseHost.viewTypeKnown`) | Production's server has been deployed after its web app; a server before 0.16.0 refuses the view |
| A new form view | Asks the title (required) and every property it may ask, in the database's order, on one page | It works from the first click; the builder takes questions away |
| The form's toolbar | No filter, sort, search or New (`supports.rows: false`) | A form reads no rows |
| "Tell me of new answers" | Saves a rule, "a form answered" by this form, that tells the person who pressed it; it is then in ⚡ Automations, to change, switch off or delete | Phase 15's own rule, not a setting of the link's |
| The budget's load | Five forms' links, an answer every 20 ms for 60 s (3,000) whatever the others' answers, the time to the route's 303; the e2e stack raises `RateLimits__formMinute` and `__formDay` so one address may send them | The bench is one address; the limits have their own test |

## 2026-11-24: Phase 17

Phase 17's questions were put to you in one batch when it started (`IMPLEMENTATION_PLAN.md`,
Phase 17: Workflows and tasks, sized against 0.14.0 on the same day), with Tracks U20 and U21.

### Answered by you

| Question | Answer |
| --- | --- |
| Waits, branches and approvals | A rule's steps may also wait (a time, until a date property, or until the row matches conditions; at most 90 days), branch (if, else if, else over the row) and ask for an approval: of people, a group (any one, or all of it) or a person property's people; an inbox item with Approve, Reject and a comment, and a mail; a deadline after which the run takes its "no answer" path; the answer kept in the run log and, if chosen, in a property. A waiting run keeps its place in SQL, reads its row and its author's access again when it goes on, and finishes on the rule's version it started with |
| Recurring rows and reminders, and Track U21 | A database's template with a recurrence (daily, weekly on chosen days, monthly on a day or a weekday, yearly); the next row added by the worker when the last is done or on its date, in the workspace's time zone, its dates moved by the step. Reminders on a date property for a person property's people, or by a person on a row for themselves; at the time, or 15 minutes, an hour, a day or a week before; in the inbox and by mail; a day with no time at 09:00 in the workspace's time zone. U21 (the recurrence fields and their arithmetic exported from `CgScheduler`) built by a session of its own in `CashGear.React.UI` and used by bumping the pin; the next date's arithmetic in `@cgw/workspace` and its C# port, held by shared vectors |
| Sub-items and dependencies, and Track U20 | Sub-items: a database's switch that picks or makes a two-way relation to itself as "Parent" and "Sub-items"; the table nests sub-items under their parent up to five levels; a board and a list show a parent's count; a filter keeps a match's parents shown. Dependencies: a two-way relation to the same database as "Blocked by" and "Blocking"; the timeline draws arrows between bars (U20, built by a session of its own in `CashGear.React.UI` and used by bumping the pin); moving a bar moves the rows it blocks by the same days when the database says so; a loop refused by the planner and the C# port |
| A unique id | The twenty-second property type, behind `propertyTypes`: a prefix and a number the server gives in the row's first insert's transaction, never reused (a deleted row's number stays taken), never edited; "—" on a device until the row reaches the server; rows already in the database numbered in the order they were made when the property is added; sorted and filtered as a number; an older build keeps it |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The order of the milestones | M17.1 (waits, branches, approvals), M17.5 (the unique id), M17.3 (sub-items), then M17.2 (recurrence, on U21's pin) and M17.4 (dependencies, on U20's) | The library's tracks run meanwhile; nothing waits on them until M17.2 |
| Tracks U20 and U21: who builds them | One session of its own in `CashGear.React.UI`, on the branch both pins follow (`claude/cashgear-react-ui-library-xq8tsz`), U21 first, then U20, each pushed when it lands; Workspace bumps its pin for each and adapts in that bump | Two writers on one branch of one checkout would collide; Phase 12's U19 went so |
| New step kinds and the unique id on an older server | A client offers `wait`, `branch` and `approval` steps, and the unique id, only once its server's `/version` says it knows them (`stepKinds`, as `viewTypes` and `propertyTypes`) | Production's server has been deployed after its web app |
| The new inbox kinds | `approval` (an approval asked, with Approve and Reject) and `reminder` (a date reached), each mailed by the person's mail setting; an older build drops a kind it does not know | Phase 15's `automation` kind went so |
| A waiting run | Holds no lock and no transaction: its place is a row of SQL (the step it waits at, until when, on which version of the rule), found by the worker by an index on when it is due; when it goes on it reads its row and its author's access again, and stops, recorded, if either is gone | A wait of 90 days cannot hold anything; a row may change or go while it waits |
| A rule changed or deleted while runs wait | Runs waiting finish on the definition they started with (kept with the run); a rule switched off or deleted stops its waiting runs, recorded | "Finishes on the version it started with"; off means off |
| Recurrence's vectors | `packages/workspace/vectors/db-recurrence-vectors.json`, read by both ports: the 31st in a short month, 29 February, a weekday's fifth week, a time-zone change in the workspace's zone | The risks the plan names |
| Version | `v0.17.0` | One version per phase |
| The old build | v0.16.0 served on 4266 for `old-build.spec.ts` | The next free port below 4267 |

Picked while building it (2026-11-25):

| Choice | Default | Reason |
| --- | --- | --- |
| A step's place | A path: a top-level step's index (`2`), or the list a branch or approval holds and the step in it (`2/0/1`: a branch's paths in order then its otherwise; an approval's approved, rejected, no answer), the same in both ports (`allSteps`, `AllSteps`) | One name for a step in the run log, its ids and a waiting run's place; a top-level step's is Phase 15's index, so its ids are unchanged |
| The shape of the new steps | `wait` (`until`: `time` minutes; `date` a property, an offset and a time of day; `match` conditions and a limit in minutes), `branch` (1 to 10 paths of `when` and steps, and `otherwise`), `approval` (people, groups, person properties, `any` or `all`, a message, `deadlineMinutes`, and `approved`, `rejected`, `noAnswer`); a rule's own list 1 to 20 steps, a path 0 to 20, 50 in all; no branch or approval on the third level | The answers' limits; the vectors hold each refusal by its reason |
| The answer in a property | A `set` or `addRow` step on an approval's approved or rejected path may write `{dynamic: 'approver'}` into a person (who decided it: the first answer, every approver for `all`, the rejection) and `{dynamic: 'comment'}` into a text or the title (their comments, one a line) | "If chosen, in a property" without a setting of its own; the person picks the property as any set step does |
| What wakes a wait | Its time; a change of its row (the change's event, for a `date` or `match` wait: a rule that waits on its row counts in `EventRules`), and an hour at most whatever else; an approval's deciding answer; the run taken by the worker every second at most | A wait never misses its row's change, nor a value a change it was not told of made |
| A wait for a date with none | Goes on at once (recorded `wait.noDate`), as does a date already past; a wait for a date or conditions that has not ended 90 days (or its limit) after it began stops, `wait.expired` | Nothing to wait for; a wait never outlives its limit |
| Approvals of a group | Its members, and each person property's people, who can read the row when the approval is reached (as a notice's); `all` waits for every one of them, and one rejection decides; nobody who could answer takes "no answer" at once (`approval.nobody`) | A person who cannot read the row is never asked |
| Answering | `POST /api/v1/account/approvals/{id}` (`approve` or `reject`, a comment of at most 1,000 characters), once, by the person asked, while they can read the row and the run waits at that step (`approval.answered`, `approval.closed`, 409; another's or one they cannot read, 404); the answer marks their item read | The inbox is the person's across workspaces, as its other routes are |
| A run waiting in the log | `waiting`, its step's detail the instant it goes on at the latest; a branch's step its path (`path:0`, `otherwise`); an approval's how many were asked | The log says where a run is |
| Retention | A waiting run is kept however long ago it started; one that ended, 30 days after it ended; its approvals with it | A wait lasts up to 90 days |
| The words a mail says | "{actor}'s automation asks for your approval on “{page}”" in the person's mail setting, beside Phase 15's | Mail carries every inbox kind |
| The unique id's number | `DatabaseRows.Number`, given from `Databases.NextNumber` in the insert's transaction on every path that stores a row (the operations, a form's answer, a rule's new row, a CSV import), every row's whether or not a property shows it, never a template's; unique by database (`IX_DatabaseRows_Number`); rows stored before 0.17.0 numbered by the migration in the order their pages were made, then by id | Every row has its number before any property asks for it, so a property added later shows numbers in the order the rows were made, and one deleted and added again shows the same ones |
| Its prefix and how it reads | `PropertyDef.uniqueId: {prefix}`, at most 20 characters, shown as `TASK-12` (none: `12`); the number alone is what it sorts and filters by, and a formula reads it as a number; CSV, workbooks, sites and webhooks give it as it reads (CSV guarded as text is); a cell shows "—" until the row has one | One reading in both ports (`uniqueIdText`, `UniqueIds.Text`), held by the query and CSV vectors |
| Where it is offered | On a synced workspace whose server counts 22 property types (`DatabaseHost.propertyTypeKnown`); never on a workspace only on this device, which no server numbers | A number only the server gives would read "—" for ever there |
| A repeating row | The trigger `recurring` of a database's rule: a template of that database, a first day, the repetition (U21's `CgRecurrenceRule` shape, `db/recurrence.ts` and `Recurrence.cs` held by `db-recurrence-vectors.json`), by its days (at a time, 09:00 when none, in the workspace's zone) or by the last done (its checkbox checked or its status complete: the next made at once, on the first of its days not already past), its day written into a date property; the rule's own steps (0 to 20, no conditions) then run for the row it made. "Repeat a template" in the New menu opens the editor on one | One engine for what runs on the server as its author, with its run log, its switch and Settings → Automations |
| Where a series is | `Automations.SeriesNext` (the day it makes a row for next, that day's moment in `NextAt`), `SeriesDay` and `SeriesRowId`; a day's run is made once by its key `recur:<day>`; a day a stopped worker missed is passed over for the latest one; while the workspace's rules are off a series by its days lets the day pass and one by the last done waits; a run whose template is gone stops, `template.gone` | A restart never makes a row twice; a worker stopped for a week makes one row, not seven |
| A rule's reminder | A notice step under a date trigger may be marked `reminder` (kept only then: `step.reminder`), sent as the inbox's `reminder` kind with the date property and the date; a date property's "Remind people of this date" opens the editor on one, a day before, to the first person property's people | "On a date property for a person property's people" with no step kind of its own |
| A person's own reminder | `RowReminders`: a person, a row, one of its date properties, and 0, 15, 60, 1,440 or 10,080 minutes before; set on the row's page by anyone who reads the row (`GET`, `PUT` and `DELETE /api/v1/databases/{id}/rows/{rowId}/reminders`), at most 10,000 a person in a workspace; its moment kept with it and worked out again when the row's date changes (`Databases.Reminders` says a database has any, so others pay nothing) and by the worker every 10 minutes; sent by `ReminderJob` (every second, a thousand at a time) once for each moment, only while the person can read the row and it is not in the trash; one whose moment passed more than a day ago is passed over, and a moment already past when it is set is never sent | "By a person on a row for themselves"; the budget of 10,000 due in a minute |
| Where they are offered | Repeating rows, a reminder notice, "Remind people" and "Remind me" only on a server whose `/version` counts 7 step kinds (`AutomationsHost.knowsWorkflows`) | The same gate as 0.17.0's steps; production's server is deployed after its web app |
| A reminder's mail | "A reminder of “{page}”" (Arabic «تذكير بـ…»), by the person's mail setting | Mail carries every inbox kind |
| Sub-items' tree | A view nests when its database has Parent and Sub-items switched on: each row under the first live row its Parent names (never itself), siblings in the view's order, every ancestor of a row the filter matched shown as context (no match), five levels (deeper rows shown at the fifth), the rows of a loop after the rest; the same in both ports (`queryRows`' `tree`, `Query.Nest`, the query vectors' nested suite); the server pages it by the last row's id | "A filter keeps a match's parents shown" and "five levels" without a second query |
| Relation roles | `relation.role` on each def of a two-way relation to the database itself (`parent` and `subItems`, `blockedBy` and `blocking`), and `shift` on `blockedBy`, set in pairs from a view's Properties menu, which picks a pair the database has or makes one; switched off, the roles go and the relations stay | One relation is any relation; an older build keeps the settings it does not know |
| A loop of dependencies | Refused `dependency.loop` (409) when a row's Blocked by would reach the row itself, from either side's edit, by the planner over the rows the device holds and by the server over all of them, after the relation's reverse edits | "A loop refused by the planner and by the C# port" |
| Dependents moved | With `shift`, a bar moved by whole days takes the rows it blocks and theirs (each once, by their Blocking), of the rows the device holds, by as many days, in the same one write; a resize moves none; the timeline says how many moved | "Moving a bar moves the rows it blocks by the same days"; a chain moves whole |
| The first screen's budget | Phase 17's work took the initial JavaScript to 351.1 kB (the tree, the unique id and the loop check in `@cgw/workspace`, the inbox's new kinds); the desktop's SQLite store, which the web app's platform module imported for nothing, is now imported when the desktop opens it: 348.6 kB | The budget is 350 kB; 3 kB of the web app's first screen was desktop code |

## 2026-11-25: Phase 18

Phase 18's questions were put to you in one batch when it started (`IMPLEMENTATION_PLAN.md`,
Phase 18: AI, further, sized against 0.13.0 on 2026-11-22 and read again against 0.17.0: every
completion still goes through `AiService` and one `IAiProvider`, `AnthropicProvider`, with what
`AiRequestBuilder` built; the allowance is the environment's alone). Looked up before asking: ONNX
Runtime 1.31.1 (26 October 2026) is the server's; ONNX Runtime GenAI's newest release is 0.20.0
(14 November 2026); Qwen3.5 has a 4B model under Apache 2.0; Paddle's checkout can be hosted on its
own domain (`pay.paddle.io`), so the app needs no page of its own for it.

### Answered by you

| Question | Answer |
| --- | --- |
| Where the model runs, and what it does | On the server, in the API process as the embedding model, for the web and the desktop alike, every request still built in `AiRequestBuilder`; every action, each with smaller limits of its own that the spike sets; JSON answers held to the action's schema while they are made; one answer at a time a process, the rest waiting their turn. A model on the desktop stays on "Later" |
| The model, and the spike's downloads | Three candidates measured by the spike for speed and for the app's own actions' answers in English and in Arabic: Qwen3-4B-Instruct-2507 (Apache 2.0), Phi-4-mini-instruct (MIT) and Qwen3.5-4B (Apache 2.0, dropped if the runtime cannot build it). Downloads, each into a folder of its own under `target/spike18`: each model's official weights from Hugging Face (about 8 GB each), a throwaway Python environment (PyTorch for the processor, Transformers, ONNX Runtime GenAI's model builder) for the one build to int4 ONNX, and `Microsoft.ML.OnnxRuntimeGenAI` (MIT) from NuGet; each model's licence and code read before it runs. On the reference machine first, then once on the production host over Remote Desktop at a quiet hour, nothing installed there and its folder deleted after |
| The payment provider | Paddle, as merchant of record (it sells to the customer and handles VAT and sales tax): its hosted checkout and its customer portal, opened from Settings → AI by owners, so no card or payment detail ever reaches the app; its webhooks signed (HMAC); the tests against a mock of it, and the live test in its sandbox by keys you give at the time |
| What is charged | Plans, each a flat price a month a workspace with a monthly allowance of tokens (completions and search by meaning apart), on Phase 13's allowance; prices in Paddle's catalogue and the plans' allowances in the server's environment, never in the code, set at the live test; an upgrade or a downgrade at once, a cancelled plan until the end of the period paid, a failed payment ending the allowance once Paddle stops retrying |
| The live test (asked the same day, once Paddle's sandbox had to reach this machine) | You run it later in Paddle's sandbox, by OPERATIONS.md's runbook; the phase's evidence says it is owed |
| The sandbox's preparation | By Paddle's API with your sandbox key: `scripts/paddle-sandbox.mjs` makes the product, its two monthly prices (Starter 9.00 and Team 29.00 USD) and the webhook destination, the key read from the environment only and a live key refused |
| The host's run | At once (13:23 host time), every package unpacked in a scratch folder and deleted after |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Version | `v0.18.0` | One version per phase |
| The old build | v0.17.0 served on 4265 for `old-build.spec.ts` | The next free port below 4266 |
| The checkout | Paddle's own checkout, opened by Paddle.js (its overlay, the card typed into Paddle's frames) on the Sites process's pay page, `/_pay/en` and `/_pay/ar`, an origin with no sign-in, cookie or session; a transaction made by the server carries the workspace's id (`custom_data`) and names the pay page as its checkout's address. Paddle's hosted checkout (`pay.paddle.io`), which the question named, turned out to be for Mac and iOS apps only, with Paddle's approval | No card or payment detail reaches the app either way; Paddle's script runs where it can reach nothing of the person's |
| The state of a plan | Read from Paddle's API whenever anything says it changed (a webhook, an owner back from the checkout, the daily reconcile); a webhook's body is a prompt to read it, never the state; applied only when Paddle's `updated_at` is newer | "A webhook replayed or forged changes nothing": a forgery fails the signature, a replay finds its event recorded and, were it not, Paddle's state as it is |
| What gives a plan | `active`, `trialing` and `past_due` (Paddle retrying); `paused` and `canceled` none. A workspace on a plan has the larger of the plan's allowance and the default (`Ai__Subscription__MonthlyTokens`); its own override still wins over both | "A failed payment ending the allowance once Paddle stops retrying"; a paid plan never gives less than the free one |
| Where the plan is held | The plan's price on the workspace's AI settings row (`PlanPriceId`), written with `WorkspaceBilling` in one transaction under that row's update lock, which every reservation takes | Every allowance check already reads that row; a call sees the plan or the one before it, never half |
| Who buys | Owners subscribe, change the plan and open the portal; admins see the plan; members and guests see nothing of it | "Opened from Settings → AI by owners" |
| A plan change | At once, prorated (`prorated_immediately`), a failed charge keeping the old plan (`prevent_change`); a second checkout of a workspace on a plan refused (`billing.subscribed`) | "An upgrade or a downgrade at once"; one subscription a workspace |
| An owner back from the checkout | Settings asks the server to read the plan again from Paddle every 5 s for ten minutes while a checkout of the last hour waits, and on focus | The plan shows within a minute even if a webhook is late |
| The daily reconcile | The worker's job each hour reads again every subscription not read for a day (200 a call) and the checkouts of the last day not yet a subscription; events kept 90 days, checkouts that came to nothing 30 | A lost webhook is mended within a day at the latest |
| A workspace deleted for good | Its purge cancels its subscription at Paddle at once, then deletes its billing; Paddle unreachable, the purge waits | Nothing goes on billing a workspace that no longer exists |
| A webhook's time | Within 5 minutes of the server's (Paddle's own libraries allow 5 seconds) | Clocks differ; a replay changes nothing anyway |
| Gated on `/version` | `billing: true` when Paddle's key and secret and a plan are configured; the plan's part of Settings offered only then | Production's server is deployed after its web app |
| The local model's line | A client that asks for it (`events: ['queued']`) is told how many answers are before its own while it waits; one that does not ask (before 0.18.0) is sent no such line | An older client reads an unknown line as a broken answer |
| `ask` on the server's own model | Searched by meaning only when search by meaning is made on the server too (`voyage-4-nano`), else by its words alone | "No text leaves the host" |
| The local model's offer | Every workspace on a server with the package, chosen in Settings → AI as a third source beside the workspace's key and Cash Gear's subscription; no key, no allowance; only the API runs it | The embedding model's offer (Phase 13); its cost is the host's processor, its queue keeps it fair |
| The line's length | 8 answers waiting a process (`Ai__CompletionModel__Queue`); past it 503 `ai.limit` | A ninth would wait for minutes |
| Threads | Half the processors, at most 8 (6 on the production host), as the embedding model's | Writing is bound by memory, not processors: 12 threads on the host wrote a whole answer only about 10 % sooner than 6 |
| The test model | A one-layer Qwen3 over a byte-level vocabulary built by GenAI's own builder (`tests/fixtures/completion-model`, 1.2 MB), its weights fixing its answer (double quotes until its limit; under a schema, the schema's empty shape) | The tests and the e2e stack run the same runtime, tokenizer and guidance as the real package, as Phase 13's stand-in does |
| The local model's budget | A rewrite of 2,000 characters, either language: on the production host 10 s to the first text and 60 s to the end (its run: 7.9 s and 55.5 s at the slowest); on the reference machine, where `Phase18LocalModelBench` runs with the real package, 25 s and 90 s (measured 20.6 s and 80.8 s, Arabic's, at 8 threads) | The plan's budget is the host's and "set by the spike"; the host keeps no package, so the gate a bench holds is the reference machine's, about twice as slow to the first text (no AVX-512 or VNNI) and half again to the end |

### The spike (M18.1): results, and what they decided

Run on 2026-11-25 on the reference machine (Xeon E5-2680 v3, 12 cores, 24 threads, AVX2, no
AVX-512 or VNNI), each model's licence read and no code of a model's repository run (the builder's
`trust_remote_code` off). Each model was built from its official weights to int4 for the processor
(blocks of 32, int8 activations, accuracy level 4) by ONNX Runtime GenAI's own builder, called as a
library (its command line's help text does not parse under Python 3.14), and run by a .NET harness
on the app's own requests (`AiRequestBuilder`'s, every action, English and Arabic notes of 2,000
characters with the faults of a hurried draft), answers up to 1,024 tokens.

| Model | Licence | Revision | Runtime | Tokens for 2,000 characters, English / Arabic | Writing, tokens a second |
| --- | --- | --- | --- | --- | --- |
| Qwen3-4B-Instruct-2507 | Apache 2.0 | `cdbee75` | GenAI 0.19.0, ONNX Runtime 1.31.1 | 523 / 782 | about 8 |
| Phi-4-mini-instruct | MIT | `cfbefac` | GenAI 0.19.0, ONNX Runtime 1.31.1 | 517 / 648 | about 9.5 |
| Qwen3.5-4B | Apache 2.0 | `851bf6e` | GenAI 0.20.0, ONNX Runtime 1.32.0 | 535 / 655 | about 8.4 |

- **Qwen3.5-4B, chosen.** Its Arabic was the best: a rewrite that kept the meaning, a grammar fix
  that corrected the jussive (لم تنتهِ) and the accusatives (عددًا، وقتًا، متفائلًا) without
  changing anything else, a translation that kept the city and the counts, a formal mail, a summary
  with no wrong number; every ERP change right in both languages (all three Riyadh vendors), `ask`
  citing the right page. Asked for a database of up to 100 example rows it wrote past 1,024 tokens:
  the local model is asked for at most 12 properties and 10 rows, in 2,048 tokens. Its hybrid
  attention (three linear layers to one full) keeps about 65 KB a token where Qwen3-4B keeps 294 KB.
- **Qwen3-4B-Instruct-2507**: good English; Arabic with faults that change meaning (a rewrite
  turned "two people instead of four" into a request to take the workers "from 4 to only 2", a translation moved Dammam to
  Dhahran and 25 to 26), a grammar fix that fixed little and turned paragraphs into bullets, an ERP
  change that missed a Riyadh vendor in Arabic.
- **Phi-4-mini-instruct**: wrapped answers in tags and code fences, mistranslated ("Damman", "next
  month", "containers"), repeated itself on a generated page, changed a Dammam vendor for "Riyadh"
  and cited the wrong page. Not offered.
- **The runtime.** GenAI 0.19.0 (the release for the server's ONNX Runtime 1.31) builds Qwen3.5 but
  cannot run it on the processor ("GetMemoryInfo for CPU should not be used"); 0.20.0 does, and asks
  ONNX Runtime 1.32.0 (13 November). The server moves to both: the embedding model gives the same
  vectors on 1.32.0 as on 1.31.1, and both models run in one process on one ONNX Runtime (the
  embedding's vector the same before and after a completion), which was the plan's risk. GenAI's
  builder stays 0.19.0, which built the spike's model; 0.20.0 runs what it builds, its
  multi-token prediction head (`mtp.onnx`) drafting tokens.
- **Accuracy level** 1 (float activations) ran no faster than 4 on this processor (31 against 34
  tokens a second reading a long prompt); 4 is kept, which the host's VNNI favours.
- **GenAI's streaming decoder** writes a replacement character for a character split over two
  tokens (an English answer's curly apostrophe): the provider decodes the answer whole each time
  and sends only what is new and complete.

The host's own run, on 2026-11-25 at 13:23 its time over Remote Desktop (with your word): each
model's graph and real tokenizer with random weights of the real size written on the host (timing
depends on the shapes, not the values: 4 threads read a prompt at 20.6 tokens a second with random
weights and 19.9 with the real ones here), each answer forced to the reference run's length (466
tokens in English, 717 in Arabic), from packages of 30 and 38 MB unpacked in a scratch folder and
deleted after with their weights; nothing installed. The production host is an AMD EPYC 9575F with
12 logical processors, AVX-512 and VNNI. A rewrite of 2,000 characters:

| Model, threads | English: first text / whole | Arabic: first text / whole | Load, peak memory |
| --- | --- | --- | --- |
| Qwen3-4B, 6 (the server's) | 5.6–6.1 s / 34.3–35.6 s | 8.2–8.6 s / 58.2–60.8 s | 7.1 s, 5.0 GB |
| Qwen3-4B, 12 | 3.4–4.2 s / 30.5–34.6 s | 5.2–6.8 s / 48.3–51.9 s | 7.0 s, 5.0 GB |
| Qwen3.5-4B, 6 (the server's) | 6.4–6.8 s / 36.9–37.9 s | 7.9 s / 54.6–55.5 s | 5.6 GB |

Random weights draft no token the model accepts, so Qwen3.5's figures there are its slowest case.
The host writes about twice as fast as the reference machine.

## 2026-11-25: After 0.18.0 (the Later list reviewed)

Phase 18's definition of done asks for "Later" to be reviewed with you. The list was put to you in
one batch: production, the sandbox test, product themes, then groundwork. It included what Phase 18
left on it (a model on the desktop, AI charged otherwise, a larger model or one on a graphics card),
what is owed (production's server, still 0.12.0, and the live test in Paddle's sandbox), and the two
themes of 2026-11-24's comparison that were never chosen (Word's output, and an integration
surface). Found before asking: OPERATIONS.md asks for 0.14.0's server to be installed before
2026-12-14. On that day the clean-up would start deleting the first files in rows' file cells that
no row's document named, those from 0.5.0's install on 2026-11-14.

### Answered by you

| Question | Answer |
| --- | --- |
| Production's server | Now, in a session of its own. 0.18.0 is installed on the host over Remote Desktop at a quiet hour you pick: a verified backup, the migrations of Phases 13 to 18, one `install.ps1` run. Then the live checks owed run on it: `docs.test.cashgearerp.com` with its Let's Encrypt certificate, a webhook to a public receiver, a form link, and a reminder's mail to a real inbox. Whether the local models' packages (572 MB and 3.1 GB) go with it is asked there |
| The live test in Paddle's sandbox | Yours, later, by `scripts/paddle-sandbox.mjs` and OPERATIONS.md's runbook, as decided on 2026-11-25; the evidence keeps saying it is owed |
| Product themes | Documents out: a page exported to Word (.docx) and to PDF, a print layout (page size, margins, header and footer), and suggested edits that a page's editors accept or reject |
| Groundwork with it | None for now. These stay on "Later": the import and offline gaps; publishing further (more than one host name a site, DNS-01); scale and upgrades (a backplane, Yjs 14, `@cashgear/app-kit`, the test of access lost without a feed change) |
| Not chosen | These stay on "Later": AI, Phase 18's leftovers; a public API and larger organisations (workspace tokens with scopes, SAML and SCIM); platforms and offline (a mobile app, a Linux build, comments offline). The public API is added to the list |

Documents out was sized against 0.18.0 the same day (`IMPLEMENTATION_PLAN.md`, Phases 19 and 20;
nothing run):

- Nothing writes OOXML. The server's `DocumentFormat.OpenXml` writes xlsx only. Phase 8's Word
  reader is there for a round trip.
- A page's content and assets are read from the local store, offline too, by the workspace export.
- Nothing prints: the editor draws far blocks lazily and the table only its window. The only
  renderer of a whole page is the server's site renderer.
- A page record has no layout field, and the server applies only the fields an edit sends.
- Every output writes an ERP block as a placeholder or its settings.
- The schema is version 6 with eight marks. A new mark needs version 7, because an older build's
  binding fails on a mark it does not know.
- Levels `comment` and `edit` are distinct, and a push needs `edit`. Updates are relayed only once
  the worker has passed them (Q20), but nothing checks what an update does.
- Every reader of a page's text would read a pending deletion and a pending insertion alike.

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The split | Two releases. Phase 19 (`v0.19.0`) Word, PDF and print: a page's layout, the Word writer, the print view and PDF. Phase 20 (`v0.20.0`) suggested edits: the mode, accept and reject, threads and notices, every reader of a page's text, and commenters suggesting | The export needs no schema change and no new rule on the server. Suggestions raise the schema to 7, add an editor mode and, for commenters, a check of what an update holds: the larger risk, alone in its release |
| The order | Word, PDF and print first | Nothing in it needs suggestions, and it is smaller. Phase 20 then teaches Phase 19's outputs to read a page as it stands. Say if you want them swapped |
| The deploy | Not a phase and no version: a session of its own, proposed now. Its evidence goes in PROGRESS.md under "After 0.18.0: production", as 0.10.0's and 0.12.0's did, and OPERATIONS.md's "Production as installed" is updated | Production follows the releases. Nothing in the deploy changes the code |
| The questions | Each phase's batch is asked when it starts | As every phase |
| Added to "Later" | A public API: workspace tokens with scopes, so other programs read and write pages, databases and rows. This is the integration surface of 2026-11-24's comparison; outgoing webhooks are Phase 15's | It was offered and not chosen. On "Later" it is not lost |
| Not offered as a choice | These stay on "Later" with their reasons: embedded presentations (no app yet), SQLite on OPFS (it needs COOP/COEP, which blocks embeds), snapshotting an ERP view (the hard limits) | Nothing to choose while their reason stands |
| Version | `v0.19.0`, then `v0.20.0` | One version per phase |

## 2026-11-26: A site's certificate after a change of directory

Found by 0.18.0's install in production (PROGRESS.md, After 0.18.0: production): the worker ordered a
live certificate again only once a third of its life was left. After `install.ps1` ran again without
`-AcmeStaging`, `docs.test.cashgearerp.com` would have kept its untrusted Let's Encrypt staging
certificate for about 60 days. It moved on only once its row's `CertificateRenewAt` was set to now by
SQL. A certificate's issuer does not name the directory it came from, so the worker cannot tell
without keeping something.

### Answered by you

| Question | Answer |
| --- | --- |
| How the worker knows a certificate's directory | A nullable column, `SiteDomains.CertificateDirectory` (one additive migration, `SiteCertificateDirectory`), written with each certificate. A live row whose value is not `Sites__Acme__Directory` is ordered anew at once. Not chosen: reading the issuer of the stored `<host>.pfx` (only Let's Encrypt's `(STAGING)` names would tell, so only that one switch), and a `JobStates` row of the directory last ordered from (the whole server, not each name; tests side by side would need keys of their own) |
| A certificate from before the column | Kept until its renewal, with no order at the update. Production's one name already has a production certificate |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Which changes order anew | Any change of directory, back to staging too; a failed order keeps the certificate live and follows the backoff (1 h, 6 h, then daily), as a renewal does | The directory named is the one the operator wants certificates from |
| What else keeps it | `site.domain.certificate`'s audit detail names the directory; a name whose proof is lost loses it with its certificate; the API never shows it | Says where each certificate came from without a new screen |
| Version | None: in the next release, its migration run by the next install | Not a phase |

## 2026-11-26: Phase 19

Phase 19's questions were put to you in one batch when it started (`IMPLEMENTATION_PLAN.md`, Phase
19: Word, PDF and print, sized against 0.18.0 on 2026-11-25). The question tool takes four at a
time, so "PDF on the desktop" was asked with "Where it is made", and "ERP blocks" with "Blocks
that are not text". Read again against `main` (`6f7d5fb`) before asking: nothing writes OOXML or
prints; `CgChart` draws SVG and gives it back by `getSvg()` with its styles inlined, so a chart can
be drawn into the print view and a Word file without the editor; the lockfile already holds
`webview2-com` 0.39.1 and `objc2-web-kit` 0.3.2 (through wry 0.57), the crates a direct PDF would
need.

### Answered by you

| Question | Answer |
| --- | --- |
| Where it is made, and PDF on the desktop | On the device from the local store, offline too, as the workspace export is. Word is written in a worker. PDF comes from the browser's print engine, through the print dialog's Save as PDF, on the web and the desktop; if the spike finds WebView2's `PrintToPdf` works, the Windows app saves straight to a file instead. Nothing is sent to the server |
| What is exported | The page alone, or with its sub-pages (each after a page break, at most 200), from a page's menu and a row's (a row's properties as a table first). Comments are left out and toggles are open. A mention is its text; a page mention links to the page's address in the app |
| Blocks that are not text, and ERP blocks | A database block is a table of its view's rows: its filter, sort and shown properties, a board or list grouped as it groups; at most 1,000 rows, then a line saying how many more. A chart view is its chart; a sheet embed its picture, fetched if the device lacks it; a plugin block its text line; an image or file the device lacks while offline a placeholder, named in a notice after. An ERP block is a placeholder naming its list or report, as every output so far |
| The layout | Kept on the page, so every reader prints it the same way: A4 or Letter (A4 for new pages), portrait or landscape; margins narrow, normal or wide; a header and a footer of text with the page's title, the date and page numbers. The Word file gets the same section. Page setup is in a page's menu, for whoever can edit the page |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| Version | `v0.19.0` | One version per phase |
| The old build | v0.18.0 served on 4264 for `old-build.spec.ts` | The next free port below 4265 |
| A layout's shape | A page record's optional `layout`: `size` (`a4`, `letter`), `orientation`, `margins` (`narrow`, `normal`, `wide`), and `header` and `footer`, each three places (`start`, `center`, `end`) of text of at most 200 characters on one line, in which `{title}`, `{date}`, `{page}` and `{pages}` are fields; at most 4,000 characters as JSON; keys a build does not know kept, and Page setup changes only those it shows | Three places map to the margin boxes and to a header's table of three cells; fields typed in text let a band say "Page 2 of 7" or "Draft · {date}" in any language |
| A page with no layout | A4, portrait, normal margins, no header, its page number at the foot's centre (`{page}`). Nothing is written to a page until Page setup saves, so every page made since 0.1.0 prints by it | "A4 the default for new pages"; a page number is what most printed pages carry |
| Margins | As Word names them: narrow 12.7 mm all round, normal 25.4 mm, wide 25.4 mm at the top and foot and 50.8 mm at the sides | The names people know from Word; the Word file's section is the same |
| Where it is checked | The planner checks only a layout's shape (an object, null or absent, short as JSON), to keep the initial JavaScript within its budget; the server checks every key (`PageLayouts.cs`, held to `vectors/page-layout-vectors.json`) and refuses with `invalid`; an import keeps a layout only when it passes | The server is the check; only Page setup writes layouts, and it checks them first |
| A layout on the server | `Pages.Layout`, `nvarchar(4000)`, the JSON as given (written as JavaScript writes it); `page.create` and `page.update` take it, null takes it off, and an edit that does not name it keeps it; `PageDto` and `RowDto` carry it | "Nothing reaches the server but the layout"; an older build's edits keep it |
| A copy | A page made from a template takes the template's layout; the workspace's export writes it in a page's entry (format 3, an optional key) | A copy prints as its source does |
| Sub-pages | Pages and databases under the page, in the tree's order, depth first, at most 200, never rows or the trash; a database among them is its first view as a table. A row's menu has no sub-pages | "The page alone, or with its sub-pages… at most 200" |
| A row's properties | Every property but the title, in the database's first view's order, each as its cell reads, as a two-column table under the row's title | "A row's properties as a table first" |
| A database block | Its own view, else the database's first; a board's or a list's (or a grouped table's) groups in order, each named with its count, as a line across the table; at most 1,000 rows over the groups, then "Rows not shown: n"; read through the database host, so a database held in full is read on the device, a larger one from the server when online, and offline the rows on this device (named in the notice); a form view is a placeholder naming the form | "At most 1,000 rows, then a line saying how many more" |
| A chart view | Drawn off screen by the library's chart as a document (its title inside, no card), in the light theme, 640 × 300 pixels, its SVG read with its styles inlined: in print as an image of that SVG (no script runs in it), in Word as a PNG at twice its size | "A chart view is its chart"; the same drawing as on screen |
| A plugin block | Its definition's line (`pluginText`); a plugin this build does not know a placeholder naming its type | "A plugin block is its text line" |
| A sheet's picture | The device's (Phase 5's), else the server's when online; else a placeholder naming the workbook, counted in the notice | "Fetched if the device lacks it" |
| An ERP block | A placeholder naming its connector, "Cash Gear ERP: vendors (its data is not exported)", counted in the notice. Nothing of the ERP is read for a file | Your answer; a connector's name needs an ERP session, which a file never opens |
| The notice | After the file is saved or printed, one notice says what is not in it: images the device lacks, sheets' pictures, databases not on the device, databases written with this device's rows only, ERP blocks | "A placeholder and a notice of what was left out, never a silent gap" |
| Word's names | Title, heading 1 to 3 (larger and coloured, never bold, as Word's own), Quote (a rule, not italic), Code (Consolas, shaded), List Paragraph, caption, Callout, Placeholder (dashed), Table Title, the table style Cash Gear Table (its header row and column bold by the style), TOC 1 to 3 | Phase 8's reader reads a style's bold or italic as a mark: no style may add one the page did not have |
| Lists in Word | Bullets one list, check items a list with no marker (so they nest), each run of numbered items a list of its own counting from its first item's start | Numbered lists restart as the editor's do; the reader nests by level |
| A table of contents in Word | Word's TOC field (`\o "1-3" \h \z \u`), its lines written in as links to bookmarks on the headings, so it reads before Word updates it; no "update fields" prompt | A file that opens showing its contents, with no question |
| The header in Word | A table of three cells of no border (start, centre, end; right to left on a right-to-left page), PAGE and NUMPAGES fields, the title by `STYLEREF Title` (each sub-page's own), the date as text | Tab stops mean different things in right-to-left paragraphs; a table does not |
| Images in Word | PNG, JPEG and GIF as they are; any other type a PNG by the canvas first; at their width on the page (else their natural width), never wider or taller than the page's content | Word draws those three everywhere |
| Fonts in print | Segoe UI, Tahoma, Geeza Pro, then the system's: the spike found the generic `sans-serif` (Arial) writes Arabic's initial yeh as the Farsi letter in a PDF's text, and the Mac's system font writes dotless letters with their dots apart; code in Consolas or Menlo | A PDF's text that a search finds |
| The print view's place | In the app's own document, in a root only print media shows (the app hidden, `html` and `body` let out of their fixed height); a frame of its own was the plan's, but the spike found WebView2's `PrintToPdf` saves only the top document and WKWebView prints only its main frame | One way that every engine prints |
| WebKit's print | The Mac app (and Safari) lay the view out at the content's width off screen and cut it into page boxes of the paper's size by script, each with its header and footer and number; the print info's margins are 0. A table goes on a row at a time with its header row again, code a line at a time; a paragraph taller than a page is cut at the page's foot | The spike: WebKit draws no margin boxes, ignores `@page`'s margin, repeats no fixed header and splits table rows |
| Save as PDF | The web: the print dialog, after a line naming its "Save as PDF" printer. The Windows app: a save dialog, then WebView2's `PrintToPdf` with the layout's paper and margins, no print dialog. The Mac app: a save dialog, then an `NSPrintOperation` to that file with no panel | Your answer, and what the spike found WebView2 can do |
| Print | The web and the Windows app: `window.print()` (the engine's dialog); the Mac app: an `NSPrintOperation` with its print panel (WKWebView ignores `window.print()`) | As the spike found each engine prints |
| The initial JavaScript | Page setup, the dialogs, the writers, the paginator and their words load when first asked for; the page menu's four labels are in the catalogues, as the menu draws them at once | 349.6 kB of 350 at the end of the phase |

### The spike (M19.3): results, and what they decided

Run on 2026-11-26 (`bench/print-spike/`, results in `bench/results/print-spike*.json`): one print
document (A4 portrait and Letter landscape; `@page` margins; a header in the top margin boxes with
an Arabic centre and a footer "Page n of N"; English and Arabic paragraphs; six tall pictures; a
table of 60 three-line rows), printed two ways an app would print it: from a frame of its own, and
from the app's own document under print media. pdf.js read every PDF back.

| Engine | How | Frame | App's document | Margin boxes, page numbers | Pictures, rows | Arabic as text in order |
| --- | --- | --- | --- | --- | --- | --- |
| Chrome 158 | `Page.printToPDF`; `window.print()` with `--kiosk-printing` (headed; headless saves nothing) | Pass | Pass | Yes | Whole (once each was capped to the content's height; taller ones were cut) | Yes, with Segoe UI (Arial gave the Farsi yeh) |
| Edge 158 | As Chrome (Edge writes the file and moves it away within 100 ms: read on every change) | Pass | Pass | Yes | Whole | Yes |
| WebView2 158 | Its own `PrintToPdf`, no dialog (`cgw-webview2-host --pdf`) | Prints the app, not the frame | Pass, with the settings' margins or `@page`'s | Yes | Whole | Yes |
| WKWebView, macOS 15 runner | `NSPrintOperation` to a file, no panel (`print-spike.yml`) | Not tried: it prints only its main frame | Paper right; `@page` margins ignored for the print info's | No margin boxes; fixed boxes not repeated; AppKit's own header and footer give its title, the date and "Page n of N" only | Rows split (2 to 4 of 60) | Shaped and in order; the system font writes dotless letters and their dots apart, Tahoma heh and yeh as their Persian letters, Geeza Pro one ligature as a stray mark |
| WKWebView, pages cut by script | The same, the print info's margins 0 | | Pass: 12 and 20 pages as Chrome's | Drawn by the page: every page | Whole | In order (Tahoma's Persian heh and yeh folded) |

What it decided: the print view lives in the app's own document; Chromium (the web, the Windows
app) prints it by `@page` with margin boxes; WebKit (the Mac app) by pages cut by script; the
Windows app saves a PDF straight to a file; fonts as above; pictures capped to the page's content.

## 2026-11-26: CI after 0.19.0, the web app first

CI's Windows job took about 150 minutes a run (run 45738149579: the browser e2e 77, the desktop
app's specs 23, the old builds 5, the kill tests 8, the budgets about 26), one step after another,
while the server's job took 18 and the licence gates 1. Evidence in PROGRESS.md (After 0.19.0).

### Answered by you

| Question | Answer |
| --- | --- |
| What CI builds and tests | "Web version is the most important for now, no need for further desktop build or test": `ci.yml` no longer builds the desktop app or runs its smoke test, its e2e specs (`playwright.desktop.config.ts`), its kill tests (while typing, during a store migration, during sync) or the budgets' desktop parts (`--desktop` of Phases 1, 3, 4, 5 and 6). The release workflow still builds the apps on a version tag. The Rust crates' fmt, clippy and tests and the SQLite store's conformance suite in `pnpm test` stay: under a minute together, and they hold the server's `cgw-ydoc` too |
| The other workflows | Stop `macos.yml` on push (recommended): it runs only when started by hand (Actions, macOS, Run workflow). `release.yml` is unchanged and still builds, signs and tests both apps on a `v*` tag |
| Timing checks failing on young runners (asked after the split's first runs: a 50,000-row import past 30 s, Phase 16's answers at 14 s, a kill test's save past 2 s) | "Try moving heavy files to D:" (recommended): TEMP and TMP, so the browsers' profiles, and each fresh e2e database's files on the runner's D: drive, not under the profile on C:. Not chosen: the budgets after Chrome's whole e2e in one job (about an hour), or the one long job again |

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| How the rest is split | Jobs side by side, each building what it needs itself, none waiting on another: the checks (Rust, types, lint, format, unit tests, S3, S5, S7); the browser e2e in three shards a browser (`--project`, `--shard`), each then a share of the budgets of Phases 7 to 19; the old builds' spec with the builds it serves (`CGW_E2E_WITHOUT_OLD_BUILDS` leaves it out of the shards, where it would skip), then Phases 9 and 19; the kill tests, S6 and the budgets of Phases 1 to 6 | A web build takes under a minute and the server about two: a build job handing them on as artifacts would put its own run and an upload before every other job. Playwright shards by count of tests, file by file within a browser, so Chrome and Edge are sharded apart. Phase 1's gate reads the Chrome kill test's and S6's figures, so they share its job |
| Where the budgets of Phases 7 to 19 run | After the e2e shards' specs, each shard its share by its length (Chrome 1: 8, 18; Chrome 2: 12, 17, 13; Chrome 3: 14; Edge 1: 7; Edge 2: 16, 10; Edge 3: 15; the old builds 9, 19), chosen by the matrix's `include` (`pN`) | In a job of their own (until `faac764`) they failed three of five runs, each time in the job's first 6 to 9 minutes; moving the heaviest last (`50d7d20`) only moved which one met those minutes. After the specs they start 11 minutes and more into a runner, as the one job before 0.19.0 ran them after its e2e |
| The heavy writes | On the runner's D: drive (`b58d5cc`): `.github/actions/setup` sets TEMP and TMP to `RUNNER_TEMP`; `.github/actions/server-stack` sets `CGW_E2E_SQL_DIR`, where `scripts/server-stack.mjs` makes each fresh e2e database's files. LocalDB keeps tempdb in its instance folder (a `MODIFY FILE` is undone when it starts) | Your answer above. Afterwards, on the same processors, Phase 9's 50,000-row import 14.8 s to 6.1 s, Phase 16's answers p95 372 ms to 110 ms, Phase 4's import 10.7 s to 7.3 s: faster than in the one job before 0.19.0 |
| The budgets' figures | An artifact a budget-running job (`phase-verification-early`, `-chrome-1` to `-edge-3`, `-old-builds`); each downloads every `phase-verification*` of the last green run on main (the single one before the split too, and `-later` between) | Each figure is still gated against the last green run on main on the same processor |
| Shared set-up | Two composite actions, `.github/actions/setup` (pnpm, Node, Rust and its cache, .NET, the packages) and `.github/actions/server-stack` (LocalDB, `cgw-ydoc`, the server built) | Every Windows job takes them (nine a run); one place to change a version |
| Rust's cache | The checks keep the one job's key (`windows`, `shared-key`); the jobs building only `cgw-ydoc` share `ffi` | The first run after the split starts warm where the build is large |

## 2026-11-26: Layout bugs reported by hand

Three bugs reported by hand, two with screenshots (a desktop browser and an iPhone): Settings gone
from the sidebar's foot when its tree is long; on a phone, the items of a numbered list typed one by
one blank until the screen scrolled; the screen cut off beside Settings once reached with a long
tree. `tests/e2e/layout.spec.ts` holds each.

### Defaults picked (say if any should change)

| Choice | Default | Reason |
| --- | --- | --- |
| The sidebar's foot | The Sidebar's own column takes what the frame's column leaves under it (`flex: 1 1 0`) and scrolls on its own when even its fixed rows have no room; the sidebar and the drawer's panel clip with `overflow: clip`, not `hidden` | At the frame column's full height it pushed the account, Workbooks and Settings out of a sidebar that clips. A box with `overflow: hidden` is still a scroller: a press or a focus on what it clipped scrolled it, and the sidebar's top was then cut off (the third bug). CgDrawer's panel is 1 px narrower than its content, so a press in the drawer scrolled it sideways (for Track U) |
| WebKit's blank blocks | The top-level block holding the caret is `content-visibility: visible` (one decoration, `is-caret`); every other block keeps `auto` (D26) | WebKit (Safari, iOS, the Mac app's WKWebView) never measures how near the viewport a block made while it holds the caret is, nor when the caret leaves; a block that becomes `auto` again once the caret has left is measured. Not chosen: `auto` off in WebKit by its user agent, which would lose D26 there |
| The WebKit spec | It runs where Playwright's WebKit is installed, or one named by `CGW_E2E_WEBKIT`, from the chrome project only. From 2026-11-27 CI installs Playwright's WebKit in the one chrome shard whose `--list` holds `layout.spec.ts` (`ci.yml`), and on CI a missing WebKit fails the case rather than skipping it | The configured browsers are Chrome and Edge. Playwright shards by count of tests, so the shard holding the file moves as specs are added; listing each chrome shard (about 5 s) finds it, and a missing WebKit failing on CI catches a rename the listing would miss |
