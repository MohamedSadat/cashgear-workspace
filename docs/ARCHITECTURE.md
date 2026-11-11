# Architecture

Cash Gear Workspace is a block-based workspace (documents, a page tree, databases, embedded
sheets and ERP data) that runs in a browser and as a Tauri desktop app, with a cloud backend and
offline editing.

This document says what the parts are and how data moves between them. Why each choice was made
is in `DECISIONS.md`. The stored shapes are in `DATA_MODEL.md`, sync in `SYNC_DESIGN.md`, and the
Sheet and ERP contracts in `INTEGRATIONS.md`.

Status: planning. Nothing here is built. Package and module names are proposals; none exists yet.

## What already exists in the Cash Gear ecosystem

Read from the repositories on 2026-11-11.

### Cash Gear Sheet (`D:\CashGear\Projects\cashgear-sheet`, v1.8.0)

| Area | What is there | Use for Workspace |
| --- | --- | --- |
| Tooling | pnpm 12 workspace, Cargo workspace, React 19.3, TypeScript 6, Vite 8, Tauri ~2.12, Vitest, Playwright, ESLint 10, Prettier 3 | Copy the root configs as the template |
| Licence gates | `deny.toml`, `license-policy.json`, `scripts/check-licenses.mjs` | Copy; same policy (no GPL, AGPL, LGPL, SSPL, BUSL) |
| CI and release | `.github/workflows/ci.yml`, `release.yml`, Azure Static Web Apps deploy, signed NSIS, updater feed on GitHub releases | Copy and rename |
| Tauri shell | `apps/desktop/src-tauri`: strict CSP, updater and dialog plugins, NSIS hooks, minimal capabilities | Copy the skeleton; Workspace's CSP differs (no COEP, `frame-src` for Sheet) |
| Platform split | `SheetPlatform` in `packages/ui/src/platform.ts`, implemented by `apps/web/src/platform/web.ts` and `desktop.ts`, chosen with `isTauri()` | Copy the pattern as `WorkspacePlatform` |
| Theme | `ThemeController` in `packages/ui/src/theme.ts`: system or manual, `data-cg-theme`, window title-bar theme | Copy and trim (no canvas palette) |
| Shortcuts | `packages/ui/src/shortcuts.ts`: Ctrl chords through `event.code`, so they work on an Arabic layout | Copy the mapping approach |
| Worker client | `packages/engine-client/src/client.ts`: Comlink, calls reject once disposed | Copy the pattern for the search and export workers |
| Updater UI | `release/useUpdates.ts`, `ReleaseDialogs.tsx`, `src/updates.rs` | Copy |
| ERP session | `packages/erp-connector`: HTTP client, session, launch ticket, validation of every response | Model for the ERP connector |
| Docs and workflow | `CLAUDE.md`, `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/decisions.md`, phase tags | Same workflow here |
| Formula engine | Formualizer fork, MIT/Apache, behind `crates/cgs-calc` | Candidate for database formulas (Phase 4) |

Not there, so not assumed: an embeddable grid or app component; any iframe, `postMessage` or
embed mode; a read-only or preview mode; a range-to-image API; cloud workbook storage or
identity; user login; autosave (it has a crash-recovery journal instead); an i18n library or an
Arabic UI catalogue; a generic command registry. `AppShell.tsx` is one 3,140-line component.

### Shared UI (`D:\CashGear\Projects\CashGear.React.UI`, `@cashgear/ui` 0.1.0)

- The only React UI library. (`D:\CashGear\Projects\CashGearUI` is a legacy WinForms solution.)
- React 19 peer, no runtime dependencies, CSS Modules, `--cg-*` tokens, `data-cg-theme` for light
  and dark, `data-cg-density`, logical CSS, direction from the nearest `dir`, per-component
  `labels` props for translation, Storybook with Axe.
- Consumed as a git dependency pinned to a commit. Three apps pin three different commits.

