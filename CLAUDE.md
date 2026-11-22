# Cash Gear Workspace

A Notion-style workspace for the Cash Gear ecosystem: block documents, a page tree, databases,
embedded sheets and ERP data, in the browser and as a Tauri desktop app.

Status: Phases 0 to 13 are done (0.13.0: the local-first editor; accounts, sync, sharing, server
search and history; offline, conflicts, migrations and the Mac app; workspace databases and their
views; Sheet workbooks embedded in pages and read-only ERP blocks; real-time editing, presence,
comments, mentions and the inbox; editable ERP blocks for Vendors, chart and kanban plugin
blocks, and optional AI on the workspace's own Anthropic key; hardening and moving in: the
journal against Chrome's own IndexedDB loss, the server's work per push more than halved, the
library's components (Track U), bulk cell editing, import from Notion, Markdown and Word, and
email for mentions and replies; then publishing and views: a page tree published as a public
site from a process of its own (`pages.cashgearerp.com`), databases' rows on sites and share
links, the timeline view and date windows, and workbooks in the export with their history and
Sheet's desktop app by deep link; then editable Customers and Items on hand, with fields an
item's rows share, search by meaning over Voyage AI's embeddings on the workspace's own key, and
third-party plugins in sandboxed frames from an origin of their own, `plugins.cashgearerp.com`;
then sign-in and permissions: a workspace's groups in every access list, passkeys beside the
password, and single sign-on through a workspace's own OpenID Connect provider for the email
domains it proved by DNS; then databases and ERP at scale: the chart view, timeline bars moved
between lanes, the grid read well by a screen reader, pinned databases holding their rows'
documents through a batch pull, ERP report blocks, and the ERP's queries filtered, sorted and
paged in its database by Tracks E10 and E11; then AI and plugins: a plugin's own network to the
hosts an admin approved, plugins in the change feed, a row's property values by meaning, an
approximate index for a million chunks, a local embedding model on the server, and AI on Cash
Gear's subscription). No phase is planned after Phase 13; what could come next is under "Later"
in `docs/IMPLEMENTATION_PLAN.md`.
Evidence is in `docs/PROGRESS.md`; spike results and the decisions they changed are in
`docs/DECISIONS.md`.

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
| `apps/web` (`@cgw/web`) | Vite + React entry: picks the platform (web or Tauri) and mounts the shell; the service worker (`sw/service-worker.js`, built by a plugin in `vite.config.ts`, registered in production web builds only) so the web app starts offline; Phase 11: `vite.config.ts`'s `ui-core` chunk group (the library's buttons, icons and overlay code with React, which a lazy screen sharing them had split); Phase 12: its text labels, small hooks and field internals too |
| `packages/shell` (`@cgw/shell`) | App frame (sidebar, top bar, hash routing by page id), i18next catalogues (`en`, `ar`), theme controller, command registry, `event.code` shortcuts, the `WorkspacePlatform` interface; Phase 11: `i18n/sections.ts`, sections of the catalogue a screen brings with it (merged into the instance when it first draws, typed in `i18n/index.ts`'s `Sections`, held to the catalogues' rules by `sections.test.ts`), so the initial JavaScript holds none of them |
| `packages/workspace` (`@cgw/workspace`) | Records, `Operation`, `LocalStore` (store schema 4: pins, quarantine, repair state; databases, views, rows, holds) and its conformance suite (`@cgw/workspace/testing`, with an in-memory server for sync tests and `syncHarness.ts`), the operation planner with the tree rules, the remote planners (`remote.ts`), the sync engine (`sync/`: the offline loop, batching, resync, repair, pins, set-aside and recover; Phase 6: `sync/realtime.ts`, `realtime.1`'s types, validators and `HubTransport` with its reconnect loop, no SignalR import, and the engine's live pages, frames and joins), the testing hub (`testing/fakeHub.ts`, with fault injection), order keys, UUIDv7, the metadata mirror, search normalisation; the database rules in `db/` (types, coercion, the conversion table, `queryRows`, the formula language, rollups, `computeRow`, relations, CSV; `db/plan.ts` the planner's database rules); shared test vectors in `vectors/` (`db-*-vectors.json` held to the C# port). No React, DOM or ProseMirror; Phase 9: `queryRows` with the date window (`DateWindow`, `inWindow`), the `timeline` view type, and `sync/http.ts`'s `wirePayload` adding `viewTypes` to every `view.upsert`; Phase 12: `chart`, the seventh view type, with `ViewConfig.chart` (`ChartConfig`, `ChartKind`, `ChartMeasure` in `db/types.ts`; `viewTypes` 7), the batch pull (`sync/api.ts`'s `SyncApi.pullDocs` and `DOCS_PULL_PAGES`, `sync/http.ts`, the in-memory server's `pullDocs`, both held to `sync/pullDocs.test.ts`), and the engine's pins of a database's rows' documents (`PIN_ROW_DOCS`, `pullMany`, the fallback to single pulls, `OfflineProgress.rows`); Phase 13: the feed's `plugin` change turned into the engine's `plugins` event (the fake server's `pluginChanged`) |
| `packages/erp` (`@cgw/erp`) | `erp-connect.1`: the types and a validator for every answer (`contract.ts`), the client, `ErpSessions` (one session per link per tab, in memory only), the pop-up and deep-link connect flows; `./view`: `ErpView`, the link screen and the settings section (React), its own catalogue (`./i18n`). Phase 7: `Commit` and `CommitStatus` with their guards, `drafts.ts` (pending changes per block in memory: review by dry run, commit by `commitId` with `CommitStatus` after a lost answer, conflicts per field, the local checks), the view's editing (`view/editing.tsx`: cells, review and conflict screens; `view/aiPrepare.ts`), `./ai` (`@cgw/erp/ai`: types only, all AI code may import); Phase 10: `scope: 'record' | 'key'` in the contract (`scopeOf`, `sharedByKey`, `keysSharing`), a commit's answer holding every record of a changed key, the drafts' shared fields (`apply`, `adopt`, key-wide revert and resolve), the review's rows the ERP adds, a conflict without fields; Phase 12: report connectors in the contract (`kind`, `ReportParameter`, `total`, `totals`, `labels`, `partial`, `QueryRequest.parameters`, with their guards) and the client's `kinds` (`entity,report` by default), the report block (`view/ReportParameters.tsx`, the totals row and labels in `RecordsTable.tsx`, the picker's Lists and Reports in `ErpView.tsx`, the parameters kept in `settings.ts`), its words loaded with the first ERP block (`i18n/reports.ts`, merged under `erp`). Never stores anything (lint) |
| `packages/plugins` (`@cgw/plugins`) | Plugin blocks (Phase 7): `BlockDefinition`, the registry (`FIRST_PARTY`: chart, kanban), props read and merged so unknown props survive, `./view` (`mountPlugin`, a React root per block, read-only when the block is newer), the chart (over a view's rows; from Phase 12 drawn by `@cgw/database`'s `views/chart/`, its words `database.chart.*`) and the kanban (`@cgw/database`'s board over a view never stored), its own catalogue (`./i18n`); Phase 10: `plugin-frame.1` (`src/frame/`: `contract.ts`, `manifest.ts`, props and rows helpers; vectors `vectors/plugin-frame-vectors.json`), the third-party frame host (`host.ts` the sandboxed iframe and handshake, `ThirdPartyBlock.tsx`, `view.tsx` = `@cgw/plugins/frame-view`, loaded with the first such block) and `@cgw/plugins/frame` (the light contract for the shell, no React); Phase 13: a manifest's `network.hosts` (`manifest.ts`: `isPluginHost`, `isLoopbackHost`, `isCashGearHost`, `host.reserved`; vectors beside the C# `PluginHosts`), an installed plugin's `revision` in the frame's key. Never saves, loads or calls the network (lint) |
| `packages/database` (`@cgw/database`) | The database views over a `DatabaseHost` (`src/host.ts`, which the shell implements): `DatabaseView` (view tabs, toolbar, filter, sort, group and property editors), the virtualised table, board, list, calendar, gallery (`src/views/`), cells and pickers, `RowProperties`, templates, CSV import and export dialogs, "Export to a workbook", its own catalogue (`src/i18n/`); `@cgw/database/testing` has an in-memory host; Phase 8: cell selection (`table/selection.ts`), copy, paste and clear (`table/useCells.ts`, `clipboard/`: TSV and HTML, the paste's planner by the conversion table, `read.ts` for what Excel and Sheet show in the device's locale, paste only, the tab's own copy kept in memory, Undo), the notice with Undo (`table/CellNotice.tsx`), board column order (`group.order`) and gallery card moves. Never saves, loads or calls the network (lint); Phase 9: `views/timeline/` (the timeline over the library's `CgTimeline`, its settings, `timeline.ts`), and a calendar and a timeline reading their own rows by a date window (`ownRows`; `views/calendar/requests.ts`, `useWindowRows.ts`, `Undated.tsx`); Phase 12: `views/chart/` (the chart view, and the chart's arithmetic `aggregate.ts`, drawing `ChartCanvas.tsx`, the only importer of `CgChart`, loaded lazily by `drawing.tsx`, settings controls `ChartControls.tsx`, `config.ts`, words `words.ts` over `i18n/chart-en.ts` and `chart-ar.ts`, merged with the first chart; the chart block draws by them), `ownErrors` in `views/types.ts`, the timeline's bars moved between lanes (Track U19's `moveBetweenLanes`: the lane and dates in one `row.update`), and the table for a screen reader (`table/items.ts`'s `ariaLayout`: a grid, or a tree grid when grouped, its count, indices, levels, places and sizes; the edit announcements; `table/words.ts` over `i18n/grid-*.ts`, merged with the first table) |
| `packages/doc` (`@cgw/doc`) | The block schema (version 2: `tableOfContents`; version 3: `databaseView`, `dateMention`; version 4: `sheetEmbed`, `erpView`; version 5: `userMention`; version 6: `pluginBlock`) and its migrations (`migrations.ts`, fixture in `fixtures/`), block-id plugin, the move intent (`moves.ts`), the Yjs seam over the patched `@tiptap/y-tiptap`, `PageDocument` (open, autosave, compaction, history, events), the state hash, recovered content, the read-only view, plain text and Markdown out, Markdown in, content builders; Phase 8: Markdown in with an import's options (links and images resolved, Notion's HTML, front matter, nesting capped), `xml.ts` (an XML reader: no DTD, depth capped) and `docx.ts` (`readDocx`, the Word reader over the file's XML); `src/sync-sim/` is the three-client convergence simulator; Phase 9: `remapRefs`'s workbooks map and `workbookRefs`; Phase 12: `erpView`'s optional `parameters` (a report's, JSON text; no schema version) |
| `packages/editor` (`@cgw/editor`) | The Tiptap editor over a `Y.Doc`: block commands, keymap, input rules, slash menu, bubble toolbar, block handle and drag, block selection, clipboard, tables, plain DOM node views, the database, sheet embed and ERP view blocks (one lazy frame, `nodeviews/frame.ts`, that `EditorHost.databases`, `.workbooks` and `.erp` mount into) and dates in the "@" menu; Phase 6: people first in the "@" menu and the `userMention` view, presence cursors (`presence.ts`) and comment anchors (`comments.ts`: `resolveAnchor`, `commentAnchorFor`, "Comment" on Ctrl+Alt+M), both decorations redrawn only when their source or the document changes (`sourced.ts`), over `EditorHost.people`, `.presence`, `.comments`; Phase 7: the plugin block's frame (`nodeviews/plugin.ts`, `EditorHost.plugins`; a placeholder naming a type it does not know, the node never changed), `ai.ts` (the selection's text, and an accepted proposal put in as one undoable edit: `insertAiContent`) and "Ask AI" in the bubble toolbar over `EditorHost.ai`; `src/sheet/`: `sheet-embed.1`'s types and validators (`contract.ts`, vectors in `vectors/sheet-embed-vectors.json`, which Sheet copies) and `SheetEmbed`, the sandboxed iframe and its handshake; given an `EditorHost`, never touches storage |
| `patches/` | The Q18 patch on `@tiptap/y-tiptap` 3.3.0 (`pnpm patch`), made by `scripts/y-tiptap-patch.mjs` |
| `scripts/eslint` | Workspace's own lint rules: `cgw/no-untranslated-text` |
| `apps/desktop` (`@cgw/desktop`, crate `cgw-desktop`) | Tauri 2 shell showing the same page; CSP in `src-tauri/tauri.conf.json`, the Mac's bundle in `tauri.macos.conf.json`; the test-only bridge (`src/bridge.rs`, feature `e2e-bridge`, refused in release builds); Phase 9: `src/sheet.rs`, Sheet's desktop app (`CGW_SHEET_APP`, `CGW_OPEN_URL_FILE` for tests) |
| `scripts/` | Standing-check runner, licence gate, third-party notices, desktop smoke test, WebView2 setup; the Mac's build, acceptance run and checks (`macos-*.mjs`); the state-hash vectors' generator; Phase 8's `idb-durability.mjs` (Chrome killed at random while a page writes a counter, relaxed against strict) and `idb-torn-log.mjs` (Chrome's IndexedDB after a torn LevelDB log record, made on purpose; `--app` the app's own store from `idb-torn-app/`, with and without the journal); Phase 11's `web-localhost.mjs` (the app built against the API on `localhost` into `target/web-localhost` and served on `localhost:4268`, for the passkey specs: WebAuthn takes no IP address as its relying party); Phase 13's `local-model.mjs` with `local-model/export.py` and `test-model.py` (the local model's package from the pinned weights, in a Python environment under `target/local-model`; the zip in `target/deploy`) |
| `bench/phase8.mjs` | Phase 8's budgets (a paste of 1,000 cells, a 1,000-page Notion export), with its pieces `phase8-cells.mjs` and `phase8-import.mjs`; `phase8-server.mjs`, the server's CPU per push over real processes, 0.7.0 against this build; `cpu.mjs`, each part's processor time over a bench's window (Phase 5's and 6's keystroke cases) |
| `bench/phase9.mjs` | Phase 9's budgets (a published page of 2,000 blocks from the cache and fresh, the first bars of a 50,000-row timeline and a drag), with its pieces `phase9-site.mjs` and `phase9-timeline.mjs` |
| `bench/phase10.mjs` | Phase 10's budgets: the review of 500 changed customers (`phase10-erp.mjs`), typing between ten plugin frames (`phase10-plugins.mjs`), and the server's retrieval by meaning over 100,000 chunks (`Phase10Bench`, `--server`) |
| `bench/phase11.mjs` | Phase 11's budgets: search, the feed and the tree at 10,000 pages for a member in 20 groups, a sign-in by passkey and through single sign-on (`Phase11Bench`); server only. The CPU per push against 0.10.0 is `bench/phase8-server.mjs`'s Phase 11 flags, taken locally |
| `bench/phase12.mjs` | Phase 12's budgets in Chrome against the e2e stack: a chart view of 50,000 rows by count first drawn (`phase12-chart.mjs`), and pinning a 5,000-row database until every row's document is on the device, the keystroke budget held on another page (`phase12-pins.mjs`); each piece also runs alone. The ERP's first page at 100,000 records is Track E10's own measure |
| `bench/phase13.mjs` | Phase 13's budgets: typing between ten networked plugin frames (`phase10-plugins.mjs --network`), retrieval by meaning over 1,000,000 chunks (`Phase13Bench`, `--server`), the local model's chunk and question (`Phase13LocalModelBench`, `--local-model`, needs the real package; not in CI) |
| `tests/e2e` | Playwright specs (Chrome and Edge); Phase 6's helpers in `collab.ts` (a team by invitation, keys timed on one clock, the hub's frames and switch, comments); Phase 9's `site.spec.ts` (the site's origin `localhost:5290`), `timeline.spec.ts`, `workbook-history.spec.ts`, `export-workbooks.spec.ts`, `desktop-sheet.spec.ts` (its own launcher with the Sheet test settings); Phase 10's `erp-phase10.spec.ts`, `meaning.spec.ts`, `plugins-frame.spec.ts` (the hostile plugin) with helpers `erp10.ts`, `meaning.ts`, `plugins.ts`; `tests/fixtures/plugins` (a reference and a hostile plugin, zipped by `make.mjs`); Phase 11's `groups.spec.ts` with helpers `groups.ts` (the one picker, Settings' groups, the scene for the accessibility and Arabic walks), `passkeys.spec.ts` (Chrome's and Edge's virtual authenticator over CDP, against `scripts/web-localhost.mjs`'s build on `localhost:4268`; Settings' passkeys under Axe and in Arabic there), `sso.spec.ts` (the mock provider on 4287), and `old-build.spec.ts`'s v0.10.0 case (a group's row kept); Phase 12's `chart-view.spec.ts` with helpers `chart.ts` (the app, a share link, a site; its seed is `bench/phase12-chart.mjs`'s), `old-build.spec.ts`'s v0.10.0 and v0.8.0 cases editing a chart view as a table, `grid-a11y.spec.ts` with helpers `grid.ts` (Chromium's own tree read from `chrome://accessibility` and `edge://accessibility`, the browser launched with `--force-renderer-accessibility`; browsers only; the grid's scene for the Axe and Arabic walks), `offline.spec.ts`'s pinned database whose every row's page opens offline, and `erp-reports.spec.ts` with helpers `erp12.ts` (the scene and screens, `englishIn`, an English check inside a block); Phase 13's `plugins-network.spec.ts` (the networked plugin `tests/fixtures/plugins/network`, "Ping", against the mock host `tests/mocks/net`, port 4288; and a plugin's changes reaching an open tab), `ai-plan.spec.ts` (the subscription and the local model's stand-in on the e2e stack), `plan.ts` (the scene and screens of the Axe and Arabic walks) |
| `tests/license-gate` | GPL fixtures the licence self-test must reject |
| `tests/fixtures/local-model` | Phase 13: the local model's stand-in package (`test: true`): the real graph's inputs and output over a byte-level vocabulary, so CI and the e2e stack run the same ONNX Runtime and tokenizer code |
| `packages/store-web` (`@cgw/store-web`) | `LocalStore` on IndexedDB (database `cgw-workspace`, store schema 4, upgraded additively); plans operations inside its own transaction; text search in a MiniSearch worker loaded from it; Phase 8: what the device made written with strict durability, and its document updates journalled in the Origin Private File System (`journal/`: `format.ts` the records, `core.ts`, `client.ts`, `journal.worker.ts`, `fakeOpfs.ts` for tests) |
| `packages/store-desktop` (`@cgw/store-desktop`) | The desktop's `LocalStore`: binary frames to `crates/cgw-store` over Tauri's `invoke('store')`, or over `cgw-store-cli` in tests; plans against its in-memory mirror |
| `crates/cgw-store` | SQLite store (rusqlite bundled, WAL, FTS5): a fixed set of typed requests in a binary frame, never SQL from the webview; asset files beside the database; a copy of the file before each migration (`workspace.v{n}.db`); `cgw-store-cli` for tests; `tests/fixtures/v1`, `v2`, `v3`: stores written by the released code (`make.mjs [versions]`) |
| `crates/cgw-native` | Desktop helpers without Tauri: `cashgear-workspace://` links read into the app's routes (and `cashgear-workspace://erp#ticket=…&state=…`, the ERP's connect return, into a value that is never a route), file names made safe, the desktop's sign-in (PKCE, the loopback listener, token exchange and refresh) and the keychain (Windows Credential Manager, the macOS login keychain); Phase 9: Cash Gear Sheet's desktop app (`sheet.rs`: whether anything handles `cashgear-sheet`, its launch link read again and handed to the system; raw FFI, no crate) |
| `crates/cgw-ydoc` | Yjs functions over `yrs` for the server worker (merge, diff, compact, JSON, text, client ranges, validate, the state hash), with a C ABI for .NET; from Phase 8 a state loaded once (`Loaded`, `cgw_doc_*`: meta, tree check, state hash, JSON, text), which the validation pass and derive read; build the DLL with `--profile ffi` |
| `server/` | .NET 10 solution `Cgw.Server.slnx`. `Cgw.Core`: EF Core data (`CgwDb`, the tenant filter, migrations), blob storage with signed URLs, mail, audit, the Databases module (`Databases/`: the C# port of the database rules, the operations, the in-memory query engine, CSV import and export), the Workbooks module (`Workbooks/`: workbooks, their access, versions and pictures, Sheet's `sheet-session.1` routes, xlsx read and written with `DocumentFormat.OpenXml`, ERP links), Phase 6's `Comments/`, `Notifications/` (the worker's mention pass reads them) and `Realtime/RealtimeTickets.cs`, `Documents/PageGate.cs` (one page check for the routes and the hub); Phase 7's `Ai/` (`AiService`, the key under Data Protection, `AiRequestBuilder` the one place a request is built, `AnthropicProvider` over Anthropic's C# SDK, metering in `AiUsage`, audit) and `Workbooks/ErpCommits.cs` (the `erp-commits` audit route); Phase 8's `Notifications/NotificationMail.cs` (mail settings, unsubscribe tokens, the mail's words), `Cgw.Api/Identity/MailEndpoints.cs` and the worker's `Jobs/MailJobs.cs` (`notificationMail`, `mailSend`), the push's path in raw SQL (`DocService`, `PageGate`, `RealtimeRelay`, `DocJobs`). `Cgw.Api`: `Modules/AiEndpoints.cs` (NDJSON); the API process, with `Realtime/` (the hub `realtime.1`: the ticket handler, the `Origin` gate, the registry, the relay, metrics) (ProblemDetails with codes, correlation ids, rate limits, health, Identity, OpenIddict, the sign-in pages, the feature modules). `Cgw.Ydoc`: `cgw-ydoc` by P/Invoke, worker only. `Cgw.Worker`: the jobs. `tests/Cgw.Tests`: xUnit v3 on SQL Server and Azurite (`Phase8Bench`: the server's CPU per push in process, `PHASE8_BENCH=1`). `openapi/v1.json` is written by the build. Phase 9: `Cgw.Core/Sites/` (`PublishingService`: the site records, the switch, the audit; `SiteReader` and `SiteCache`: what the Sites process reads and holds; `SiteRenderer`, `SiteDatabaseHtml`, `SiteHtml`, `SiteWords`, `SiteStyle`: a page as HTML) and `Sharing/SharedDatabases.cs` (a database read without an account, through its view); `Cgw.Sites`: the Sites process (below). Phase 10: `Cgw.Core/Ai/Embeddings.cs` (`IEmbeddingProvider`, `VoyageProvider` over HttpClient, the chunker `EmbeddingText`, `VectorMath`), `Ai/EmbeddingsService.cs` (settings and the off switch), `Search/MeaningSearch.cs` (`EmbeddingsCache`, the API's copies; `MeaningSearch`, the route and `ask`'s pages), `Plugins/` (`PluginBundle` the hostile-archive reader, `PluginService` and its tickets, `PluginFiles` the Sites process's reads), `Cgw.Api/Modules/PluginEndpoints.cs` (search by meaning and the plugin routes), the worker's `Jobs/EmbedJobs.cs` (`embed`, the clean-up), `Phase10Bench` (`PHASE10_BENCH=1`). Phase 11: `Cgw.Core/Workspaces/GroupService.cs` (a workspace's groups and their people, `LeaveAllAsync`), groups in `Access.cs` (one rule, `Access.Speaks`, in every copy; `RowsFor` reads a caller's groups with their rows), `Cgw.Api/Modules/GroupEndpoints.cs`; `Cgw.Api/Identity/Passkeys.cs` (`PasskeySetup` the relying party, origins and state cookie; the ceremonies through Identity's `SignInManager`, one-use challenges in `PasskeyChallenges`, the 20 limit, the account's passkey routes), `Identity/passkey.js` (the account pages' one script, embedded, served as `/account/passkey.js` with its integrity), `AccountService.SignInSessionAsync` (every browser sign-in's device path, `auth_time` and `amr`); `Identity/Sso.cs` (`SsoOptions`, domains as kept, the client secret under Data Protection, `ISsoDns` over DnsClient or the mock's stand-in `Sso__DnsBaseUrl`, discovery and keys through IdentityModel's `ConfigurationManager` (`SsoMetadata`), `SsoPolicy` the required check), `SsoSettings.cs` (owners' domains and provider), `SsoSignIn.cs` (the code flow: state cookie, token exchange, the id token checked, the account linked or made, the join, the session's end on `Devices.EndsAt`), `Modules/SsoEndpoints.cs`; tests `AccessOracleTests.cs` (every path against a reference of the rule over random workspaces), `GroupTests.cs`, `SoftwareAuthenticator.cs` (WebAuthn in software: ES256, attestation none; `PasskeyFlow` the pages' steps), `PasskeyTests.cs`, `SsoKit.cs` (the mock provider's controls, a sign-in as a browser makes it), `SsoTests.cs`, `Phase11Bench` (`PHASE11_BENCH=1`). Phase 12: `Databases/DatabaseOps.cs`'s `ConfigKeysByTypes` and `KnownViewTypes` (an older build's `viewTypes` read as a count), `Sharing/ChartViews.cs` (`ChartView.Shown`, `Read`, `Hides`: what a chart view shows on a share link and a site, `chart.hidden`), `Sites/SiteDatabaseHtml.cs`'s one chart drawing for the block and the view, `Documents/DocPulls.cs` (the batch pull; `PageGate.OpenInAsync`, a row's level once a database a request), `Cgw.Api/Infrastructure/Http.cs`'s `pull` rate limit; tests `ChartViewTests.cs`, `DocsPullTests.cs`. Phase 13: `Plugins/PluginHosts.cs` (a manifest's hosts, the approved ones reached, the CSP's `connect-src`), `PluginService`'s approvals and `plugin` changes in the feed, `PluginFiles`' CSP per bundle; `Ai/EmbeddingValues.cs` (a row's property values as "Name: value" lines, never a person's), `PageEmbeddings.SchemaVersion`; the approximate index in `Search/MeaningSearch.cs`'s `EmbeddingsCache` (sign bits, `VectorMath.SignBits`, `Hamming`), `Ai/LocalModelOptions.cs` (the pinned package hashes, `Ai__LocalModel__*`); `Ai/AiSubscription.cs` (`KeySources`, `AiSubscriptionOptions` from `Ai__Subscription__*`, `AiAllowance` with `AiReservations`); tests `PluginNetworkTests.cs`, `PropertyValueEmbeddingTests.cs`, `ApproximateIndexTests.cs`, `LocalModelTests.cs`, `SubscriptionTests.cs`, `VectorKit.cs` (clustered int8 vectors seeded by `SqlBulkCopy`), `Phase13Bench` (`PHASE13_BENCH=1`), `Phase13LocalModelBench` (`PHASE13_LOCAL_BENCH=1`, `CGW_LOCAL_MODEL`). Phase 14: `Databases/RowFiles.cs` and `DatabaseRowFiles` (a row's files indexed with its values; the worker's `Jobs/RowFilesFillJob.cs` fills it once, `rowFilesFill:done`), `Domains/DomainDns.cs` (`IDomainDns`, `DomainNames`: Phase 11's DNS reader moved into the core for the worker too, `TXT` and addresses), `Sites/SiteDomains.cs` (`SiteHosts`, `SiteDomainService`: a workspace's host names, proven by DNS), `Sites/Acme.cs` (`AcmeClient`, the server's own ACME client), `Sites/SiteCertificates.cs` (`SiteCertificateOptions` from `Sites__Acme__*` and `Sites__Certificate*`), `PublishingService.SetDomainAsync`, `site` and `publishing` changes in the feed (`SiteRules.SiteChange`, `PublishingChange`), the worker's `Jobs/SiteCertificateJob.cs` (certificates into IIS's Centralized Certificate Store, renewal, the proof read again); tests `RowFileTests.cs`, `SiteLimitTests.cs`, `SiteDomainTests.cs` (the mock ACME server per test, a bridge from a real port to the Sites test server) |
| `server/src/Cgw.LocalModel` | Phase 13: the local embedding model, referenced by the API and the worker only: `LocalEmbeddingProvider` (`voyage-4-nano` on ONNX Runtime on the processor, one run at a time a process, loaded on first use and unloaded when idle, the package checked against `cgw-model.json` and the pinned hashes, never a test package in Production; `Int8`), `QwenTokenizer` (Qwen2's byte-level BPE, the split over code points), `EmbeddingRouter` (`voyage-4-nano` here, every other model to Voyage; `AddLocalModel`) |
| `server/src/Cgw.Sites` | Phase 9: the Sites process (`SitesProgram`): published pages on their own origin (`http://localhost:5290` in development), no sign-in code, no cookies, no script, no Yjs library; reads SQL and Blob only. Phase 10: a second host, the plugins origin (`http://localhost:5291` in development), `GET`/`HEAD /f/{ticket}/{*path}` only, frame tickets found by their hash; no Data Protection, and its installed identity is denied the key ring's table. Phase 14: a rate limit of its own (`SiteLimits.cs`: 300 pages and files a minute an address, the plugins host 1,200, an IPv6 address by its /64), and any host name but its own (`Sites__PublicUrl`) and the plugins' a site's own (`UseSiteDomains`: the site from `/`, ACME's HTTP-01 answers, the slug's addresses redirected there) |
| `packages/shell/src/collab` | Phase 6: people (`people.ts`, the editor's `people`), presence (`presence.ts`: others' cursors and this session's selection over the transport; `Avatars.tsx`, Track U7's stand-in, in the top bar and the sidebar; `colour.ts` and `--cgw-presence-1…8`), comments (`comments.ts` per open page, `CommentsPanel.tsx`, `Composer.tsx`, `body.ts`), the inbox (`inbox.ts`, `InboxView.tsx`, `#/inbox`), `Collab` per cloud (`collab.ts`, `context.ts`) |
| `packages/shell/src/sheet`, `packages/shell/src/erp` | Phase 5: the sheet block (picture, live embed, view picker, Open in Cash Gear Sheet, the picture kept for offline), the workbook picker and `#/workbooks`, range import; the ERP block's host (`mountErp`, the links, `ErpSessions` per tab, the `#/erp-link` route); Phase 7: the tab's drafts and the commit audit (`services.ts`), `leave.tsx` (the warning before leaving ERP changes not committed: the router's `setLeaveGuard`, `beforeunload`, the desktop's `onCloseAsk`); Phase 9: a workbook's history (`sheet/WorkbookHistory.tsx`) and Sheet's desktop app by its deep link (`sheet/launch.ts` over `WorkspacePlatform.sheetApp`); Phase 12: `erp/mount.tsx` passes a report block's `parameters` through |
| `packages/shell/src/ai`, `packages/shell/src/plugins` | Phase 7: AI in the client: the API's AI routes (`api.ts`, NDJSON `events.ts`), settings and availability per tab (`store.ts`, `context.ts`), each action's request (`requests.ts`), the run (`run.ts`), strict JSON answers (`answers.ts`), Accept (`accept.ts`, `database.ts`), `AiPanel.tsx`, `AiSettings.tsx`, the ERP assist (`erpAssist.ts`, the only AI path into an ERP block: proposals for its pending list), its catalogue (`i18n.ts`); imports nothing of `@cgw/erp` but `@cgw/erp/ai` (lint, `boundary.test.ts`). The plugin blocks' host (`plugins/host.ts`: the database host, the linked-view picker, `@cgw/plugins/view` loaded lazily); Phase 10: search by meaning in `AiSettings.tsx` (switch, Voyage AI key, model, use, progress) and the palette (`search/meaning.ts`, "Related by meaning"); third-party plugins (`plugins/`: `api.ts` the routes, `store.ts` the workspace's list, `services.ts` a source per block and frame tickets, `commands.ts` slash entries, `bundle.ts` the bundle read on the device, `PluginsSettings.tsx` Settings → Plugins); Phase 13: a plugin's hosts in Settings → Plugins (`networkWords.ts`, section `pluginNetwork`: the review's hosts, Allow hosts, Stop network), the list read again on the engine's `plugins` event; Settings → AI's key source and Cash Gear's subscription with the month's use, search by meaning on this server (`AiSettings.tsx`, read again when Settings opens and every 5 s while pages wait), the allowance's refusal in the panel (`planWords.ts`, section `aiPlan`) |
| `tests/mocks` | Phase 5: the mock Sheet (`sheet/server.mjs`, port 4283: `/embed`, `/cloud`, an xlsx reader and writer, `/__mock/*`) and the mock ERP (`erp/server.mjs`: API 4282, client 4284, seeded users `alice`, `bob`, `carol`, `dan`, `/__mock/*`; Phase 7: Commit and CommitStatus for Vendors, `gina` with Edit and `faris` with AdvEdit, `V-1005` locked, `/__mock/edit-record`, `/__mock/audit`); Phase 7's mock AI provider (`ai/server.mjs`, port 4286: Anthropic's streamed Messages API, the key kept only as a hash, `/__mock/requests`, `/script`, `/fault`; the server's tests start it; Phase 10: also Voyage's `POST /v1/embeddings` from a concept lexicon in English and Arabic, `ai/embeddings.mjs`, `/__mock/embeddings`); Phase 10: the mock ERP's Customers and Items on hand as the real connectors with Track E8's editing (gina Customers' Edit, faris Customers' AdvEdit and Items' Edit; `edit-record {id}`, `reset {kitCustomers}`); Playwright starts all three; Phase 11: the mock OpenID Connect provider (`oidc/server.mjs`, port 4287: discovery, `/authorize` with PKCE S256 and a sign-in page of seeded people, `/token` by `client_secret_post` or `_basic`, `/jwks` with `rsa-1` and `ec-1` made at start in memory, `/userinfo`; `/__mock/clients`, `next`, `fault`, `clock`, `requests` (secrets as hashes), `state`, `reset`, and `dns`, the DNS stand-in `Sso__DnsBaseUrl` asks; every route also under `/realms/<name>`, a provider of its own per test), which Playwright and the server's tests start too; Phase 12: the mock ERP's queries by 0.10.0's rules (`erp/rules.mjs`), a keyset cursor that counts what it read and `maxRecords` enforced, the large seed (`erp/large.mjs` with `large.d.mts`: 100,000 records a connector for Kit by one rule, `--large` or `reset {large: true}`), the three reports (`erp/reports.mjs`: seeded ledgers, listed only with `Connectors?kinds=`; users' report roles in `seed.mjs`), and the controls `cursor`, `add-record` and `report-limits`; Phase 14: the mock ACME server (`acme/server.mjs` with `der.mjs`, port 4289: RFC 8555's directory, nonces, JWS checked, orders, HTTP-01 fetched from `--challenge-port` at `--resolve` with the name in `Host`, certificates signed by a CA made in memory; `/__mock/state`, `reset`, `fault`, `lifetime`, `challenge`, `ca`), which Playwright starts on 5290's challenges and the server's tests start per test; the DNS stand-in's `addresses` beside `txt` |
| `tests/contracts/erp` | `erp-connect.1`'s suite: against the mock in `pnpm test`, or a real ERP with `ERP_BASE_URL` and `ERP_TEST_KEY_*` (its README); `commit.test.ts`: Phase 7's Commit and CommitStatus (`ERP_TEST_KEY_EDIT`, `_ADVEDIT`), and Phase 10's for Customers and Items on hand (Track E9 runs them against UnifiedAPI); Phase 12: `rules.ts` (the suite's own reading of 0.10.0's search, `equals` and sort, and `reference()`), `scale.test.ts` (Track E10's 20 cases at 100,000 records a connector; `ERP_TEST_KEY_SCALE` and `_SCALE_ADMIN`, else skipped), `reports.test.ts` (Track E11's 41), the README's large seed and the reports' readings |
| `packages/shell/src/cloud` | The connection to the API: `cloud.ts` (the typed client, the sync engine wired to the session, account, sharing, versions, search, previews, remote assets, and from Phase 6 the hub), `realtime.ts` (the hub's socket: a ticket per attempt, `@microsoft/signalr` loaded with the first connection), `CloudUi.tsx` (sign-in, devices, sync status, upload, members and invites, the offline menu items), `offline.ts` and `OfflineSettings.tsx` (pins, held pages, storage), `recovery.ts` (recovered pages), `ShareDialog.tsx`, `SharedView.tsx` (a page by link), `MailSettings.tsx` (Phase 8: the account's mail choice); beside it `notices.ts` (every notice code's text and link; from Phase 8 an `access.denied` operation named by what was refused) and `RecoveredView.tsx`; Phase 9: publishing (`publishing.ts` the routes, the slug's rules and proposal; `PublishSection.tsx`, the share dialog's "Publish to the web"; `PublishingSettings.tsx`, the workspace's switch and live sites; `publish.css`) and a share link's databases (`sharedDatabase.ts`, a read-only `DatabaseHost` over the link's routes, which `SharedView.tsx` gives database blocks, chart and board blocks and a database's own page); Phase 11: groups (`GroupsSettings.tsx`, Settings → Members → Groups, at the end of `MembersSettings`; `principals.tsx`, the access lists' rows and the one picker of the workspace, groups and people, `CgComboBox`, used by `ShareDialog.tsx` and `sheet/WorkbookPermissions.tsx`; `groupsWords.ts`, `groups.css`), `cloud.ts`'s group routes, `knowsGroups`, and the permissions read and saved with `principals`; the account's passkeys (`passkeys.ts`, the routes and the API's page that adds one: this tab on the web, back to Settings; the system browser on the desktop; `PasskeysSettings.tsx` through `AccountSettings`'s `passkeys` prop, `passkeysWords.ts`, `passkeys.css`); Phase 12: `offlineWords.ts` (the `offlineRows` section: Settings → Offline's line for a pinned database's row pages) and `sharedChart.test.ts` (a chart view on a share link) |
| `packages/shell/src/exchange` | Export and import of a workspace (`exchange.ts`, `zip.worker.ts`, `DataPanel.tsx`); Phase 8's `import/`: Markdown, Notion and Word on the device (`archive.ts` the hostile-archive guards and zip names, `assets.ts` files typed as the server sniffs them, `notion.ts`, `tree.ts` the page tree and Notion's databases and relations, `word.ts`, `plan.ts` everything planned in `import.worker.ts`, `write.ts` written in order and removed whole on a failure or Stop, `run.ts`, `ImportPanel.tsx`); `fixtures/fixtures.ts`, the import fixtures made by code; Phase 9: export format 3 with workbooks (`workbooks.ts`: read from the account for an export, made again in it by an import) |
| `tests/fixtures/import` | `make.mjs`: writes the import fixtures to a folder |
| `deploy/iis` | `install.ps1`: the API on IIS and the worker as a service, from the deploy package (docs/OPERATIONS.md); from Phase 9 also the Sites process as a third IIS site (`CashGearWorkspaceSites`, `-SitesHostName`); Phase 10: its second binding, the plugins origin (`-PluginsHostName`), and its identity denied `DataProtectionKeys`; Phase 13: `-LocalModel` (the model's zip unpacked to `<Root>\models\voyage-4-nano`), `-LocalModelThreads`, the subscription's allowances (`-AiMonthlyTokens`, `-AiEmbeddingsMonthlyTokens`, per workspace) and its keys from `CGW_AI_ANTHROPIC_KEY`, `CGW_AI_VOYAGE_KEY` in the session |
| `packages/api` (`@cgw/api`) | The API client: `schema.ts` generated from `server/openapi/v1.json`, openapi-fetch, cookie with antiforgery header (web) or bearer (desktop) |
| `bench/editor` (`@cgw/bench-editor`) | Phase 0's harnesses on the product packages: S1 fuzz, S2 gate, S3 corpus, browser checklist, budgets, hostile content; S1's rejected schema variants kept for comparison. `app.html`: the whole app over a seeded 10,000-page store, for `bench/phase1.mjs`. `database.html`: the database views over an in-memory host and up to 50,000 generated rows (the URL picks rows, language, theme, view) |
| `bench/ydoc-dotnet`, `bench/sequence-dotnet` | .NET 10 harnesses: `cgw-ydoc` by P/Invoke (S3); 50 writers on SQL Server (S8) |
| `bench/webview2-host` (crate `cgw-webview2-host`) | A WebView2 window on any URL, driven by Playwright over CDP |
| `bench/sheet-embed` | Sheet's deployed app in a sandboxed iframe (S9) |
| `bench/results/` | What runs write; not committed; CI uploads it |
| `.github/workflows/ci.yml` | Licence gates on Ubuntu; build, test, desktop smoke, kill tests, Phase 1 budgets and the Phase 0 harnesses on Windows |
| `.github/workflows/release.yml` | On a `v*` tag: release check, installer test, signed NSIS installer and update, the universal Mac app (signed and notarised once the `APPLE_*` secrets exist), one `latest.json`, a drafted GitHub release |
| `.github/workflows/macos.yml` | On push to `main`: the native crates' tests on macOS, the acceptance run through the test-only bridge (`scripts/macos-acceptance.mjs`), and the release-shaped universal build with its checks |
| `docs/` | Plan, design, decisions, progress; Phase 12's `SCREEN_READERS.md` (the database grid's script by hand for NVDA, Narrator and VoiceOver: the keys and what each must say) |

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
| `pnpm dev:server` | The server stack (`scripts/server-stack.mjs`): Azurite, the API on `http://127.0.0.1:5280`, the worker and (Phase 9) the Sites process on `http://localhost:5290`, database `cgw_dev` on LocalDB, mail in `.cgw-dev/mail`; (Phase 10) the plugins host on `http://localhost:5291` and the API's Voyage base at the mock AI provider. `--e2e` (Playwright starts it, or reuses one already running) uses a fresh `cgw_e2e`, data and mail in `.cgw-dev/e2e`, maps the hub's metrics route, and opens a control port on 127.0.0.1:5289 (`scripts/stack-control.mjs`: `POST /api/restart` ends the API and starts it again) |
| `node scripts/server-publish.mjs` | The deploy package: `target/deploy/cgw-server-<version>.zip` |
| `node scripts/deploy-rehearsal.mjs` | The package installed on a scratch database, smoke-tested, then backed up, restored elsewhere and compared (`bench/results/deploy-rehearsal.json`) |
| `pnpm bench:s3` | S3: Yjs writes a corpus, `cgw-ydoc` processes it from .NET, Yjs checks it (`S3_DOCS`, `S3_BIG_BYTES`) |
| `pnpm bench:webview2-host` then `pnpm bench:browser [-- --s5 --s6 --s7 --chrome --webview2]` | Browser harnesses on port 4290 |
| `pnpm bench:sequence` | S8 on LocalDB (creates and drops `cgw_spike_s8`) |
| `pnpm bench:sheet-embed` | S9 against Sheet's deployed app |
| `cargo build -p cgw-store --bin cgw-store-cli` | The binary the SQLite conformance suite runs through (`pnpm check` builds it; without it the suite is skipped locally) |
| `node scripts/kill-test.mjs --target web|desktop --runs N` | Kill the app while typing, reopen, check nothing saved was lost (web needs `pnpm build`; desktop needs the release build). `--sync`: signed in, against the e2e server stack (started if not running), the network cut in some runs, the server's text checked every `--check-every` runs; `--until-compaction`: each run waits to kill during a compaction; `--kill tree` (the web's default) or `immediate`; failures in full to `<out>.failures.jsonl`; `--stuck-minutes` (5): a run with no progress that long ends the app and fails saying where it stopped |
| `node scripts/kill-migration.mjs --runs N` | Kill the desktop store's migration from the v1 and v2 fixtures at every moment, then check every read against the release's answers and the copy against the old file |
| `node scripts/old-build.mjs [--tag v0.8.0] [--serve]` | The web builds of v0.2.0 to v0.9.0 from their tags, each with its own lockfile, into `target/old-build/<tag>` (served on 127.0.0.1:4279, 4278, 4277, 4276, 4275, 4274, 4272, (v0.9.0) 4271 and (v0.10.0) 4270 for `old-build.spec.ts`; 4273 is this build's preview) |
| `pnpm contract:erp` | The `erp-connect.1` suite (`tests/contracts/erp`) against the mock it starts, or a real ERP (`ERP_BASE_URL`, `ERP_TEST_KEY_FULL`, `_LIMITED`, `_NONE`, `_ADMIN`, `_OTHER`, `_EDIT`, `_ADVEDIT`; Phase 12: `_SCALE` and `_SCALE_ADMIN` for `scale.test.ts`, a company holding only the large seed) |
| `node tests/mocks/sheet/server.mjs` / `node tests/mocks/erp/server.mjs` / `node tests/mocks/ai/server.mjs` / `node tests/mocks/oidc/server.mjs` | The mock Sheet (4283), the mock ERP (4282, 4284), the mock AI provider (4286) and (Phase 11) the mock OpenID Connect provider (4287) by hand. Phase 12: the mock ERP's `--large` seeds Kit with 100,000 records a connector (`tests/mocks/erp/large.mjs`); `POST /__mock/reset {"large": true}` does the same while it runs |
| `ANTHROPIC_API_KEY=… dotnet test --solution server/Cgw.Server.slnx -- --filter-method "*A_real_completion*"` | One small real completion through the provider; nothing else ever calls it |
| `node scripts/sheet-launcher.mjs` | Real launch tickets for Sheet's `sheet-session.1` suite (127.0.0.1:4285), through real sign-ins against a running stack |
| `pnpm bench:phase3 [-- --desktop]` | Phase 3's budgets (reconnect with 1,000 waiting updates, pinning 500 pages while typing, the store for 1,000 pages, the desktop's cold start offline), gated against the budgets and `bench/previous/phase3.json` |
| `pnpm bench:phase4 [-- --desktop] [--server \| --no-server]` | Phase 4's budgets: first rows of a 50,000-row database (seeded through the import route), scrolling it, a board drag, a cell edit shown, to the next frame and durable (web, and the desktop with `--desktop`); `--server` runs only the server's query budget (`Phase4Bench`), `--no-server` everything else; gated against the budgets and `bench/previous/phase4.json` |
| `pnpm bench:phase6 [-- --desktop] [--no-load \| --load-only]` | Phase 6's budgets against the e2e stack (started if not running): 20 editors on one page as Node clients over the real hub (the server's relay p95), the keystroke budget in Chrome (and the desktop app with `--desktop`) while 19 type, then 2,000 connections on the one API process (memory, CPU idle and with presence) and their reconnect storm after a recycle through the control port; gated against the budgets and `bench/previous/phase6.json` |
| `node scripts/state-hash-vectors.mjs [--check]` | The state-hash vectors (`packages/doc/vectors/state-hash-vectors.json`), made by plain Yjs; `--check` fails if they are stale |
| `node crates/cgw-store/tests/fixtures/make.mjs` | The SQLite migration fixtures, written by `cgw-store` built from the v0.1.0 and v0.2.0 tags (offline, under `target/store-fixtures`) |
| `SIM_SEEDS=60 SIM_STEPS=200 pnpm exec vitest run packages/doc/src/sync-sim` | The convergence simulator at size (CI runs 4 seeds of 40 rounds); `SIM_SEED` replays one |
| `node scripts/macos-build.mjs` / `node scripts/macos-acceptance.mjs` | On a Mac (the `macos.yml` runner): the universal app, signed when the `APPLE_*` variables are set; the acceptance run through the test-only bridge (`bench/results/macos-acceptance.json`) |
| `S1_OPS=10000 S1_SEEDS=3 S1_COMPARE=1 pnpm exec vitest run bench/editor/src/s1-fuzz.test.ts` | The full S1 fuzz, with the rejected configurations for comparison |
| `DB_VECTORS_WRITE=1 pnpm exec vitest run packages/workspace/src/db/vectors.test.ts` | Rewrites `packages/workspace/vectors/db-*.json` from the hand-written cases in `db/vectors/*.cases.ts` (then Prettier on them); the server's `DatabaseVectorTests` read the same files |
| `PHASE4_BENCH=1 dotnet test -c Release --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.Phase4Bench` | The server's database budgets at 50,000 rows (`PHASE4_ROWS`, `PHASE4_QUERY_RUNS`), to `bench/results/phase4-server.json` |
| `pnpm bench:phase8` | Phase 8's budgets against the e2e stack and the preview (started if not running): a paste of 1,000 cells shown and on the server, a 1,000-page Notion export imported on the device; gated against the budgets and `bench/previous/phase8.json` |
| `pnpm bench:phase10 [-- --server \| --no-server]` | Phase 10's budgets against the e2e stack and the preview (started if not running): the review of 500 changed customers less the ERP's dry run, typing between ten plugin frames, and (`--server`) retrieval by meaning over 100,000 chunks (`Phase10Bench`, Release); gated against the budgets and `bench/previous/phase10.json` |
| `pnpm bench:phase11` | Phase 11's server budgets (`Phase11Bench`, Release, in process on LocalDB or `CGW_TEST_SQL`, the mock OpenID Connect provider the fixture starts): search and the feed of 1,000 changes at 10,000 pages for a member in 20 of 50 groups with 500 group rows (the tree tracked; a member in no group beside), a sign-in by passkey and one through single sign-on (the API's own time, the provider's taken off); gated against the budgets and `bench/previous/phase11.json`; no client part |
| `PHASE11_BENCH=1 dotnet test -c Release --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.Phase11Bench` | The same in process alone, to `bench/results/phase11-server.json` (`PHASE11_PAGES`, `PHASE11_GROUP_ROWS`, `PHASE11_SEARCH_ROUNDS`, `PHASE11_SIGNIN_RUNS`) |
| `pnpm bench:phase12` | Phase 12's budgets in Chrome against the e2e stack and the preview (started if not running; needs `pnpm build`): a chart view of 50,000 rows by count, the p95 of eight opens after a first to its first bar (`bench/phase12-chart.mjs`, also alone; `PHASE12_CHART_ROWS`, `PHASE12_CHART_OPENS`), and pinning a 5,000-row database until every row's document is on the device while another page is typed into (`bench/phase12-pins.mjs`, also alone; `PHASE12_PINS_ROWS`, `PHASE12_PINS_LIMIT_MS`); gated against the budgets and `bench/previous/phase12.json` |
| `pnpm bench:phase13 [-- --server \| --no-server \| --local-model]` | Phase 13's budgets: ten networked plugin frames in Chrome against the e2e stack, the preview and the mock host (started if not running; needs `pnpm build`); `--server` retrieval by meaning over 1,000,000 chunks (`Phase13Bench`, Release; `PHASE13_CHUNKS` for a quick run; about 5 minutes to seed); `--local-model` the local model's chunk and question p95 (`Phase13LocalModelBench`, the real package in `CGW_LOCAL_MODEL` or `target/local-model/package`); gated against the budgets and `bench/previous/phase13.json` |
| `node scripts/local-model.mjs [--weights <folder>] [--python <python>]` | Phase 13: the local model's package from `voyage-4-nano`'s pinned revision (a Python environment under `target/local-model`, about 700 MB of weights), exported and checked against the model card's own run; `target/local-model/package/` and `target/deploy/cgw-local-model-voyage-4-nano-587d8d6.zip`, each file's SHA-256 printed (they must be the ones pinned in `LocalModelOptions.cs`) |
| `node tests/mocks/acme/server.mjs [--port 4289] [--challenge-port 80] [--resolve 127.0.0.1]` | Phase 14: the mock ACME server a site's certificates come from in tests (Playwright starts it with `--challenge-port 5290`) |
| `node tests/mocks/net/server.mjs [--port 4288]` | Phase 13: the host a networked plugin reaches (`/echo`, `/__mock/state`, `requests`, `reset`); Playwright starts it |
| `ORACLE_SEEDS=60 dotnet test --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.AccessOracleTests` | The access oracle at size (16 seeds by default); `ORACLE_SEED=<n>` replays the seed a failure names |
| `node scripts/web-localhost.mjs --build` / `--serve` | Phase 11: the app built against the API on `localhost` (`target/web-localhost`), served on `localhost:4268` for the passkey specs (Playwright starts `--serve`; CI builds it after `pnpm build`) |
| `PHASE10_BENCH=1 dotnet test -c Release --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.Phase10Bench` | The server's retrieval by meaning in process, to `bench/results/phase10-server.json` (`PHASE10_CHUNKS`, `PHASE10_RUNS`) |
| `VOYAGE_API_KEY=… dotnet test --solution server/Cgw.Server.slnx -- --filter-method "*A_real_embedding*"` | One real embedding call through Voyage, printing voyage-4's scores against the similarity floor; nothing else ever calls it |
| `pnpm bench:phase9` | Phase 9's budgets against the e2e stack and the preview (started if not running): a published page of 2,000 blocks, first byte from the cache and rendered fresh (`bench/phase9-site.mjs`, also alone: `node bench/phase9-site.mjs`), the first bars of a 50,000-row timeline and a drag (`bench/phase9-timeline.mjs`); gated against the budgets and `bench/previous/phase9.json` |
| `SITE_VECTORS_WRITE=1 dotnet test --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.SiteRendererTests` | Rewrites the site renderer's expected HTML in `server/tests/Cgw.Tests/fixtures/sites` (review the diff; Prettier leaves that folder alone) |
| `node bench/phase8-server.mjs [--runs 6] [--cycles 4]` | The server's CPU per push over real processes, 0.7.0 (`target/phase8-v070`, built as its header says) against this build's Release, alternately, each pair's ratio; its own ports 5380 and 10100 and database `cgw_phase8_bench`; to `bench/results/phase8-server-stack.json`. Phase 11: `--before target/phase11-v0100 --after <a tree with a Release build> --typist member --groups 20 --out phase11-server-push` (0.10.0 from its tag against this build, a member typing in 20 groups on a page shared with 20 others) |
| `PHASE8_BENCH=1 PHASE8_KEYS=900 PHASE8_WARMUP=450 dotnet test -c Release --solution server/Cgw.Server.slnx -- --filter-class Cgw.Tests.Phase8Bench` | The server's CPU per push in process, each step alone, to `bench/results/phase8-server.json` (`PHASE8_LABEL` names the run) |
| `node scripts/idb-torn-log.mjs [--trials 10] [--app]` | Chrome's IndexedDB after a torn log record: what the next sessions keep; `--app` the app's own store with and without the journal (`bench/results/idb-torn-log*.json`) |
| `node scripts/idb-durability.mjs [--trials 200] [--kill tree\|immediate]` | Chrome killed while a page writes, relaxed against strict (`bench/results/idb-durability.json`) |
| `node tests/fixtures/import/make.mjs [folder]` | The import fixtures written to a folder (default `target/import-fixtures`) |

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
- Drive the block handle with `page.mouse` down, move in steps, up: from Phase 8 it is a pointer
  drag (`cgTrackDrag`), not HTML5 drag, and its button sits inside an `aria-hidden` element, so
  select it by `.cgw-handle`.
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
- Playwright's `setOffline(true)` leaves an open WebSocket working, and CDP's `setBlockedURLs`
  leaves it open and fires no `offline` event: the app drops the hub on `offline`, and the
  desktop's network helpers and the kill test fire it themselves. `page.on('websocket')` and
  `routeWebSocket` see only sockets opened after they are attached: attach before the page
  connects.
