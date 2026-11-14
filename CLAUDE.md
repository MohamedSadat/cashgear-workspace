# Cash Gear Workspace

A Notion-style workspace for the Cash Gear ecosystem: block documents, a page tree, databases,
embedded sheets and ERP data, in the browser and as a Tauri desktop app.

Status: Phases 0 to 5 are done (0.5.0: the local-first editor; accounts, sync, sharing, server
search and history; offline, conflicts, migrations and the Mac app; workspace databases and their
views; then Sheet workbooks embedded in pages and read-only ERP blocks); the next step is Phase 6
(collaboration: real-time editing, presence, comments, mentions). Evidence is in
`docs/PROGRESS.md`; spike results and the decisions they changed are in `docs/DECISIONS.md`.

## Workflow

The same rules cashgear-sheet works by.

1. **Read first.** `docs/IMPLEMENTATION_PLAN.md` (the phase you are on), `docs/PROGRESS.md`,
   `docs/DECISIONS.md`. The design is in `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`,
   `docs/SYNC_DESIGN.md` and `docs/INTEGRATIONS.md`.
2. **One phase at a time.** Ask all of the phase's questions in one batch, recommended option
   first. Wait for the answers. Log them with the date in `docs/DECISIONS.md`.
3. **Small choices:** make them and log them under "Defaults picked". **Expensive to reverse:**
   stop and ask.
4. **`main` only.** Commit and push to `main`. No branches, no worktrees, no pull requests. Small
   Conventional Commits scoped by package or crate (`feat(editor): …`, `fix(store): …`,
   `docs: …`). Every commit builds and passes the standing checks.
5. **End of a phase.** Record evidence for each exit criterion in `docs/PROGRESS.md`. Commit,
   push, tag `phase-N`. From Phase 1 also: a `CHANGELOG.md` section, one version bumped
   everywhere, tag `v0.N.0`. Report, then show a card that starts the next phase in a new
   session.
6. **Keep the documents true.** A design that changes is updated in the same phase.

## Hard limits

- Nothing shipped under GPL, AGPL, LGPL, SSPL or BUSL.
- The editor never saves, loads or calls the network. The workspace layer never looks inside a
  document.
- A client never drops document content it does not understand; an older client opens a newer
  document read-only.
- Block ids never change and are never minted in response to a remote change.
- Schema content expressions use `*` only. New attributes are optional with defaults. No node or
  attribute is ever removed or renamed.
- The API process loads no Yjs library.
- No ERP data in a document, a local store or a Workspace table. No ERP API key anywhere.
- No credential in `localStorage`, in a file, or in the repo.
- Nothing is reachable without a session or a share link a person created. Blob containers are
  private.
- Permissions are decided on the server. Hiding a control is never the check.
- Missing generic components are built in `CashGear.React.UI` and used by bumping its pinned
  commit.
- Other repos (`CashGear.React.UI`, `cashgear-sheet`, the ERP) are changed only as an agreed
  track, never as a side effect of work here.

## Layout

What exists. Packages planned for later phases are in `docs/ARCHITECTURE.md`.