| Workspace needs | In the library | Gap (Track U) |
| --- | --- | --- |
| Sidebar tree | `CgTreeView` | Drag-and-drop, lazy loading, virtualisation, inline rename |
| Resizable sidebar | `CgSplitter`, `CgDrawer` | None |
| Menus | `CgMenu`, `CgContextMenu` | None |
| Popovers | `CgFlyout` (anchors to a point or rectangle, flips, RTL-aware) | None; it is the base for the bubble toolbar |
| Slash menu, command palette | `CgListBox`, `CgSearchBox` | A command menu: filtered list, groups, keyboard, anchored to the caret |
| Bubble toolbar | `CgToolbar`, `CgButtonGroup` | A selection-anchored toolbar |
| Block handle, block drag | none | A drag handle and drop indicator |
| Dialogs, toasts | `CgPopup`, `CgMessageBox`, `CgToast`, confirmation provider | None |
| Tabs | `CgTabs` | None |
| Database table view | `CgGrid` | To be assessed in Phase 4 |
| Colours, icons | `CgColorPicker`, `CgIcon` (122 Fluent icons, mostly office) | Block-type and page icons; an emoji picker |
| Breadcrumb, avatar | none | Both |
| Rich text | `CgRichTextEditor` (Tiptap 3.31, sanitised HTML in and out) | Not usable as the block editor; confirms Tiptap is an accepted dependency |
| Ribbon | `CgRibbon` | Not used |

### Cash Gear ERP (`D:\CashGear\Projects\CashGear`)

- .NET 10, EF Core 10 and Dapper, SQL Server only. A database per tenant group plus a `Company`
  column in nearly every key. No EF migrations; schema changes are hand-run scripts. No local
  database.
- UnifiedAPI authenticates with long-lived API keys. For Sheet it has a ticket → session scheme
  with per-entity `Schema`, `Query` and `Commit` (see `INTEGRATIONS.md`).
- Azure Blob Storage is used through a connection string or account key. No signed URLs are
  generated anywhere. One container is public on purpose.
- UnifiedAPI has no rate limiting and an open CORS policy outside the Sheet routes. SignalR hub
  classes exist but none is mapped.
- Not inspected: production hosting, the live workflow configuration (it exists only in the
  database), and whether secrets in settings files are real.

What Workspace reuses from the ERP is the launch-ticket session pattern and its connector
contract. It does not share the ERP's identity store, database or deployment.

## Architecture options compared

| Option | Sketch | Verdict |
| --- | --- | --- |
| A. Local-first, CRDT documents, relational metadata, ASP.NET Core backend | Tiptap + Yjs in the client; SQL Server and Blob on the server; TypeScript sync engine over a local store | **Chosen** |
| B. Server-authoritative JSON documents | ProseMirror JSON saved by HTTP; the server is the truth | Simplest now. Offline on two devices can only be whole-page last-writer-wins, and real-time later means migrating every document and rewriting undo and sync |
| C. Everything in CRDTs, including the tree and databases | One sync mechanism | A CRDT cannot enforce "no cycles", permissions or uniqueness; moves in Yjs are delete and insert; server-side filtering of database rows would need to decode documents |
| D. Rust core compiled to WASM for the document model, as Sheet does for cells | One engine, native and web | Sheet draws to a canvas, so the engine can own the data. A rich-text editor is bound to the DOM, the IME and the selection; a WASM hop per keystroke costs, and every mature editor is TypeScript |
| E. Node collaboration server (Hocuspocus) | Ready-made Yjs server | Adds a Node service to a .NET estate that has none |

## System overview