- ProseMirror reads a selection made by keys a few milliseconds after the key: a shortcut pressed
  at once (Ctrl+Alt+M) can act before the last Shift+Arrow (wait for the editor's own selection).
  A click in the middle of a block can land on a comment's marker, which opens the thread and
  keeps the focus where it was: click a line's start.
- A spec that signs in and then calls `createWorkspace` (which loads the app again) can make the
  workspace before that start's account check answers: until 2026-11-15 it stayed "On this device
  only"; it now waits for the check. `locator.locator(otherLocator)` runs the other's whole chain inside the first: pass a selector.
  With a page open, a tree row under the pointer shows its own "Page actions": take the top bar's.
- `@microsoft/signalr` and `yjs` are not hoisted: a script at the root loads them with
  `createRequire` from `packages/shell/package.json` or `packages/doc/package.json`. The API's
  working set after other work is no baseline: measure before and after on one process, and gate
  the peak of several samples.
- An open page pushes about once a key: limits sized for HTTP's batches (the per-page 1,200 a
  minute) stop live typing. `bench/phase6.mjs` at 20 editors is what finds that.
- A local compaction's snapshot is the document in memory: made while a batch waited to be written,
  it held content no update carried, never pushed after a kill, and the server refused everything
  typed after it (the device then set its own refused updates aside: text reported saved, lost).
  `maintain` compacts only when nothing waits. It took the desktop sync kill test 77 to 285 runs
  to show: `--stop-on-failure --keep` keeps the store, and the server's `PageDocUpdates.Problem`
  says why a row was refused.