| Path | What |
| --- | --- |
| `apps/web` (`@cgw/web`) | Vite + React entry: picks the platform (web or Tauri) and mounts the shell; the service worker (`sw/service-worker.js`, built by a plugin in `vite.config.ts`, registered in production web builds only) so the web app starts offline |
| `packages/shell` (`@cgw/shell`) | App frame (sidebar, top bar, hash routing by page id), i18next catalogues (`en`, `ar`), theme controller, command registry, `event.code` shortcuts, the `WorkspacePlatform` interface |
| `packages/workspace` (`@cgw/workspace`) | Records, `Operation`, `LocalStore` (store schema 4: pins, quarantine, repair state; databases, views, rows, holds) and its conformance suite (`@cgw/workspace/testing`, with an in-memory server for sync tests and `syncHarness.ts`), the operation planner with the tree rules, the remote planners (`remote.ts`), the sync engine (`sync/`: the offline loop, batching, resync, repair, pins, set-aside and recover; Phase 6: `sync/realtime.ts`, `realtime.1`'s types, validators and `HubTransport` with its reconnect loop, no SignalR import, and the engine's live pages, frames and joins), the testing hub (`testing/fakeHub.ts`, with fault injection), order keys, UUIDv7, the metadata mirror, search normalisation; the database rules in `db/` (types, coercion, the conversion table, `queryRows`, the formula language, rollups, `computeRow`, relations, CSV; `db/plan.ts` the planner's database rules); shared test vectors in `vectors/` (`db-*-vectors.json` held to the C# port). No React, DOM or ProseMirror |
| `packages/erp` (`@cgw/erp`) | `erp-connect.1`: the types and a validator for every answer (`contract.ts`), the client, `ErpSessions` (one session per link per tab, in memory only), the pop-up and deep-link connect flows; `./view`: `ErpView`, the link screen and the settings section (React), its own catalogue (`./i18n`). Never stores anything (lint) |
| `packages/database` (`@cgw/database`) | The database views over a `DatabaseHost` (`src/host.ts`, which the shell implements): `DatabaseView` (view tabs, toolbar, filter, sort, group and property editors), the virtualised table, board, list, calendar, gallery (`src/views/`), cells and pickers, `RowProperties`, templates, CSV import and export dialogs, "Export to a workbook", its own catalogue (`src/i18n/`); `@cgw/database/testing` has an in-memory host. Never saves, loads or calls the network (lint) |
| `packages/doc` (`@cgw/doc`) | The block schema (version 2: `tableOfContents`; version 3: `databaseView`, `dateMention`; version 4: `sheetEmbed`, `erpView`; version 5: `userMention`) and its migrations (`migrations.ts`, fixture in `fixtures/`), block-id plugin, the move intent (`moves.ts`), the Yjs seam over the patched `@tiptap/y-tiptap`, `PageDocument` (open, autosave, compaction, history, events), the state hash, recovered content, the read-only view, plain text and Markdown out, Markdown in, content builders; `src/sync-sim/` is the three-client convergence simulator |
| `packages/editor` (`@cgw/editor`) | The Tiptap editor over a `Y.Doc`: block commands, keymap, input rules, slash menu, bubble toolbar, block handle and drag, block selection, clipboard, tables, plain DOM node views, the database, sheet embed and ERP view blocks (one lazy frame, `nodeviews/frame.ts`, that `EditorHost.databases`, `.workbooks` and `.erp` mount into) and dates in the "@" menu; Phase 6: people first in the "@" menu and the `userMention` view, presence cursors (`presence.ts`) and comment anchors (`comments.ts`: `resolveAnchor`, `commentAnchorFor`, "Comment" on Ctrl+Alt+M), both decorations redrawn only when their source or the document changes (`sourced.ts`), over `EditorHost.people`, `.presence`, `.comments`; `src/sheet/`: `sheet-embed.1`'s types and validators (`contract.ts`, vectors in `vectors/sheet-embed-vectors.json`, which Sheet copies) and `SheetEmbed`, the sandboxed iframe and its handshake; given an `EditorHost`, never touches storage |
| `patches/` | The Q18 patch on `@tiptap/y-tiptap` 3.3.0 (`pnpm patch`), made by `scripts/y-tiptap-patch.mjs` |
| `scripts/eslint` | Workspace's own lint rules: `cgw/no-untranslated-text` |
| `apps/desktop` (`@cgw/desktop`, crate `cgw-desktop`) | Tauri 2 shell showing the same page; CSP in `src-tauri/tauri.conf.json`, the Mac's bundle in `tauri.macos.conf.json`; the test-only bridge (`src/bridge.rs`, feature `e2e-bridge`, refused in release builds) |
| `scripts/` | Standing-check runner, licence gate, third-party notices, desktop smoke test, WebView2 setup; the Mac's build, acceptance run and checks (`macos-*.mjs`); the state-hash vectors' generator |
| `tests/e2e` | Playwright specs (Chrome and Edge) |
| `tests/license-gate` | GPL fixtures the licence self-test must reject |
| `packages/store-web` (`@cgw/store-web`) | `LocalStore` on IndexedDB (database `cgw-workspace`, store schema 4, upgraded additively); plans operations inside its own transaction; text search in a MiniSearch worker loaded from it |
| `packages/store-desktop` (`@cgw/store-desktop`) | The desktop's `LocalStore`: binary frames to `crates/cgw-store` over Tauri's `invoke('store')`, or over `cgw-store-cli` in tests; plans against its in-memory mirror |
| `crates/cgw-store` | SQLite store (rusqlite bundled, WAL, FTS5): a fixed set of typed requests in a binary frame, never SQL from the webview; asset files beside the database; a copy of the file before each migration (`workspace.v{n}.db`); `cgw-store-cli` for tests; `tests/fixtures/v1`, `v2`, `v3`: stores written by the released code (`make.mjs [versions]`) |
| `crates/cgw-native` | Desktop helpers without Tauri: `cashgear-workspace://` links read into the app's routes (and `cashgear-workspace://erp#ticket=…&state=…`, the ERP's connect return, into a value that is never a route), file names made safe, the desktop's sign-in (PKCE, the loopback listener, token exchange and refresh) and the keychain (Windows Credential Manager, the macOS login keychain) |
| `crates/cgw-ydoc` | Yjs functions over `yrs` for the server worker (merge, diff, compact, JSON, text, client ranges, validate, the state hash), with a C ABI for .NET; build the DLL with `--profile ffi` |
| `server/` | .NET 10 solution `Cgw.Server.slnx`. `Cgw.Core`: EF Core data (`CgwDb`, the tenant filter, migrations), blob storage with signed URLs, mail, audit, the Databases module (`Databases/`: the C# port of the database rules, the operations, the in-memory query engine, CSV import and export), the Workbooks module (`Workbooks/`: workbooks, their access, versions and pictures, Sheet's `sheet-session.1` routes, xlsx read and written with `DocumentFormat.OpenXml`, ERP links), Phase 6's `Comments/`, `Notifications/` (the worker's mention pass reads them) and `Realtime/RealtimeTickets.cs`, `Documents/PageGate.cs` (one page check for the routes and the hub). `Cgw.Api`: the API process, with `Realtime/` (the hub `realtime.1`: the ticket handler, the `Origin` gate, the registry, the relay, metrics) (ProblemDetails with codes, correlation ids, rate limits, health, Identity, OpenIddict, the sign-in pages, the feature modules). `Cgw.Ydoc`: `cgw-ydoc` by P/Invoke, worker only. `Cgw.Worker`: the jobs. `tests/Cgw.Tests`: xUnit v3 on SQL Server and Azurite. `openapi/v1.json` is written by the build |
| `packages/shell/src/collab` | Phase 6: people (`people.ts`, the editor's `people`), presence (`presence.ts`: others' cursors and this session's selection over the transport; `Avatars.tsx`, Track U7's stand-in, in the top bar and the sidebar; `colour.ts` and `--cgw-presence-1…8`), comments (`comments.ts` per open page, `CommentsPanel.tsx`, `Composer.tsx`, `body.ts`), the inbox (`inbox.ts`, `InboxView.tsx`, `#/inbox`), `Collab` per cloud (`collab.ts`, `context.ts`) |
| `packages/shell/src/sheet`, `packages/shell/src/erp` | Phase 5: the sheet block (picture, live embed, view picker, Open in Cash Gear Sheet, the picture kept for offline), the workbook picker and `#/workbooks`, range import; the ERP block's host (`mountErp`, the links, `ErpSessions` per tab, the `#/erp-link` route) |
| `tests/mocks` | Phase 5: the mock Sheet (`sheet/server.mjs`, port 4283: `/embed`, `/cloud`, an xlsx reader and writer, `/__mock/*`) and the mock ERP (`erp/server.mjs`: API 4282, client 4284, seeded users `alice`, `bob`, `carol`, `dan`, `/__mock/*`); Playwright starts both |
| `tests/contracts/erp` | `erp-connect.1`'s suite: against the mock in `pnpm test`, or a real ERP with `ERP_BASE_URL` and `ERP_TEST_KEY_*` (its README) |
| `packages/shell/src/cloud` | The connection to the API: `cloud.ts` (the typed client, the sync engine wired to the session, account, sharing, versions, search, previews, remote assets, and from Phase 6 the hub), `realtime.ts` (the hub's socket: a ticket per attempt, `@microsoft/signalr` loaded with the first connection), `CloudUi.tsx` (sign-in, devices, sync status, upload, members and invites, the offline menu items), `offline.ts` and `OfflineSettings.tsx` (pins, held pages, storage), `recovery.ts` (recovered pages), `ShareDialog.tsx`, `SharedView.tsx` (a page by link); beside it `notices.ts` (every notice code's text and link) and `RecoveredView.tsx` |
| `deploy/iis` | `install.ps1`: the API on IIS and the worker as a service, from the deploy package (docs/OPERATIONS.md) |
| `packages/api` (`@cgw/api`) | The API client: `schema.ts` generated from `server/openapi/v1.json`, openapi-fetch, cookie with antiforgery header (web) or bearer (desktop) |
| `bench/editor` (`@cgw/bench-editor`) | Phase 0's harnesses on the product packages: S1 fuzz, S2 gate, S3 corpus, browser checklist, budgets, hostile content; S1's rejected schema variants kept for comparison. `app.html`: the whole app over a seeded 10,000-page store, for `bench/phase1.mjs`. `database.html`: the database views over an in-memory host and up to 50,000 generated rows (the URL picks rows, language, theme, view) |
| `bench/ydoc-dotnet`, `bench/sequence-dotnet` | .NET 10 harnesses: `cgw-ydoc` by P/Invoke (S3); 50 writers on SQL Server (S8) |
| `bench/webview2-host` (crate `cgw-webview2-host`) | A WebView2 window on any URL, driven by Playwright over CDP |
| `bench/sheet-embed` | Sheet's deployed app in a sandboxed iframe (S9) |
| `bench/results/` | What runs write; not committed; CI uploads it |
| `.github/workflows/ci.yml` | Licence gates on Ubuntu; build, test, desktop smoke, kill tests, Phase 1 budgets and the Phase 0 harnesses on Windows |
| `.github/workflows/release.yml` | On a `v*` tag: release check, installer test, signed NSIS installer and update, the universal Mac app (signed and notarised once the `APPLE_*` secrets exist), one `latest.json`, a drafted GitHub release |
| `.github/workflows/macos.yml` | On push to `main`: the native crates' tests on macOS, the acceptance run through the test-only bridge (`scripts/macos-acceptance.mjs`), and the release-shaped universal build with its checks |
| `docs/` | Plan, design, decisions, progress |

## Commands

| Command | What |
| --- | --- |
| `pnpm check` | Every standing check below, in CI's order; stops at the first failure (`--no-rust` skips Rust and the server, `--no-server` the server) |
| `pnpm format:check` / `pnpm format` | Prettier |
| `pnpm lint` | ESLint, zero warnings |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest unit tests |
| `pnpm rust:fmt` / `pnpm rust:clippy` / `pnpm rust:test` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` over the workspace |
| `pnpm deny` | `cargo deny check licenses sources` |
| `pnpm licenses:check` / `pnpm licenses:selftest` | npm licence gate, and proof that both gates reject a GPL dependency |
| `pnpm licenses:nuget` | NuGet licence gate over the server's packages |
| `pnpm secrets:check` | No credential in any tracked or unignored file (`scripts/check-secrets.mjs`), and its self-test |
| `pnpm server:build` / `pnpm server:test` | Build the server (writes `server/openapi/v1.json`); its tests on LocalDB, or the server in `CGW_TEST_SQL`, with an Azurite they start (needs `cargo build -p cgw-ydoc --profile ffi`) |
| `pnpm api:generate` / `pnpm api:check` | `@cgw/api`'s types from the OpenAPI document; fail if stale |
| `dotnet ef migrations add <Name> --project server/src/Cgw.Core --startup-project server/src/Cgw.Core --output-dir Data/Migrations` | A migration (`dotnet tool restore` installs `dotnet-ef`) |
| `pnpm build` | Web build and third-party notices |
| `pnpm test:e2e` | Playwright against `pnpm preview` (port 4273) |
| `pnpm desktop:build` / `pnpm desktop:smoke` | Release desktop build (`target/release/cgw-desktop.exe`), then WebView2 smoke over CDP |
| `pnpm desktop:installer` / `pnpm desktop:installer-test` | The signed NSIS installer (after `pnpm build`); install, deep links, update and uninstall of a throwaway test product (about 10 minutes) |
| `pnpm release:check` | One version everywhere and a changelog section for it |
| `pnpm bench:phase1 [-- --desktop]` | Phase 1's budgets, gated against the budgets and `bench/previous/phase1.json` |
| `node scripts/updater-key.mjs` | Made the updater's key once: private half straight into the repo's secrets, public half into `tauri.conf.json`. Refuses to replace it |
| `pnpm dev:web` / `pnpm dev:desktop` | Vite dev server on port 5273; Tauri dev window on it |
| `pnpm dev:server` | The server stack (`scripts/server-stack.mjs`): Azurite, the API on `http://127.0.0.1:5280` and the worker, database `cgw_dev` on LocalDB, mail in `.cgw-dev/mail`. `--e2e` (Playwright starts it, or reuses one already running) uses a fresh `cgw_e2e`, data and mail in `.cgw-dev/e2e` |
| `node scripts/server-publish.mjs` | The deploy package: `target/deploy/cgw-server-<version>.zip` |
| `node scripts/deploy-rehearsal.mjs` | The package installed on a scratch database, smoke-tested, then backed up, restored elsewhere and compared (`bench/results/deploy-rehearsal.json`) |
| `pnpm bench:s3` | S3: Yjs writes a corpus, `cgw-ydoc` processes it from .NET, Yjs checks it (`S3_DOCS`, `S3_BIG_BYTES`) |
| `pnpm bench:webview2-host` then `pnpm bench:browser [-- --s5 --s6 --s7 --chrome --webview2]` | Browser harnesses on port 4290 |
| `pnpm bench:sequence` | S8 on LocalDB (creates and drops `cgw_spike_s8`) |
| `pnpm bench:sheet-embed` | S9 against Sheet's deployed app |
| `cargo build -p cgw-store --bin cgw-store-cli` | The binary the SQLite conformance suite runs through (`pnpm check` builds it; without it the suite is skipped locally) |
| `node scripts/kill-test.mjs --target web|desktop --runs N` | Kill the app while typing, reopen, check nothing saved was lost (web needs `pnpm build`; desktop needs the release build). `--sync`: signed in, against the e2e server stack (started if not running), the network cut in some runs, the server's text checked every `--check-every` runs; `--until-compaction`: each run waits to kill during a compaction; `--kill tree` (the web's default) or `immediate`; failures in full to `<out>.failures.jsonl` |
| `node scripts/kill-migration.mjs --runs N` | Kill the desktop store's migration from the v1 and v2 fixtures at every moment, then check every read against the release's answers and the copy against the old file |
| `node scripts/old-build.mjs [--tag v0.5.0] [--serve]` | The web builds of v0.2.0, v0.3.0, v0.4.0 and v0.5.0 from their tags, each with its own lockfile, into `target/old-build/<tag>` (served on 127.0.0.1:4279, 4278, 4277 and 4276 for `old-build.spec.ts`) |
| `pnpm contract:erp` | The `erp-connect.1` suite (`tests/contracts/erp`) against the mock it starts, or a real ERP (`ERP_BASE_URL`, `ERP_TEST_KEY_FULL`, `_LIMITED`, `_NONE`, `_ADMIN`, `_OTHER`) |
| `node tests/mocks/sheet/server.mjs` / `node tests/mocks/erp/server.mjs` | The mock Sheet (4283) and the mock ERP (4282, 4284) by hand |
| `node scripts/sheet-launcher.mjs` | Real launch tickets for Sheet's `sheet-session.1` suite (127.0.0.1:4285), through real sign-ins against a running stack |
| `pnpm bench:phase3 [-- --desktop]` | Phase 3's budgets (reconnect with 1,000 waiting updates, pinning 500 pages while typing, the store for 1,000 pages, the desktop's cold start offline), gated against the budgets and `bench/previous/phase3.json` |
| `pnpm bench:phase4 [-- --desktop] [--server \| --no-server]` | Phase 4's budgets: first rows of a 50,000-row database (seeded through the import route), scrolling it, a board drag, a cell edit shown, to the next frame and durable (web, and the desktop with `--desktop`); `--server` runs only the server's query budget (`Phase4Bench`), `--no-server` everything else; gated against the budgets and `bench/previous/phase4.json` |
| `node scripts/state-hash-vectors.mjs [--check]` | The state-hash vectors (`packages/doc/vectors/state-hash-vectors.json`), made by plain Yjs; `--check` fails if they are stale |
| `node crates/cgw-store/tests/fixtures/make.mjs` | The SQLite migration fixtures, written by `cgw-store` built from the v0.1.0 and v0.2.0 tags (offline, under `target/store-fixtures`) |
| `SIM_SEEDS=60 SIM_STEPS=200 pnpm exec vitest run packages/doc/src/sync-sim` | The convergence simulator at size (CI runs 4 seeds of 40 rounds); `SIM_SEED` replays one |
| `node scripts/macos-build.mjs` / `node scripts/macos-acceptance.mjs` | On a Mac (the `macos.yml` runner): the universal app, signed when the `APPLE_*` variables are set; the acceptance run through the test-only bridge (`bench/results/macos-acceptance.json`) |
| `S1_OPS=10000 S1_SEEDS=3 S1_COMPARE=1 pnpm exec vitest run bench/editor/src/s1-fuzz.test.ts` | The full S1 fuzz, with the rejected configurations for comparison |
| `DB_VECTORS_WRITE=1 pnpm exec vitest run packages/workspace/src/db/vectors.test.ts` | Rewrites `packages/workspace/vectors/db-*.json` from the hand-written cases in `db/vectors/*.cases.ts` (then Prettier on them); the server's `DatabaseVectorTests` read the same files |
| `PHASE4_BENCH=1 dotnet test -c Release --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.Phase4Bench` | The server's database budgets at 50,000 rows (`PHASE4_ROWS`, `PHASE4_QUERY_RUNS`), to `bench/results/phase4-server.json` |