```mermaid
flowchart LR
  subgraph Client["Client: browser tab or Tauri window"]
    Shell["Shell<br/>sidebar, search, settings, theme, i18n"]
    Editor["Editor<br/>Tiptap + ProseMirror"]
    Doc["Document layer<br/>Y.Doc per page, block ids, schema"]
    WS["Workspace layer<br/>page tree, outbox, sync engine"]
    LS[("Local store<br/>IndexedDB or SQLite")]
    Shell --> Editor --> Doc --> WS
    Shell --> WS
    WS --> LS
  end

  subgraph Server["Workspace backend (this repo)"]
    API["API<br/>ASP.NET Core"]
    Worker["Worker<br/>compaction, text, validation"]
    SQL[("SQL Server")]
    Blob[("Azure Blob<br/>private")]
    API --> SQL
    Worker --> SQL
    Worker --> Blob
    API -. "signed URL" .-> Blob
  end

  WS -- "HTTPS: ops, changes, doc updates" --> API
  Client -- "signed URL: assets, snapshots" --> Blob
  Client -- "iframe + messages" --> Sheet["Cash Gear Sheet<br/>embed route"]
  Client -- "session: Schema, Query, Commit" --> ERP["Cash Gear ERP<br/>UnifiedAPI"]
```

Solid arrows inside the client are calls; the editor never talks to the network or to storage.

## The client

### Layers

```mermaid
flowchart TB
  UI["@cashgear/ui<br/>(pinned git dependency)"]
  Shell["shell<br/>app frame, sidebar, routing, search UI, settings, theme, i18n, platform interface"]
  Editor["editor<br/>Tiptap extensions, node views, slash menu, bubble toolbar, block handle"]
  Doc["doc<br/>schema, block-id plugin, Yjs binding seam, text extraction, migrations"]
  Workspace["workspace<br/>page tree, order keys, operations, outbox, sync engine, LocalStore interface"]
  StoreWeb["store-web<br/>IndexedDB"]
  StoreDesk["desktop store<br/>Tauri commands → cgw-store (SQLite)"]
  Api["api<br/>generated client"]

  Shell --> UI
  Editor --> UI
  Shell --> Editor
  Shell --> Workspace
  Editor --> Doc
  Doc --> Workspace
  Workspace --> StoreWeb
  Workspace --> StoreDesk
  Workspace --> Api
```

Dependency rules, enforced by lint:

- `doc` and `workspace` import no React and no DOM. They run in a worker and in Node tests.
- `workspace` knows nothing about ProseMirror or Tiptap. It stores and moves opaque Yjs bytes.
  This is what keeps the page hierarchy independent of the editor.
- `editor` knows nothing about storage or the network. It is given a `Y.Doc` and callbacks.
- Only `shell` knows which platform it runs on, through the platform interface.

### Proposed repository layout

Package level only. Files inside are decided by the phase that creates them.

| Path | What | Phase |
| --- | --- | --- |
| `apps/web` | Vite + React app and PWA; picks the platform | 0 |
| `apps/desktop` | Tauri 2 shell | 0 |
| `packages/doc` (`@cgw/doc`) | Document schema, block ids, Yjs seam, migrations, text extraction | 1 |
| `packages/editor` (`@cgw/editor`) | The block editor | 1 |
| `packages/workspace` (`@cgw/workspace`) | Tree, operations, outbox, sync engine, `LocalStore` | 1 |
| `packages/store-web` (`@cgw/store-web`) | `LocalStore` on IndexedDB | 1 |
| `packages/shell` (`@cgw/shell`) | App frame and everything around the editor | 1 |
| `packages/api` (`@cgw/api`) | Client generated from the server's OpenAPI document | 2 |
| `packages/erp` (`@cgw/erp`) | ERP connector client | 5 |
| `crates/cgw-store` | `LocalStore` on SQLite, with FTS5 | 1 |
| `crates/cgw-native` | Desktop helpers: keychain, files, deep links | 1 |
| `crates/cgw-ydoc` | Bytes-in, bytes-out Yjs functions over `yrs` | 0 (spike), 2 |
| `server/` | .NET solution: API, worker, domain, infrastructure, tests | 2 |
| `tests/e2e`, `tests/mocks`, `bench/`, `scripts/`, `docs/` | As in Sheet | 0 |

### Responsibilities