- `node:sqlite` (Node 24) reads a kept profile's `workspace.db` without any other tool: the
  `corrupt` table holds what the device set aside, with its reason.

### Phase 7

- y-tiptap writes a batch of transactions to Yjs as in history or not by the *last* one's
  `addToHistory`: an appended transaction marked out of history (an id fix) took the person's
  whole change with it, and Undo could not take back a duplicated block. Mark an appended
  transaction out of history only when the change it follows was.
- Anthropic's C# SDK 13.x speaks API version `2026-10-21`, which sends the key as
  `Authorization: Bearer`, not `x-api-key`: a mock or proxy reading `x-api-key` sees none. The SDK
  reads `ANTHROPIC_BASE_URL` (and credentials) from the environment unless told otherwise, and
  Claude Code sets `ANTHROPIC_BASE_URL`: always set `BaseUrl`, and subclass `AnthropicClient`
  with `ShouldAutoResolveCredentials => false`. `AnthropicClient` is not a record (`with` fails)
  and `BaseUrl` is init-only. Its XML docs list few types: write and compile (13.8.0's beta
  names: `BetaUserMessageParam`, `BetaThinkingConfigAdaptive`, `BetaOutputConfig { Effort, Format
  = new BetaJsonOutputFormat { Schema } }`, `Fallbacks = new Default()`,
  `BetaRawMessageStreamEvent.TryPickStart`, `TryPickContentBlockDelta`, `TryPickDelta`).