## Related repos on this machine

| Repo | Path | Role |
| --- | --- | --- |
| Cash Gear Sheet | `D:\CashGear\Projects\cashgear-sheet` | Template for tooling, Tauri shell, CI, docs; embed partner (Track S) |
| Shared UI | `D:\CashGear\Projects\CashGear.React.UI` | `@cashgear/ui`, pinned by commit (Track U) |
| Cash Gear ERP | `D:\CashGear\Projects\CashGear` | UnifiedAPI; connect contract (Track E). Its settings point at a live shared database: read only, run nothing |
| ERP React client | `D:\CashGear\Projects\ERPClient_React` | Where ERP link and connect flows start |

`D:\CashGear\Projects\CashGearUI` is legacy WinForms, not the UI library. The package
`@cashgear/ui` inside `cashgear-archive` is a different package with the same name.

## Gotchas

Added as they are found, grouped by phase.

### Phase 0

- pnpm 12 refuses a release less than a day old and offers to add it to
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Do not keep that entry: pin the previous
  release instead.
- TypeScript stays on 6.0.x: `typescript-eslint` 8.72 supports `typescript <6.1.0`.
- Commands started in the background may have no network (`static.crates.io` does not resolve).
  Run `cargo fetch` in the foreground first, then build in the background with
  `CARGO_NET_OFFLINE=true`.