| Component | Owns | Does not |
| --- | --- | --- |
| Shell | Window layout, sidebar, breadcrumbs, routing, search box and results, settings, profile, workspace switcher, theme, language, connection status | Touch document content |
| Editor | Typing, selection, formatting, slash menu, Markdown shortcuts, drag and drop, clipboard, node views, keyboard navigation | Save, load, or call the network |
| Document layer | The schema; block ids; binding ProseMirror to a `Y.Doc`; undo; plain-text and Markdown output; schema-version check and migrations | Know where bytes are stored |
| Workspace layer | The page tree and its rules on the client; operations and the outbox; the sync loop; opening and closing documents; asset upload queue | Know what is inside a document |
| Local store | Durable local data behind `LocalStore` | Decide anything |
| Platform | What differs between browser and desktop: window theme, file dialogs, deep links, updater, keychain, which `LocalStore` | Hold app logic |

### Platform interface

Modelled on `SheetPlatform`, with different members:

```ts
interface WorkspacePlatform {
  kind: 'web' | 'desktop';
  store(): LocalStore;
  setWindowTheme(theme: Theme | null): Promise<void>;
  pickFiles(accept: string[]): Promise<File[]>;
  saveFile(suggestedName: string, bytes: Blob): Promise<void>;       // export
  openExternal(url: string): Promise<void>;
  onDeepLink?(handler: (url: string) => void): () => void;           // desktop
  auth: AuthPlatform;                                                 // cookie session or PKCE + keychain (Phase 2)
  updates?: { check(): Promise<UpdateInfo | null>; install(onProgress: Progress): Promise<void> };
  onCloseRequested?(ask: () => Promise<boolean>): () => void;
}
```

### The editor

- **Engine.** Tiptap 3 on ProseMirror, with `prosemirror-tables` for tables.
- **Schema.** A uniform block container (`DATA_MODEL.md`). Lists are blocks.
- **Node views.** Plain DOM for paragraphs, headings, list items, quotes, dividers. React for
  images, files, tables' controls, bookmarks, child pages, and every embed. Heavy node views mount
  when scrolled near and unmount when far.
- **Slash menu.** Typing `/` opens a command menu at the caret, filtered as the user types, in
  the interface language, with keywords in both languages.