- A positional C# record body becomes all-required in the generated TypeScript: a body with
  optional members (and `null` meaning something) is a record of init properties. TestServer
  ignores `RequestSizeLimitAttribute`: a size test there relies on the route's own check.
- A Commit's 409 answers a `ConflictBody` (`conflicts`), not an `ErrorBody` (`errors`): a helper
  that reads every 4xx as `{errors}` must take it. The mock ERP's `reset` reseeds its records,
  since commits change them.
- An ERP block's frame unmounts far from the viewport: anything a block must not lose (pending
  changes) lives outside its React tree. While the leave guard asks, `useHash` returns the held
  hash and `location.hash` is the new one: code reading `location.hash` sees where the person
  tried to go.
- ESLint's `no-restricted-imports` `group` patterns follow gitignore: `'!@cgw/erp/ai'` cannot
  re-include a path whose parent a pattern excluded; use `regex`
  (`^@cgw/erp(?!/ai$)(/.*)?$`).
- `useSyncExternalStore`'s snapshot must be the same object until it changes: a store that answers
  `?? { status: 'idle' }` for what it never loaded gives a new one each read, and React draws again
  until it gives up (Settings drew nothing for a local workspace). Keep one frozen constant.
- A component behind `React.lazy` loads after more than a few ticks under Vitest: import the
  module first, then wait for the Suspense fallback to go. A registry of `BlockDefinition<P>` of
  different `P` does not type-check (variance of `render`): `untyped()`.

