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