- A release desktop build takes about five minutes (LTO, one codegen unit).
- In this environment the Bash tool may be refused writes under `.git/objects`; run git from
  PowerShell. Heredocs holding Arabic text or `|` can fail in Bash: write such files with the
  file tool.
- Tiptap's `configure()` copies option objects deeply: an object passed in (a counter, a cache)
  is not the one the extension uses. Pass a function that returns it.
- A transaction appended to a remote Yjs change (`appendTransaction`) never reaches Yjs in either
  binding: they hold a mutex. Dispatch follow-up changes on their own (the id repair does).
- Every Tiptap editor builds its own `Schema`, so `Node.eq` across editors is always false;
  compare JSON.
- `yrs`: asking for a root type (`get_or_insert_*`) while a transaction is open blocks forever;
  `get_string` on XML text renders formatting as tags (read the delta for plain text). Yjs keeps
  its pending update in the v2 encoding (`applyUpdateV2`).
- `Microsoft.Data.SqlClient` refuses invariant globalization, and 7.1.1 brings
  `System.Security.Cryptography.Pkcs` 9.0.18, which has advisories: pin 10.0.15.
- The WebView2 spike host must start on `about:blank`; navigating it while it loads a start URL
  interrupts Playwright's `goto`.

### Phase 1

- Run `cd` only inside `( ... )` in Bash: a plain `cd` moves the session's working directory.
- Tiptap 3.33 runs an input rule after inserting the typed character: the handler sees it in the
  document, and `range.to` includes it.