### After 0.7.0

- A workspace made while signed in is uploaded at once, while its first-run pages are still being
  made: whatever an upload reads beside the outbox must be read as one state with it
  (`uploadState`, which reads the outbox again until it has not changed).
- The app shows one notice at a time, and a later one replaces the text of the element the earlier
  one drew: a probe that records each new `.cgw-notice` element (as `collab.ts`'s `probes` does)
  misses it. Record each text the element shows.
- The hub sends a frame marked `complete: false`, with no updates, when the worker's compaction
  (every 200 updates) has taken rows between the relay's two reads. Any client of the hub, a
  bench's or a test's too, must pull the page then, as the app does, or it misses those updates.

### Phase 8

- Chrome's IndexedDB on Windows is LevelDB with `reuse_logs` and paranoid checks, and writes a log
  record's header and payload as two writes: a crash between them leaves a torn record, after
  which the next session's writes vanish silently at a later start, or Chrome deletes the whole
  store ("IndexedDB recovering from a corrupted (and deleted) database"), with either durability.
  `scripts/idb-torn-log.mjs` makes it happen; `--enable-logging --v=0` writes Chrome's own log to
  `chrome_debug.log` in the profile. The journal (`packages/store-web/src/journal`) is the remedy.
- `IDBTransaction.durability` reads `default` for Chrome's default (relaxed); fake-indexeddb keeps
  the option, so a unit test can check it.
- A killed Chrome's processes can outlive `taskkill /T /F` for seconds on a busy machine and hold
  the IndexedDB's `LOCK`, so the next open fails: end every process naming the profile and wait
  until none is left.
- Look for stale processes before measuring: a vitest fork worker left from 2026-11-11 took one
  processor for five days. CPU time per push moves by up to two times with the machine's load:
  alternate the builds, take the median, and compare runs of one series only.
- An in-process CPU bench of a few hundred calls measures the JIT (tier-up and PGO run in the
  background): warm up by hundreds of calls (450) before measuring.
- SQL Server takes at most 2,100 parameters a request, not a statement: pass a list as one
  OPENJSON parameter. A test that counts a request's SQL round trips listens to SqlClient's
  `DiagnosticListener` and counts only commands carrying a parameter that request alone has.
- `AssetCheckJob` saves a run's 20 assets in one `SaveChanges`: an asset another test deletes
  meanwhile fails the whole run. A test that reads its own asset as checked runs the job until it
  is (`AuthorizationTests.CheckAssets`).
- A refused connection to 127.0.0.1 takes about 2 s on Windows (SYN retries); MailKit against a
  closed port too. `HtmlEncoder.Create(UnicodeRanges.All)` keeps Arabic readable in an HTML mail.
- The relay sends a page's frames to every joined connection, the pusher's own included.
- jsdom has no `DataTransfer`, `ClipboardEvent` or `Element.scrollBy`: a test dispatches a plain
  `Event('copy' | 'paste')` with `clipboardData` defined on it, and stubs `scrollBy`.
- Chromium and WebKit offer Copy and Paste on a focused element only while something is selected,
  unless its `beforecopy` or `beforepaste` is cancelled; React has no handler for them, so the grid
  adds native listeners.
- During a drag, a window `mousemove` listener checks `buttons`: the button can come up outside
  the window, and no `mouseup` reaches the page.
- Excel and Sheet end every row of their clipboard text with CRLF; one line end alone is one empty
  cell. Intl's Arabic output, and text copied from RTL cells, carry bidi marks (U+061C, U+200F):
  a reader of pasted text drops them first. `ar-SA`'s default calendar is `islamic-umalqura`: ask
  `Intl.DateTimeFormat` for `calendar: 'gregory'` for a Gregorian field order.
- fflate's `unzipSync(bytes, { filter })` hands the filter each entry's declared sizes before it
  inflates anything, and inflates into a buffer of the declared size: list with a filter that
  returns false, check the sizes, then unzip what passed (by index: names may repeat). It reads
  names without the UTF-8 flag as Latin-1; the import reads the central directory again for them.
- i18next reads `count` as the plural count: a formatted number in a text needs a placeholder of
  its own name (`{{number}}`).
- A Notion export's path holds every parent's id as well as the file's: resolve a link by the last
  one; in a notion.so address an id after `#` is a block's, not the page's.
- An inline import into a `MemoryStore` under React's `act` finishes hundreds of pages in one tick:
  a test that presses Stop mid-import gates the store's writes.
- Vite is `apps/web`'s dependency and not hoisted: a script that builds a page with Vite loads it
  through `createRequire(apps/web/package.json)` and aliases `@cgw/*` to the packages' sources.
- While another stream's server work did not build, the e2e stack ran from `git archive HEAD
  server scripts global.json` under `target/` (a junction to `node_modules`, `target/ffi`
  copied); `scripts/cloud-account.mjs` reads mail from the checkout's `.cgw-dev/e2e/mail`.

### Phase 9

- `JsonDocument.Parse`'s default `MaxDepth` is 64: a document whose blocks nest about 30 deep
  already passes it (each level is a block object and its `content` array). The site's renderer
  parses with 512 and stops drawing at 40 levels.
- xUnit's `Assert.Contains`/`DoesNotContain` on strings compare by the current culture: `"\0"` is
  "found" at position 0 of any string. Pass `StringComparison.Ordinal`.
- `Results.Bytes` takes no status code: a 404 with a body is `Results.Content(text, type, encoding,
  404)`. `app.MapGet` answers another method with routing's 405; the Sites process maps with
  `app.Map` and answers anything but GET and HEAD with its 404 page.
- EF writes `defaultValue: false` into a migration for a new non-null `bool` whatever the entity's
  initialiser says, and `HasDefaultValue(true)` would stop EF from ever inserting `false`: edit the
  migration's `defaultValue` (as `Phase9` does for `PublishingEnabled`).
- IIS adds `Server` and `X-Powered-By` to every answer: the sites' `web.config` removes both
  (`removeServerHeader`, IIS 10).
- A C# local function named as a static helper of the class (`Id()` beside `Id(string)`) hides it:
  every call in its scope binds to the local one.
- A second web project in the server tests needs an entry point of its own with `Main`
  (`Cgw.Sites.SitesProgram`), so `WebApplicationFactory<SitesProgram>` finds it and two `Program`s
  do not clash.
- The site's expected HTML (`server/tests/Cgw.Tests/fixtures/sites`) is compared byte for byte:
  Prettier leaves that folder alone (`.prettierignore`).
- `DB_VECTORS_WRITE=1` rewrites every `db-*.json` without Prettier's line breaks: run Prettier on all
  five after, or four files show as changed.
- A database view type that reads its own rows sets `ownRows` in the registry: `DatabaseView` then
  runs no query and shows none of its notices for it.
- `CgTimeline` reads the direction by `getComputedStyle(…).direction` (jsdom computes it from
  `dir`); a jsdom drag test stubs `getBoundingClientRect` of its canvas
  (`[data-cg-timeline-scroller] > :first-child`) and its scroller (a 56 px header), and
  `HTMLElement.prototype.scrollBy`. Press mid-day: a press on a day's boundary rounds a mirrored
  drag a day further.
- A share link's host sends no filter, so a calendar's or a timeline's undated list asks by
  `RowRequest.undated` (the server applies the view's own date property).
- `Dialog`'s box has `max-block-size` and no overflow: a long body scrolls in a child with
  `min-block-size: 0; overflow: auto`. A dialog whose focused button is swapped out by its own view
  leaves focus on `body`, so Escape no longer reaches it: specs close dialogs by their Close button.
- A UUIDv7's first 8 hex digits are its time (a step is about 65 s): anything cut to "its first 8"
  collides for ids made close together. Use the last ones.
- `AssocQueryStringW` with `ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN` and a null buffer gives
  the open command's length (S_FALSE) or fails for an unknown scheme: no registry code of our own.
- The Arabic catalogue mixes digit styles (Phase 8's strings Arabic-Indic, Phase 5's Western): a
  blanket digit change rewrites other streams' strings. Translate only your own lines.

### Phase 10

- openapi-fetch reads a failed answer's body itself (`result.error`): `problemOf(result.response)`
  after it finds nothing and answers `server.error`. Read the code from `result.error`, as
  `cloud.ts`'s `data` does (`ai/api.ts` did not until Phase 10).
- Chrome reports a request its CSP refused as a request that failed, so Playwright's `request`
  event fires for it: a "nothing left the frame" check counts what reaches the context's `route` or
  `requestfinished`, and asks that every `requestfailed` says blocked.
- A sandboxed frame without `allow-same-origin` posts with `event.origin === "null"` (a string), and
  can only be posted to with target `"*"`: check `event.source` against the frame's window. A
  CSP's `'self'` may not match a document a `sandbox` directive made opaque: name the origin.
- A plugin block's `props` is JSON text in an attribute: the server's derived JSON holds it
  escaped (`\"count\":2`).
- A content version (Customers, Items on hand) is made from the fields the user sees, so two users
  read different versions of one record: a commit sends the version read in its own session. Items
  on hand's rows share their `key` (the item): a row is told by its `id`.
- The file-writing tool writes a real U+FEFF for a `﻿` escape in a literal, and the edit tool
  writes escapes such as ` ` and `؟` as the characters too: scan new files for categories
  Cc, Cf, Zs, Zl, Zp after writing, and put escapes back by script.
- `@cgw/plugins/frame` (the contract the shell imports at start) must not pull in React or fflate,
  or they enter the initial JavaScript; the view and the bundle reader load lazily. 0.10.0's
  initial JavaScript is 345.7 kB of the 350 budget.
- A process that serves the public must never hold the Data Protection key ring: it could open the
  AI keys' ciphers in the SQL it reads. Tickets it must check are stored hashed instead.
- A test can run a process as a SQL user with fewer rights: `CREATE USER x WITHOUT LOGIN`, `DENY`
  what it must not read, and a `DbConnectionInterceptor` running `EXECUTE AS USER = N'x'` on every
  connection (`Pooling=false`). Seeding 100,000 vector rows takes `SqlBulkCopy`, not EF.
- `SELECT 1 FROM [T] WITH (UPDLOCK, HOLDLOCK) WHERE …` in a transaction locks the row or the key
  range where it would be: the off switch and the worker's vector writes take it first.
- HttpClient writes `Cache-Control`'s directives in an order of its own: tests read
  `CacheControl.Private` and `.MaxAge`, not the string.
- Right after a reload the app may not have mounted its shortcuts: a spec presses Ctrl+K again until
  the palette shows.
- The sync status can still read "Synced" from before a click's operation is queued: a spec that
  must know the server holds a change (a trash) reads the server (`untilTrashedOnServer`, the change
  feed). Edge names its device "Edge on Windows": every Arabic walk of Settings allows both names.
- The desktop's native side answers `auth_token` one at a time, and offline each refresh fails only
  after about 2 s: callers at once share the ask in flight (`apps/web/src/platform/shared.ts`), or
  the sync status says "Syncing" for many seconds before "Offline". A WebView2 process of the last
  start still running makes the next start of its profile join it and the new debugging port never
  opens: a harness ends the profile's processes until none is left before each start.

### After 0.10.0

- The production host has IIS's WebDAV Publishing installed (for other sites), and its module
  answers every `PUT` and `DELETE` with 405 before ASP.NET Core sees them: 0.10.0's API could read
  its AI settings but never save them. Both `web.config`s remove `WebDAVModule` and the `WebDAV`
  handler; tests through `WebApplicationFactory` never meet IIS, so only the IIS log shows it.

### Phase 11

- The push's SQL fast path (`DocService.RunBatchAsync`) is the one copy of the access rule outside
  C#: a change to the rule changes it too. `AccessOracleTests` holds its answers and its round
  trips to the rule. `Access.LevelsAsync` and `AllLevelsAsync` leave deleted pages (and, for
  `AllLevelsAsync`, rows) out of their answers: read them with `GetValueOrDefault(id, Levels.None)`
  or `LevelIn`.
- A test that writes pages deleted for good straight into the database sets `PurgedAt` (the purge
  job, which other tests run over every workspace, removes a tombstone's rows meanwhile). A record
  with a property named as a static class (`PermissionsUpdate.Principals` beside
  `Sharing.Principals`) hides the class inside the record's own body only. `if (false)` is CS0162,
  an error here.
- Identity's `IdentityUserContext.OnModelCreating` takes the schema version from the host's
  `IdentityOptions.Stores`: a host without Identity (the worker, Sites, `dotnet ef`) maps no
  passkeys, and asking for schema 3 also narrows `UserLogins`/`UserTokens` keys and `PhoneNumber`.
  `CgwDb` maps `UserPasskeys` itself. Identity keeps a ceremony's state in a cookie a copied request
  carries again: one use needs a server record (`PasskeyChallenges`).
- WebAuthn takes no IP address as its relying party, and development runs on `127.0.0.1`: passkey
  specs run against `scripts/web-localhost.mjs`'s build. The test server's origin is
  `https://localhost`, so the relying party id there is `localhost`. Edge's virtual authenticator
  answers the sign-in page's autofill ask as the page opens, which signs in by itself.
- A second button whose name contains "Sign in" ("Sign in with a passkey") breaks
  `getByRole('button', { name: 'Sign in' })` (a substring, strict mode): use `exact: true`.
- EF logs an expected duplicate key as an error: a one-use insert is `INSERT … SELECT … WHERE NOT
  EXISTS (… WITH (UPDLOCK, HOLDLOCK))` with `SET NOCOUNT ON` first. A runtime EF model gains ad-hoc
  entity types from raw `SqlQuery<T>`: compare models by `GetService<IDesignTimeModel>().Model`.
- `Microsoft.IdentityModel.Protocols.OpenIdConnect` is in the server's graph only at 7.7.1 (SqlClient's)
  while OpenIddict brings IdentityModel 8.23.0: never mix them; single sign-on reads discovery with its
  own retriever over 8.23's `ConfigurationManager`, which refuses `http` unless told (development's
  mock). OpenIddict 7 stores token types as URNs (`urn:ietf:params:oauth:token-type:refresh_token`).