- **Markdown shortcuts.** Input rules: `#`, `##`, `###`, `-`, `1.`, `[]`, `>`, ```` ``` ````, `---`,
  `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`.
- **Bubble toolbar.** On a text selection: bold, italic, underline, strike, code, link, colour,
  turn into. On a block selection: turn into, duplicate, delete, colour.
- **Block handle.** Appears beside the hovered or focused block: drag to move, click for the
  block menu. Reachable by keyboard.
- **Conversion.** "Turn into" changes the body kind and keeps the id, the text, the marks that
  are valid in the target, and the children.
- **Clipboard.** Copy writes our own format (with fresh-id marking), HTML and plain text. Paste
  prefers our format, then HTML through the schema's parser, then Markdown, then plain text.
  Pasted blocks always get new ids.
- **Undo.** Yjs `UndoManager`, tracking only the local user's changes.
- **Keyboard.** Everything reachable without a mouse: arrows across blocks, Tab and Shift+Tab to
  indent, Alt+Shift+arrows to move a block, Esc to select the block, Ctrl+/ for the block menu.
  Ctrl chords map through `event.code`, as Sheet does, so they work on an Arabic layout.

### Commands

One small command registry in the shell: `{ id, label, icon, shortcut, when, run }`. The slash
menu, the bubble toolbar, the block menu, the search palette (Ctrl+K) and keyboard shortcuts all
read it. This is new; Sheet has typed engine commands but no generic registry to reuse.

### Search

| Where | Index | Covers |
| --- | --- | --- |
| Browser | In memory, built in a worker from the local mirror and cached page text | Titles of every page; text of pages this device holds |
| Desktop | FTS5 in the local SQLite store | The same, durable |
| Server (Phase 2) | SQL Server full-text over `PageDocDerived.SearchText` and titles | Everything the caller may read |

Online, results from the server and the local index are merged, local first. Text is normalised
the same way everywhere before indexing and querying (D25). Results are filtered by permission on
the server at query time, never by the client.

## The backend

One ASP.NET Core (.NET 10) solution in `server/`. Two processes.

| Process | Does | Never |
| --- | --- | --- |
| API | Authentication, authorisation, operations, change feed, document push and pull, asset tickets, search queries, sharing, version listing | Loads a Yjs library |
| Worker | Compaction, snapshots, validation of updates, derived JSON and text, backlinks, asset reference counting and clean-up, retention, exports | Serves requests |

Modules, each with its own folder, services and tests: Identity, Workspaces, Pages, Documents,
Assets, Search, Sharing, Sync, Audit, and later Databases, Workbooks, ErpLinks, Realtime, Ai.

Conventions:

- **API style.** REST under `/api/v1`. JSON in camelCase. Resource routes, not verbs.
- **Contracts.** The OpenAPI document is generated from the code and checked into the repo. The
  TypeScript client is generated from it. A change to it shows in review.
- **Errors.** RFC 9457 ProblemDetails with a stable `code` (for example `tree.cycle`,
  `doc.epochMismatch`, `version.conflict`) and a `correlationId`. Clients switch on `code`, never
  on text.
- **Concurrency.** `ETag` and `If-Match` on single-record writes; `baseVersion` in operations.
- **Paging.** Keyset, with an opaque cursor.
- **Results.** Services return a result type, not exceptions, for expected failures.
- **Data access.** EF Core with migrations. A global query filter applies the workspace scope;
  raw SQL is allowed only in named, tested queries (search, the closure table).
- **Tests.** Each module is tested against a real SQL Server in a container, not an in-memory
  provider.

### Tenancy

- The workspace is the tenant. Every tenant-owned row has `WorkspaceId`.
- A request's workspace comes from the route, and the caller's membership is checked before any
  handler runs. The EF Core filter then scopes every query.
- A test walks every entity type and fails if one with `WorkspaceId` lacks the filter.
- Blob names start with the workspace id, and a signed URL covers exactly one blob.

### Authentication

| Client | Flow | Credential at rest |
| --- | --- | --- |
| Web app | Sign in on the API's own pages; `Secure`, `HttpOnly`, `SameSite=Lax` cookie; antiforgery token on writes | Cookie only. Nothing in `localStorage` |
| Desktop app | Authorisation code with PKCE through the system browser, returning by deep link or loopback | Refresh token in the OS keychain; access token in memory |
| Sheet (opening a workbook) | One-time launch ticket → file session | In memory |
| ERP blocks | One-time ticket from the ERP → ERP session | In memory |

Accounts are ASP.NET Core Identity. OpenIddict issues tokens. Sign-in is rate-limited and locks
out after repeated failures. Passkeys and external providers can be added through Identity later.

## Where data lives

| Store | Holds | Never |
| --- | --- | --- |
| SQL Server | Accounts, workspaces, members, sections, pages and the closure table, permissions, favourites, the Yjs update log, the snapshot index, derived JSON and search text, asset metadata, databases and rows, the change feed, applied operations, the audit log, ERP links | Binary assets; ERP data |
| Azure Blob (private) | Images, attachments, compaction and history snapshots, workbook versions, exports | One object per block; anything public |
| Browser storage (IndexedDB) | The metadata mirror, cached documents, the outbox, cached and queued assets, preferences | Credentials; ERP data |
| Desktop (SQLite file, asset files, keychain) | The same as the browser, plus the FTS5 index and pinned pages; the refresh token in the keychain | The refresh token in a file |
| Memory | Open `Y.Doc`s, ProseMirror state, presence, access tokens, ERP sessions and query results | Anything that must survive a restart |

## Data flow

### Typing a character

```mermaid
sequenceDiagram
  participant U as User
  participant E as Editor
  participant D as Document layer
  participant L as Local store
  participant S as Sync engine
  participant A as API
  U->>E: key
  E->>D: ProseMirror transaction → Y.Doc update
  E-->>U: paint (budget 16 ms)
  D->>L: batch ≤ 500 ms, append update
  L-->>D: stored → "Saved"
  D->>S: page has unsent updates
  S->>A: POST doc/updates
  A-->>S: acks with sequence numbers
  S->>L: mark acknowledged
