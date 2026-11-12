# Cash Gear Workspace

A Notion-style workspace for the Cash Gear ecosystem: block documents, a page tree, databases,
embedded sheets and ERP data, in the browser and as a Tauri desktop app.

Status: Phase 0 (scaffold and spikes) is done; the next step is Phase 1. Spike results and the
decisions they changed are in `docs/DECISIONS.md` (2026-11-11: Phase 0 results).

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
| `apps/web` (`@cgw/web`) | Vite + React entry: picks the platform (web or Tauri) and mounts the shell |
| `packages/shell` (`@cgw/shell`) | App frame (sidebar, top bar, hash routing by page id), i18next catalogues (`en`, `ar`), theme controller, command registry, `event.code` shortcuts, the `WorkspacePlatform` interface |
| `packages/workspace` (`@cgw/workspace`) | Records, `Operation`, `LocalStore` (store schema 2) and its conformance suite (`@cgw/workspace/testing`, with an in-memory server for sync tests), the operation planner with the tree rules, the remote planners (`remote.ts`), the sync engine (`sync/`), order keys, UUIDv7, the metadata mirror, search normalisation; shared test vectors in `vectors/`. No React, DOM or ProseMirror |
| `packages/doc` (`@cgw/doc`) | The block schema (version 1), block-id plugin, the Yjs seam over the patched `@tiptap/y-tiptap`, `PageDocument` (open, autosave, compaction, history), plain text and Markdown out, Markdown in, content builders |
| `packages/editor` (`@cgw/editor`) | The Tiptap editor over a `Y.Doc`: block commands, keymap, input rules, slash menu, bubble toolbar, block handle and drag, block selection, clipboard, tables, plain DOM node views; given an `EditorHost`, never touches storage |
| `patches/` | The Q18 patch on `@tiptap/y-tiptap` 3.3.0 (`pnpm patch`), made by `scripts/y-tiptap-patch.mjs` |
| `scripts/eslint` | Workspace's own lint rules: `cgw/no-untranslated-text` |
| `apps/desktop` (`@cgw/desktop`, crate `cgw-desktop`) | Tauri 2 shell showing the same page; CSP in `src-tauri/tauri.conf.json` |
| `scripts/` | Standing-check runner, licence gate, third-party notices, desktop smoke test, WebView2 setup |
| `tests/e2e` | Playwright specs (Chrome and Edge) |
| `tests/license-gate` | GPL fixtures the licence self-test must reject |
| `packages/store-web` (`@cgw/store-web`) | `LocalStore` on IndexedDB (database `cgw-workspace`, store schema 1); plans operations inside its own transaction; text search in a MiniSearch worker loaded from it |
| `packages/store-desktop` (`@cgw/store-desktop`) | The desktop's `LocalStore`: binary frames to `crates/cgw-store` over Tauri's `invoke('store')`, or over `cgw-store-cli` in tests; plans against its in-memory mirror |
| `crates/cgw-store` | SQLite store (rusqlite bundled, WAL, FTS5): a fixed set of typed requests in a binary frame, never SQL from the webview; asset files beside the database; `cgw-store-cli` for tests |
| `crates/cgw-native` | Desktop helpers without Tauri: `cashgear-workspace://` links read into the app's routes, file names made safe, the desktop's sign-in (PKCE, the loopback listener, token exchange and refresh) and the keychain |
| `crates/cgw-ydoc` | Yjs functions over `yrs` for the server worker (merge, diff, compact, JSON, text, client ranges, validate), with a C ABI for .NET; build the DLL with `--profile ffi` |
| `server/` | .NET 10 solution `Cgw.Server.slnx`. `Cgw.Core`: EF Core data (`CgwDb`, the tenant filter, migrations), blob storage with signed URLs, mail, audit. `Cgw.Api`: the API process (ProblemDetails with codes, correlation ids, rate limits, health, Identity, OpenIddict, the sign-in pages, the feature modules). `Cgw.Ydoc`: `cgw-ydoc` by P/Invoke, worker only. `Cgw.Worker`: the jobs. `tests/Cgw.Tests`: xUnit v3 on SQL Server and Azurite. `openapi/v1.json` is written by the build |
| `packages/shell/src/cloud` | The connection to the API: `cloud.ts` (the typed client, the sync engine wired to the session, account, sharing, versions, search, previews, remote assets), `CloudUi.tsx` (sign-in, devices, sync status, upload, members and invites), `ShareDialog.tsx`, `SharedView.tsx` (a page by link) |
| `deploy/iis` | `install.ps1`: the API on IIS and the worker as a service, from the deploy package (docs/OPERATIONS.md) |
| `packages/api` (`@cgw/api`) | The API client: `schema.ts` generated from `server/openapi/v1.json`, openapi-fetch, cookie with antiforgery header (web) or bearer (desktop) |
| `bench/editor` (`@cgw/bench-editor`) | Phase 0's harnesses on the product packages: S1 fuzz, S2 gate, S3 corpus, browser checklist, budgets, hostile content; S1's rejected schema variants kept for comparison. `app.html`: the whole app over a seeded 10,000-page store, for `bench/phase1.mjs` |
| `bench/ydoc-dotnet`, `bench/sequence-dotnet` | .NET 10 harnesses: `cgw-ydoc` by P/Invoke (S3); 50 writers on SQL Server (S8) |
| `bench/webview2-host` (crate `cgw-webview2-host`) | A WebView2 window on any URL, driven by Playwright over CDP |
| `bench/sheet-embed` | Sheet's deployed app in a sandboxed iframe (S9) |
| `bench/results/` | What runs write; not committed; CI uploads it |
| `.github/workflows/ci.yml` | Licence gates on Ubuntu; build, test, desktop smoke, kill tests, Phase 1 budgets and the Phase 0 harnesses on Windows |
| `.github/workflows/release.yml` | On a `v*` tag: release check, installer test, signed NSIS installer and update, a drafted GitHub release |
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
| `pnpm dev:server` | The server stack (`scripts/server-stack.mjs`): Azurite, the API on `http://127.0.0.1:5280` and the worker, database `cgw_dev` on LocalDB, mail in `.cgw-dev/mail`. `--e2e` (Playwright starts it) uses a fresh `cgw_e2e` and `test-results/mail` |
| `node scripts/server-publish.mjs` | The deploy package: `target/deploy/cgw-server-<version>.zip` |
| `node scripts/deploy-rehearsal.mjs` | The package installed on a scratch database, smoke-tested, then backed up, restored elsewhere and compared (`bench/results/deploy-rehearsal.json`) |
| `pnpm bench:s3` | S3: Yjs writes a corpus, `cgw-ydoc` processes it from .NET, Yjs checks it (`S3_DOCS`, `S3_BIG_BYTES`) |
| `pnpm bench:webview2-host` then `pnpm bench:browser [-- --s5 --s6 --s7 --chrome --webview2]` | Browser harnesses on port 4290 |
| `pnpm bench:sequence` | S8 on LocalDB (creates and drops `cgw_spike_s8`) |
| `pnpm bench:sheet-embed` | S9 against Sheet's deployed app |
| `cargo build -p cgw-store --bin cgw-store-cli` | The binary the SQLite conformance suite runs through (`pnpm check` builds it; without it the suite is skipped locally) |
| `node scripts/kill-test.mjs --target web|desktop --runs N` | Kill the app while typing, reopen, check nothing saved was lost (web needs `pnpm build`; desktop needs the release build) |
| `S1_OPS=10000 S1_SEEDS=3 S1_COMPARE=1 pnpm exec vitest run bench/editor/src/s1-fuzz.test.ts` | The full S1 fuzz, with the rejected configurations for comparison |

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
  (`.cgw-dev/run`, `test-results/server/run`), so a build while it runs is not blocked.
- ASP.NET Core antiforgery with `SecurePolicy=Always` refuses plain http: the dev stack sets
  `Api__AllowHttp` (refused in Production). In-process tests run on https and never see it.
- The antiforgery header wins over the form field: a "no token" test removes the client's
  default `X-CSRF-TOKEN`. `HtmlEncoder.Default` writes Arabic as entities; compare encoded text.
- `MemoryConfigurationSource` throws on a duplicate key. PowerShell unrolls a one-element array
  of arrays.
- Azurite saves its metadata every 5 s and not when killed on Windows: wait out a save before
  copying its folder (the restore drill).