- Chrome applies a page's CSP `form-action` to the redirects after its form posts: a form that goes on
  to a provider chosen by the address typed needs `https:` there (single sign-on's pages, never the
  password page); the mock provider's page sets none.
- `SsoMetadata` builds its own `HttpClient` (no `IHttpClientFactory`): a handler filter sees none of the
  API's requests to a provider; the runtime's `System.Net.Http` `ActivitySource` does
  (`Phase11Bench.ProviderWait`). `IdnMapping.GetAscii` with `UseStd3AsciiRules` throws for `_`, an empty
  label or a label starting or ending with `-`. `ErrorCodeTests`' guard looks for `"code"` with quotes in
  the test sources.
- Vitest's `include` named no folder under `tests/mocks` until Phase 11 (`tests/mocks/**/*.test.ts`).
  `ServerFixture` redirects a mock's output and never reads it: a mock that printed per request would
  stall. Node's `fetch` with `redirect: 'manual'` gives the real 302 and its `Location`.
- A library component used only in a lazy chunk but sharing the library's internals with the initial
  graph made Rolldown split those internals into chunks of their own: +1.6 kB of initial JavaScript by
  `bench/phase1.mjs`'s per-file gzip sum with no new code (`vite.config.ts`'s `ui-core` group). New
  screens' words go in a section (`i18n/sections.ts`), never the catalogues: 0.11.0's initial
  JavaScript is under 348 kB of the 350 budget.