- `editor.commands.keyboardShortcut` replays a captured transaction through its own mapping and
  drops an insert that follows a delete of the same range. Tests press keys through
  `view.someProp('handleKeyDown')` (`packages/editor/src/testing.ts`).
- A node view must ignore mutations of its own attributes, or setting one (a toggle's open state)
  makes ProseMirror re-read the node and render it again, for ever.
- With `content-visibility: auto` on top-level blocks, Chrome may not have laid out a block made
  a moment ago; a key typed then lands at its start. The editor inserts typed text itself for two
  frames after a structural change (`StableTyping`).
- `useSyncExternalStore` with an inline `subscribe` resubscribes every render; keep it stable when
  the subscription holds state (the bubble toolbar's focus).
- Playwright's `dragTo` does not drive the block handle's HTML5 drag; use `page.mouse` down, move
  in steps, up.
- Every React commit while the editor has focus reads the editor's selection offsets, which walks
  its DOM: about 14 ms at 5,000 blocks. Nothing React-rendered may change per keystroke (the
  bubble toolbar's snapshot is constant while hidden; the save status sets its own text).
- `CgSplitter`'s pane scrolls as a whole and its content box has no height: panes carry
  `cgw-pane` (a column whose content fills it), or the page tree cannot virtualise.
- `CgDrawer`'s closed panel is moved off screen, not hidden: tests check `aria-hidden`.
- A page lazily loaded behind a shortcut loses the keys typed straight after it (the palette
  loads with the frame).
- PowerShell's `Get-Content`/`Set-Content` mangle Arabic too: edit such files with the file tool.
- `.gitignore`'s `bin/` hid `crates/*/src/bin`: scope ignore rules to their folders.
- `tauri signer generate -p` reads a password starting with `-` as a flag: use `--password=`.
- Playwright pages from `connectOverCDP` ignore `baseURL`: the desktop fixture rewrites `goto`.
  Elevated WebView2 hosts (GitHub's runners) take the debugging port only from the policy, so the
  desktop e2e run uses one fixed port (9334).

### Phase 2

- Python on Windows writes CRLF in text mode: open files with `newline='
'` (`.gitattributes`
  fixes commits, but Prettier fails first).
- The build's OpenAPI step runs the API's host (`GetDocument.Insider`), hosted services
  included: anything that reaches SQL or Blob at start skips itself there
  (`StartupTasks.GeneratingDocument`).
- Minimal API `[FromForm]` records fail to bind (`FormDataMappingException`); the pages bind
  `IFormCollection`, which still requires the antiforgery token.
- xUnit v3 on the .NET 10 SDK needs Microsoft.Testing.Platform (root `global.json`) and
  `dotnet test --solution ...`.
- With `InternalsVisibleTo`, two top-level `Program` classes clash in the tests: the worker's
  entry point is `WorkerProgram`.
- OpenIddict 7's application manager takes the store, not a resolver;
  `LoopbackApplicationManager` makes loopback redirect ports not count.
- `127.0.0.1` and `localhost` are different sites for cookies: the web app is served on
  `127.0.0.1`, so the development API is too (`http://127.0.0.1:5280`), or its `SameSite=Lax`
  session cookie is not sent.
- Browsers log every 4xx answer as a console error, which the e2e specs fail on: the app asks
  `GET /api/v1/account/session` (200 signed in or not), never `/account/me`, at start.
- The OpenAPI generator leaves out route parameters no handler binds (the membership filters
  read them): `RouteParameters` (`Cgw.Api/Infrastructure/OpenApiSetup.cs`) declares them.
- Raw SQL bypasses EF's value converters: ids are `binary(16)` in RFC byte order
  (`GuidBytes.ToBytes`); a `Guid` parameter would compare as `uniqueidentifier`.
- EF expression trees cannot hold a collection expression: `IgnoreQueryFilters([CgwDb.Tenant])`
  inside a query is hoisted into a variable first.
- One Windows credential holds at most 2,560 bytes: the keychain splits a long refresh token into
  parts. `keyring` 4 is a wrapper; `keyring-core` with a per-OS store is used directly.
- Desktop tests set `CGW_AUTH_URL_FILE` (the authorise URL goes to a file, not the browser) and
  `CGW_KEYCHAIN_SERVICE` (never the person's own sign-in).
- Minimal API endpoint names (`WithName`) are global and become OpenAPI operation ids:
  `getVersion` is `/version`'s, so a page version is `getPageVersion`.
- EF Core cannot order by a member of a record it projected to; order before the projection.
- `SqlQueryRaw` rows read `binary(16)` ids as `byte[]` (`GuidBytes.FromBytes`).
- The server stack runs the API and worker from a copy of their build output
  (`.cgw-dev/run`, `.cgw-dev/e2e/run`), so a build while it runs is not blocked. Its data is never
  under `test-results/`: Playwright empties that folder when a run starts.
- ASP.NET Core antiforgery with `SecurePolicy=Always` refuses plain http: the dev stack sets
  `Api__AllowHttp` (refused in Production). In-process tests run on https and never see it.
- The antiforgery header wins over the form field: a "no token" test removes the client's
  default `X-CSRF-TOKEN`. `HtmlEncoder.Default` writes Arabic as entities; compare encoded text.
- `MemoryConfigurationSource` throws on a duplicate key. PowerShell unrolls a one-element array
  of arrays.
- Azurite saves its metadata every 5 s and not when killed on Windows: wait out a save before
  copying its folder (the restore drill).

### Phase 3

- `cargo fmt --all` formats every crate, including another session's half-done one: format your
  own with `-p`.
- WKWebView has no debugging protocol for Playwright: the Mac app is driven through the
  test-only bridge (`e2e-bridge`). A LaunchServices start (`open`, a cold deep link, the restart
  after an update) passes no environment, so the bridge build reads `cgw-e2e-settings.json`
  beside the bundle.
- tao 0.37 has no `applicationShouldTerminate`: the macOS menu's stock Quit ended the app without
  the close request that writes pending saves. The app menu's Quit is the app's own item; the
  Dock's Quit, log-out and shut-down still end it at once (DECISIONS.md, Phase 3).
- Clippy for `aarch64-apple-darwin` and `x86_64-apple-darwin` runs on Windows as a check (C
  dependencies need a stand-in compiler); it catches macOS-only lints Windows clippy cannot see.
- `ALTER DATABASE` cannot run in a transaction: its EF migration uses `suppressTransaction: true`.
- The database reads with `READ_COMMITTED_SNAPSHOT`: a read never waits on a writer and sees what
  committed before its statement. A check that must not race a writer takes the lock that writer
  takes (the workspace row, a page's `docseq:` application lock).
- Yjs keeps both pending parts, `pendingStructs` and `pendingDs`, in the V2 encoding: retry both
  with `applyUpdateV2`.
- Replaying a device's own log makes Yjs pick a fresh client id ("another client seems to be
  using it"); `PageDocument.open` puts the session's id back.
- Through the id-aware binding (Q18) a block whose id changes is written as a new element, so two
  devices repairing one duplicate made two copies: the id repair writes to Yjs in place.
- A reader's open of a page must pass `canEdit: false` (as indexing and `pageContent` do), or the
  open migrates the document and writes it.
- `@cgw/doc` runs in browsers and WebViews: no `process` or other Node global outside tests (the
  shell's typecheck catches it).
- `@cgw/workspace`'s `./testing` export is only `conformance.ts`; the simulator in `packages/doc`
  imports the fake server by relative path.
- PowerShell 5.1 mangles double quotes inside a here-string passed to a native program: write a
  commit message to a file and `git commit -F` it. Bash heredocs holding `|` tables can fail too.
- Chrome loses IndexedDB writes it reported committed when only its browser process is ended at
  once; the web kill tests end the whole tree (`--kill tree`), as a crash of the browser does.
- Desktop runs going at once must not share a `CGW_KEYCHAIN_SERVICE`: each rolls the other's
  refresh token and the other comes back signed out. Every harness names its own.

### Phase 4

- The file-writing tool writes `\uXXXX` escapes of space and format characters (U+00A0, U+200B to
  U+200F, U+2028/9, U+202A to U+202E, U+2066 to U+2069, U+FEFF) as the characters themselves: in C#
  a raw U+2028 in a literal breaks the line and does not compile, and invisible ones cannot be
  reviewed. Scan new sources for categories Cc, Cf, Zs, Zl, Zp and write escapes with the edit tool.
- C# ports of the database rules must not use `Trim()` (it also removes U+0085 and keeps U+FEFF),
  `Math.Round` (banker's), `double.ToString()` (not JavaScript's `String(n)`) or `DateTime` for
  years outside 1 to 9999; the vectors name the exact behaviour. A class named `Convert` hides
  `System.Convert` in its namespace. `JsonValue.Create(int).TryGetValue<double>` is false: compare
  JSON as `JsonElement`s.
- Hand-computed float expectations need checking in Node first: `2.675 * 100` is exactly 267.5 in
  doubles, so `round(2.675, 2)` is 2.68. `x` and `y` are checkbox words in CSV inference.
- Set-based writes go through `OPENJSON(@json) WITH (...)` with hex ids
  (`CONVERT(binary(16), x, 2)`): EF's per-entity inserts ran at about 1,000 rows a second.
  `Guid.CreateVersion7()` has no order within one millisecond. EF Core cannot filter on a
  positional record it projected to: filter before `Select`.
- A lazy cache filled after it is assigned breaks under PLINQ: build it, then publish it. Release
  builds' first queries run unoptimised code (tiered JIT): warm up before measuring.
- A refused operation's answer carries its own entity only, while the planner may have changed
  others with it (reverse relations, converted rows, reverse properties): the engine fetches those
  again. A trash of a database page sends every row through the feed, so a test of a refusal on a
  trashed database passes without that: trash the row itself.
- `readMirror` answers gain keys with a schema (Phase 4: `databases`, `views`): a migration test
  comparing an old release's answers exactly must strip them and check they are empty.
- The web build (`tsc --noEmit && vite build`) fails on any package's type error. While other work
  is half done, a release app for the kill tests: `pnpm --filter @cgw/web exec vite build`, then
  `pnpm exec node scripts/third-party-notices.mjs`, then `pnpm --filter @cgw/desktop build`.
- A package's `tsc` includes `@cgw/workspace`'s source, so a half-done file there fails every
  package that imports it: read the errors by path. `pnpm exec prettier --write <folder>` formats
  every file in it: pass the file list.
- Tiptap's `renderText` does not become ProseMirror's `leafText`: set `leafText` through
  `extendNodeSchema`. ProseMirror keeps a child node view when only its block's attributes change,
  so a view that needs its block's id must check it itself.
- `IntersectionObserver` margins work only with the scrolling element as its root. jsdom has no
  `IntersectionObserver` or `Range.getClientRects`, and refuses Node's own `Event` in
  `dispatchEvent` (`packages/database/src/testing/dom.ts` installs jsdom's). Vitest collects only
  `*.test.ts`: component tests use `createElement`, not JSX.
- `CgFlyout` with an element anchor watches the whole document while mounted, even closed: mount
  it only while open. `CgButton appearance="soft"` with no intent draws a nearly invisible label:
  use `ghost` or `outline`, or give it an intent.
- `›` and `‹` are bidi-mirrored characters: in RTL they are drawn the other way already, so never
  flip them with `scaleX(-1)`. Read the drawing direction from `closest('[dir]')`, as the library
  does. `dir="auto"` on a flex container aligns the whole row by its text: put it on the text span.
- Virtualised rows keyed by row id rebuild every row on a scroll jump; keyed by slot they are
  reused, but the row being edited needs a stable key or its uncontrolled editor loses what was
  typed. A synthetic `stopPropagation` stops the native event too.
- The first drag in a fresh Chrome has one frame of about 67 ms with no script, style or layout in
  it: warm up before measuring a drag budget. Playwright drives the board and calendar drags with
  `page.mouse`, as the block handle.
- `pnpm exec` in pnpm 12 first checks the lockfile against the supply-chain policy over the network
  (about a minute here); `npx vitest run …` skips it for quick runs.
- Git's writes into `.git/objects` can be refused for a moment (PowerShell too, with or without the
  sandbox), a different file each time: retry `git add` in a loop; each attempt keeps what it wrote.
- The shell's, the editor's and `@cgw/database`'s stylesheets share the `cgw-` prefix and load at
  once, so a class one styles is styled by the others too: the database package's own are
  `cgw-db-*`, kept so by `packages/database/src/styles.test.ts`.
- `CgFlyout` drops an explicit `width` (its positioned overlay spreads `width: undefined` over
  it), so it is never kept inside the window: pass the width in `style` too. One mounted `open` is
  not reliably focused through `onAfterOpen`: focus its first control a frame after mount
  (`CellFlyout`; both for Track U). React portals bubble synthetic events through the component
  tree: a click in a flyout reaches its owner's `onClick`.
- The server takes a cover or a row's file only once it holds the bytes, so the engine uploads
  assets first in each pass.
- Axe: `aria-owns` does not take a row's children out of it; `aria-controls` must name an element
  that is there; a widget's `aria-label` must hold its visible text (name it by
  `aria-labelledby` and put the action in `aria-description`).
- A reused e2e server stack runs the server it was built with: start it again after server
  changes. A share link shows the worker's derived document, a moment behind the updates: wait for
  `GET /pages/{id}/doc/json` to hold what a spec checks. The sync status is translated: wait for
  `data-state="synced"`, not its text.
- In RTL a scroller's `scrollLeft` runs from 0 to negative values. Calendar day cells are keyed
  `data-day` by days since 1970-01-01 (UTC): place checks by geometry (`onCalendarDay`).
- In a template literal `\s` is `s`: build a `RegExp` from a string with `\\s`. `pnpm install` in
  an old build's tree can fail once with "os error 183" on Windows: run it again.

### Phase 5

- Chrome's Local Network Access refuses to let a page fulfilled by Playwright's `route` frame
  `127.0.0.1` (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`): a parent page for an embed test is
  served by a real local server.
- A minimal API route with `.Accepts(...)` answers a wrong content type with 415 in routing,
  before the handler and outside the route's CORS policy: raw bodies (Sheet's xlsx, the PNG) are
  documented for OpenAPI by `DocumentedBody` metadata instead.
- `DocumentFormat.OpenXml` writes SpreadsheetML with prefixed element names (`<x:workbook>`,
  `<x:c>`): any xlsx reader that meets the server's exports must take prefixes.
- IIS refuses request bodies over 30 MB before the app sees them: the API's `web.config` raises
  the limit to 110 MB, so the API's own 413 (100 MB) answers a save.
- CI's concurrency group cancels the running workflow on `main` when a newer push lands, and a
  re-run of a job with it: push in batches while a run's result matters. `gh run list` has no
  `--commit` filter and there is no `jq` binary: filter with `--json headSha --jq`.
- The ERP's pop-up posts its ticket to `window.opener`: the app must not send
  `Cross-Origin-Opener-Policy: same-origin` or open the pop-up with `noopener`, and the pop-up must
  be opened inside the click. The built-in browser pane opens pop-ups in the same tab, so the
  connect flow is driven by Playwright or Chrome.
- Sheet's own e2e suite and Workspace's both use port 4273 (Sheet's embed parent, Workspace's
  preview): run one at a time.
- The y-tiptap binding keeps no marks on an inline atom (a bold `dateMention` comes back plain).
- While another stream's server work does not build, server tests can run from
  `git archive HEAD server` unpacked under `target/` with your files laid over it.
- On the desktop Playwright config, a test asking for the `context` or `browser` fixture fails
  before its own `test.skip(desktop)` runs: take `page.context()`.
- Yjs stores typed text one keystroke per item, so a byte search of a store for a typed sentence
  finds nothing: a "nothing stored" check searches for whole strings (titles, attributes, the
  mock's values) and proves its search finds a control first.
- A slash-menu click at a long page's foot can miss while the menu moves: choose by keys.
- `GET /workbooks/{id}/previews/{viewHash}` answers 404 for a view with no picture yet, which a
  browser logs as a console error: the specs allow exactly that line.

### Phase 6

- PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and git keeps it at the start of a
  commit subject: write commit messages with the file tool.
- `MapHub` builds its own pipeline with `UseWebSockets()`: middleware before it sees
  `IsWebSocketRequest` false unless `app.UseWebSockets()` runs first. Routing sends
  `/api/v1/realtime/` (trailing slash) to the hub too. The authentication middleware authenticates
  the default (policy) scheme on every request, so the hub's ticket is consumed there, once (the
  result is cached per request). `AuthenticationHandler<T>` has a `Scheme` property: a
  `const string Scheme` in a handler hides it (CS0108).
- Every hub method call has its own DI scope (`TenantScope.Enter` is safe in it; a call spanning
  workspaces uses `Switch`). SignalR's .NET client against `WebApplicationFactory`:
  `SkipNegotiation`, `Transports = WebSockets`, `WebSocketFactory =
  server.CreateWebSocketClient().ConnectAsync`; a refused upgrade throws "Incomplete handshake".
- Server tests run side by side and any of them may run `ValidateJob` over every workspace: a check
  that something has not happened yet must allow another test's worker pass.
- SignalR's JS client rejects pending invocations and then runs `onclose` in the same tick: tell a
  lost connection from a hub error by whether the socket is still the current one. Its ESM build
  `require`s `ws`, `eventsource` and `node-fetch` through a variable inside `Platform.isNode`:
  bundlers leave them out, but `pnpm licenses list --prod` lists them. A browser logs a failed
  WebSocket handshake as a console error itself.
- `createApi` binds `globalThis.fetch` when it is made: a test that swaps `fetch` makes the client
  after. The engine's timers are chains of at most 15 s: test a 30 s interval by advancing the
  clock and counting calls. The testing hub relays a microtask after any change of the fake
  server: tests settle with `hub.flush(engines)`.
- `@tiptap/y-tiptap`'s `absolutePositionToRelativePosition` always sticks to the character before:
  a position that must stick to the one after (a range's start) is made again with
  `Y.createRelativePositionFromTypeIndex(type, index, 0)`. The binding writes a local change to Yjs
  in its view's `update`, after `apply`, so positions cannot be resolved inside `apply` for a local
  structural change. A block moved by the editor is written to Yjs anew and its old items are
  collected: positions in it resolve to null, so anything anchored by them needs a fallback.
- A text body's node view removes every `cgw-` class but its own on update: node decorations on a
  body use `is-…` classes. Top-level blocks' `content-visibility: auto` clips what they paint: an
  overlay inside a block relies on `overflow-clip-margin`. ProseMirror reads a non-editable view's
  selection without focus, but keydown never reaches it.
- jsdom focuses a contenteditable only once it has a `tabIndex`, and has no `DOMRect`. The block
  handle is appended to the editor element's parent's parent: give each test editor its own frame.
  After `installDom()`, `location` and `history` are not globals and a module-level `EventTarget`
  is Node's: tests that navigate or dispatch set them from jsdom's `window` first. Vitest gives
  `import('./x.css?raw')` as an empty string: read a stylesheet with `node:fs`.
- The file tool writes every `\uXXXX` escape as the character, not only space and format ones: use
  `\p{Script=Arabic}` (with `u`) for a script range, or write escapes with the edit tool.
- `packages/database/src/styles.test.ts` reads class names in CSS comments too; `.cgw-avatar` (the
  database's person cell) and `.cgw-check` (a to-do's box) are taken: the shell's avatar is
  `.cgw-face`.
- A schema-N fixture is written by the code before `SCHEMA_VERSION` rises. Playwright's
  `expect.poll` fails at once when its callback throws: poll a route that answers 404 until ready
  with `api.raw`. A Python heredoc in the Bash tool loses one level of backslashes: write such
  scripts with the file tool.