```

Paint does not wait for storage, and storage does not wait for the network.

### Opening a page

1. The shell asks the workspace layer for the page. The record comes from the local mirror at once.
2. The local store returns the snapshot and updates; the document layer builds the `Y.Doc`.
3. The document layer checks `schemaVersion`. Too new for this build: read-only view and a
   prompt to update.
4. The editor binds and paints.
5. In the background the sync engine pulls updates after the last sequence it holds and applies
   them; the editor updates in place.
6. A page this device does not hold: steps 2 to 4 wait for the pull, with a skeleton shown.

### Creating a page offline

1. The client makes a page id and an order key, applies `page.create` to the mirror and the
   outbox in one transaction, and creates an empty document locally.
2. The page appears in the sidebar and opens.
3. When the network returns, the outbox is pushed, then the document's updates.

### Inserting an image

1. The file is checked (type, size), stored in the local store, and shown from there.
2. With an account: the client asks the API for an upload ticket, gets a signed URL for one blob,
   uploads straight to Blob Storage, and confirms. The worker checks the content type against the
   bytes and, for images, records dimensions.
3. The block stores the asset id only.

## Autosave, version history, backup

- **Autosave.** Local, within a second, no network (`SYNC_DESIGN.md`).
- **Version history.** Full-state snapshots written by the worker; restore is a forward edit.
- **Backup.** SQL Server full, differential and log backups with point-in-time restore; Blob soft
  delete and versioning with a retention of at least 30 days. SQL and Blob can drift by minutes
  after a restore, so the worker has a reconcile job: a snapshot row without a blob is dropped,
  and the page falls back to the previous snapshot plus updates.
- **Restore drill.** Restoring to a scratch environment and opening pages is an exit criterion of
  Phase 2, and is repeated each release.

## Security

| Concern | Design |
| --- | --- |
| Authentication | Own accounts; cookie for web, PKCE for desktop; lockout and rate limits on sign-in |
| Authorisation | Decided on the server for every request from membership, role and page permissions. The interface hiding a button is never the control |
| Tenant isolation | Workspace id from the route, membership check, query filter, test that every entity is filtered, blob paths under the workspace id |
| Workspace roles | Owner, admin, member, guest |
| Page sharing | Per page with inheritance; access lists by user or whole workspace; share links off by default, created by a person, hashed, expiring, revocable, view-only at first |
| No public URLs | Nothing is reachable without a session or a share link someone made. Blob containers are private |
| Attachments | Signed URL for one blob, about 5 minutes, issued after a permission check. Downloads are served with `Content-Disposition: attachment` and a safe content type; images are served only as images |
| Upload safety | Allow-list of types; size limit; type checked against the bytes; SVG is not rendered inline; a hook for malware scanning before `ready` |
| XSS | Content is drawn only through the ProseMirror schema, which whitelists nodes and attributes. No `innerHTML` from document data. Pasted HTML goes through the schema parser, so scripts, handlers and unknown attributes do not survive |
| Links | Scheme allow-list checked when parsed, when drawn and when clicked; external links open with `noopener noreferrer` |
| Embedded content | Sandboxed iframes from an allow-list of origins; bookmarks are static cards, with previews fetched by the server |
| Link previews | Server-side fetch behind an SSRF guard: public addresses only, no redirects to private ranges, size and time limits |
| Content Security Policy | `default-src 'self'`; `script-src 'self'` (plus `'wasm-unsafe-eval'` only if WASM is loaded); `frame-src` the Sheet origin; `img-src 'self' blob: data:` and the blob host; `connect-src` the API, the blob host and linked ERP origins. No COEP |
| Tauri | Minimal capabilities; typed commands only; no command takes SQL, a path outside the app's data directory, or a URL to fetch; `frame-src` as on the web |
| Rate limiting | ASP.NET Core rate limiter: per IP on anonymous routes, per user and per workspace on the rest, tighter on sign-in, ticket redemption, push and search |
| Audit | Append-only log of sign-ins, member and role changes, sharing changes, exports, restores, permanent deletions, ERP link changes, with a correlation id |
| Token storage | Web: cookie only. Desktop: OS keychain. ERP and file sessions: memory only. Tickets and sessions are stored hashed on the server |
| Secrets | Not in the repo and not in settings files. Environment or a secret store; managed identity for Blob where the host allows it. A CI check fails on a committed secret |
| Transport | HTTPS only, HSTS |
| Export and deletion | A workspace exports as a zip. Workspace and account deletion are described in `DATA_MODEL.md` |
| Backup and restore | Above |
| Dependencies | Licence gate and `cargo deny` in CI, as in Sheet; lockfiles committed |

## Performance

Targets, validated in Phase 0 and then gated in CI.

| Measure | Budget | How it is measured |
| --- | --- | --- |
| Cold start to an editable page, desktop | ≤ 1.5 s | Playwright against the built app, from process start to first editable paint |
| Cold start to an editable page, web, cached | ≤ 2 s | Lighthouse and a Playwright trace on a mid-range laptop profile |
| Open a 200-block page from the local store | ≤ 300 ms | `performance.mark` around open; p95 of 30 runs |
| Open a 2,000-block page | ≤ 1 s | Same |
| Keystroke to paint, typical page (200 blocks), p95 | ≤ 16 ms | Scripted typing with event timing, Chrome and WebView2 |
| Keystroke to paint, 5,000 blocks, p95 | ≤ 50 ms | Same |
| Heap with a 5,000-block page open | ≤ 150 MB | `performance.measureUserAgentSpecificMemory` or a heap snapshot |
| Sidebar: expand a node in a 10,000-page workspace | ≤ 100 ms | Scripted, virtualised tree |
| Local search over 10,000 pages | ≤ 100 ms | Scripted queries in Arabic and English |
| Edit durable locally | ≤ 1 s after the last key | Kill test |
| Push round trip, one update | ≤ 200 ms at the server, p95 | Server timing under load |
| Initial JavaScript, gzip | ≤ 350 kB before the editor loads; the editor in its own chunk | Build report, gated |

How the budgets are met:

- **Rendering.** Plain DOM node views for common blocks; `content-visibility: auto` with a size
  hint on top-level blocks; heavy node views mounted lazily. React state is kept out of the
  typing path: the editor is not re-rendered by React on each transaction.
- **Incremental updates.** Yjs updates are small differences; only those are stored and sent.
- **Large workspaces.** The sidebar draws from the metadata mirror with a virtualised tree; no
  document is loaded for it.
- **Multiple open documents.** At most a few `Y.Doc`s stay in memory; others are closed and
  reopened from the local store.
- **Background work.** Search indexing, export, and compaction of local documents run in workers.
- **Embeds.** A sheet embed loads its iframe only when near the viewport; before that it shows
  the stored picture. A database view asks for a page of rows at a time and virtualises its own
  rows.
- **Startup.** The shell paints from the mirror before the editor chunk loads; the last page's
  document is read in parallel.
- **Parity.** The same build and the same budgets on Chrome and on WebView2; the desktop adds only
  the store and the shell.

Benchmarks live in `bench/`, use a generator that makes Arabic, English and mixed documents of a
given size and block mix, and write results the CI compares with the last run on `main`.

## User interface

```
┌────────────┬────────────────────────────────────────────────────┐
│ Workspace ▾│  Section › Parent › Page            ⌕  ☆  ⋯  Saved │
│ ⌕ Search   ├────────────────────────────────────────────────────┤
│ Favourites │                                                    │
│  ☆ …       │   [cover]                                          │
│ Section    │   📄  Page title                                   │
│  ▸ Page    │                                                    │
│  ▾ Page    │   ⠿ Paragraph …                                    │
│     Page   │   ⠿ ▸ Toggle                                       │
│ Private    │   ⠿ ☐ Task                                         │
│  ▸ Page    │        ┌ B I U S <> 🔗 A ▾ Turn into ▾ ┐           │
│            │                                                    │
│ Trash      │                                                    │
│ ⚙ Settings │                                                    │
│ 👤 Profile │                                                    │
└────────────┴────────────────────────────────────────────────────┘
```

- **Left sidebar.** Collapsible and resizable (`CgSplitter`): workspace switcher, search,
  favourites, sections with nested pages, trash, settings, profile. On a narrow screen it becomes
  a drawer (`CgDrawer`).
- **Top bar.** Breadcrumbs, search, favourite, page menu (history, export, move, delete), save
  and connection status.
- **No ribbon.** A bubble toolbar on selection, a slash menu, and a block handle menu.
- **Themes.** Light and dark through `data-cg-theme` and the `--cg-*` tokens; follows the system
  or a manual choice. Text and highlight colours in documents are named tokens, so a document
  reads correctly in both.
- **Languages.** English and Arabic catalogues. Changing language changes `dir` on `<html>`.
- **RTL.** Logical CSS only. The sidebar, breadcrumbs, menus and the block handle mirror. Each
  text block takes its direction from its first strong character unless set, so a page mixes
  Arabic and English paragraphs. Lists, toggles and tables follow their content.
- **Keyboard first.** Every action has a command and a shortcut; Ctrl+K opens search and
  commands; focus order follows reading order in both directions.
- **Mobile browsers.** The layout is responsive and usable by touch: the drawer sidebar, a
  toolbar above the keyboard in place of the bubble toolbar, long-press for the block menu. Drag
  to reorder is replaced by "Move up" and "Move down" there. A native mobile app is not planned.
- **Accessibility.** WCAG 2.2 AA as the target: roles and names on every control, visible focus,
  contrast from the tokens, reduced motion respected, Axe run in CI on the main screens, and a
  screen-reader pass per phase.
- **High-DPI.** Vector icons, no bitmap chrome, images drawn at the device's pixel ratio.

## Risks and trade-offs

| Risk | Earliest phase | What is done about it |
| --- | --- | --- |
| The block-container schema fights ProseMirror or Yjs (caret, split, paste) | 0 | Spike S1 and S5 before any feature |
| Block ids churn or duplicate under Yjs | 0 | Own plugin; spike S1 with 10,000 random operations |
| A stale client damages documents | 0 | Schema-version gate; spike S2 |
| The in-house `yrs` library diverges from Yjs | 0 | Spike S3 against 1,000 fuzzed documents; YDotNet as fallback (S4) |
| Arabic IME, bidi caret or list markers misbehave in WebView2 | 0 | Spike S5 with a scripted checklist |
| Large pages miss the keystroke budget | 0 | Spike S6; the fallbacks are lighter node views and splitting pages |
| Yjs moves lose concurrent edits | 3 | A stated limit; tests; version history |
| Local browser storage is evicted | 1 | Persistent-storage request; export from the first milestone; say "on this device only" |
| Identity is security-critical code we host | 2 | ASP.NET Core Identity and OpenIddict, no custom crypto; rate limits; audit |
| SQL and Blob drift after a restore | 2 | Reconcile job; restore drill as an exit criterion |
| Sheet embed blocked by cross-origin isolation | 0 | Spike S9; the fallback is the stored picture plus "Open in Sheet" |
| Phase 5 waits on work in other repos | 5 | Mocks for both contracts; Track S starts during Phase 4 |
| The UI library needs many new components | 1 | Track U listed up front; built there, pinned here |
| Real-time needs more than one server node | 6 | Stateless hub; decided when measured |
| Scope: a Notion clone is large | every | Phases that each ship; a strict MVP; "Later" lists |

Trade-offs accepted, in one place:

- Two sync mechanisms (CRDT for content, operations for the rest) instead of one.
- A Rust library and a worker process on the server instead of a ready-made Node server.
- No ERP data offline, and no block-level permissions inside a page.
- A title that does not merge by character.
- Copied platform, theme and shortcut code instead of a shared package, for now.