- `CgComboBox`'s list is a portal outside the shell's `Dialog`: Escape in its input reaches the
  dialog's handler unless stopped. A controlled `CgComboBox` queues a state update after a choice: in
  jsdom, act inside `await act(async () => …)`. `getByRole('option')` also finds a native `<select>`'s
  options, never shown: scope it to the combobox's `aria-controls`. `CgCheckBox`'s accessible name
  holds its description (match by `^Name`).
- Node 24's `Intl` formats `ar` numbers and dates with Western digits: a test computes the expected
  text with `Intl`, never Arabic-Indic digits written out.
- At 10,000 pages, search on LocalDB (the `LIKE` path) is about 265 to 275 ms at p95 with or without
  groups, within 10 % of the 300 ms budget there: compare a member in no group before blaming access.

### Phase 12

- CDP's `Accessibility` domain (`getFullAXTree`) has no row index, row count, `posinset` or
  `setsize` (it has roles, names, descriptions, `level`, `expanded`, `selected`, the active
  descendant): read them from Chromium's own tree, `chrome://accessibility` (`edge://accessibility`)
  printed for another tab, the browser launched with `--force-renderer-accessibility` and the page's
  "Allow" filter set (`tests/e2e/grid.ts`). Headless works; WebView2 has no such page.
- Chromium numbers every `row` of a grid: a row without `aria-rowindex` gets the previous one's plus
  one, a row not above the previous is raised (and every row after it), and `aria-rowcount` is
  raised to the highest index. A line that must not count cannot be a row (the "New" line is
  `aria-hidden`), a tree grid's group headers always count, and virtualised rows must be in
  ascending DOM order.
- Chromium takes the `aria-label` of a button inside an `aria-hidden` span into a cell's name from
  contents: name such a cell by `aria-labelledby`. `packages/database/src/testing/dom.ts` gives a
  height to `grid` and `treegrid` only: a new scrolling role needs adding there, or jsdom draws a
  handful of items. In e2e, `database.ts`'s `grid()` matches either role, a column header is found
  by its name with `exact: true` (its type is its description), the title cell by `rowheader`.
- `CgChart` says its own words in English (its data table's toggle and header, its series' and
  points' role names, its keyboard instructions, what it announces) unless every one is passed in
  `strings`. `model.test.ts` holds every `t('…')` in the database package to `en.ts`: a lazily
  merged catalogue's translator needs another name (`ct`, `chartT`).
- i18next's `addResourceBundle` merges deeply into the catalogue objects the instance was given:
  once a chart or a table has drawn, its words are inside `@cgw/database/i18n`'s module objects at
  run time. A test of what the start catalogue holds reads the source files.
- The API answers an unknown route 404 `not.found`, the same as a workspace the account no longer
  has: a new route the engine calls inside a workspace's pass must not let a 404 reach the pass's
  catch, which removes the workspace from the device (`lose`). An older server has no batch pull.
- The rate limiter runs in two passes (`Program.cs`, `RateLimits.BeforeAuthentication`):
  OpenIddict's routes (`/connect/*`) before `UseAuthentication()`, as OpenIddict answers a refused
  grant or revocation inside the authentication middleware, before any bucket after it; every other
  route after it, so a per-person partitioner sees the user (until 2026-11-21 one pass ran before
  authentication, and every "per person" window was the address's). A policy on a `/connect` route
  must be an address's. In the tests every request is one address, so a policy the fixture does not
  raise is shared by every test class: test a limit on a `server.Variant`; `RateLimitTests`'
  `Addresses` startup filter gives each client an address of its own.
- A hand-made Yjs v1 update (one string item into a named root:
  `1, 1, client, 0, 0x04, 1, "name", text, 0`) is a real update every reader decodes
  (`DocsPullTests.Padding`): a test may write large valid updates straight into `PageDocUpdates` as
  validated. Garbage marked valid makes every other test's worker passes (derive, state hash,
  history) throw on that page. An order key cannot end in `0` (`"a000"` is refused): use
  `OrderKeys.Between`.
- The worker's derived document is a moment behind the updates (Phase 4): a spec that reads it waits
  for the last change it checks, not an earlier one (`erp-reports.spec.ts` read it in Edge before
  the block named its last dates).
- The page-wide Arabic walk (`arabic.spec.ts`'s `english()`) takes everything under `.cgw-editor` as
  the person's own text, and every block is inside it, so it never looks inside an ERP block: report
  blocks are walked with `erp12.ts`'s `englishIn(block, …)`.
- `vitest.config.ts` includes `tests/contracts/**`, so `pnpm test` runs the ERP suite against its
  mock: `scale.test.ts` adds about 50 s, in parallel with the other files.
- A Python heredoc in the Bash tool loses a level of backslashes even with a quoted delimiter:
  `'\n'` became a line break in a spec, and `\\b` a U+0008 in a file. Write such scripts with the
  file tool (Phase 6), and scan for category Cc after.
- `CgTimeline` counts a drag's days by the day under the pointer, not the distance: pressed at a
  bar's middle, a day's boundary when it spans an even number of days, a drag of 22 px moved it two
  days. Press inside a day, away from the bar's ends (their resize edges take a press 10 px in).
  After a drop it scrolls the bar's line and start into view: wait for the bar to rest before the
  next drag.
- Bumping the library can split its new small modules into chunks of their own in the first
  screen's graph (R0 to R9 cost 1.9 kB of initial JavaScript): measure after every bump
  (`bench/phase1.mjs`'s `initialJs`) and add them to `ui-core`.

### Phase 13

- A Bash `cd` into a folder outside the session's working directories moves the session there (the
  shared notes folder did): read other folders by absolute path.
- A tab reads its plugin list again on the feed's `plugin` change, and a block whose plugin changed
  draws a new frame: a spec reading a frame's state reads it in one `evaluate` inside the frame and
  polls the whole of it, or it reads half of one frame and half of the next.
- `--repeat-each` runs a spec's copies in parallel workers: a spec that resets a shared mock (the
  net mock's request log) needs `--workers 1` to repeat.
- A plugin's manifest names it in both languages: a spec in Arabic finds its buttons by the Arabic
  name ("تنبيه", not "Ping").
- Same-document navigation (`page.goto('/#/settings')` from a page of the app) mounts Settings
  without reloading what a store holds: Settings → AI reads its settings again when it opens.
- A controlled radio whose value comes from the server does not move on a click until the save
  answers: Settings shows the choice at once (its own state) and drops it when the save settles.
- .NET's `Regex` reads `\p{L}` per UTF-16 unit: a tokenizer's split over letters outside the BMP
  (CJK Extension B, mathematical letters) differs from Hugging Face's; `QwenTokenizer` splits by
  `Rune`. Dynamic int8 quantisation of `voyage-4-nano` breaks it (cosine 0.10 with fp32): the
  package keeps fp32 with the token table in fp16.
- ONNX Runtime's NuGet packages name their MIT licence by file, which the NuGet gate cannot read:
  they are named in `license-policy.json`'s `nugetExceptions`. The runtime's native DLLs go to the
  API and the worker only; the Sites process references nothing of it.
- An index that widens when the permission filter drops pages must stop once it has ranked every
  chunk, or a workspace with fewer readable pages than the limit widens for ever.

### After 0.13.0

- CI's browsers refuse to keep storage, so the notice "This browser may clear your pages…" shows
  once a profile across the window's foot (about 718 to 780 px of 800) until closed; a local
  profile may never show it. A spec that presses near a view's foot sets `cgw-persist-notice` in
  `localStorage` first (`timeline.spec.ts`). Which bars a timeline shows moves with today's date,
  so such a spec can pass for weeks and fail one day (run 44962093078, on 2026-11-22).
