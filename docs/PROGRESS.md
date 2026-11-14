# Progress

What is done, with evidence. A box is ticked only when its proof is linked beside it: a CI run, a
test name, a measurement, or a commit. The tasks behind each milestone are in
`IMPLEMENTATION_PLAN.md`.

## Status

| Work | Status | Tag |
| --- | --- | --- |
| Planning documents | Done, 2026-11-11 | |
| Phase 0: Scaffold and spikes | Done, 2026-11-11 (S6 misses one budget by 1 to 3 ms; Q18 to Q20 raised) | `phase-0` |
| Phase 1: Core block editor (MVP) | Done, 2026-11-11 (0.1.0; the screen-reader pass is by the accessibility tree) | `phase-1`, `v0.1.0` |
| Phase 2: Cloud document platform | Done, 2026-11-12 (0.2.0; deployment is yours: the package is rehearsed) | `phase-2`, `v0.2.0` |
| Phase 3: Offline | Done, 2026-11-12 (0.3.0; the Mac's sign-in and sync against the deployed API are yours) | `phase-3`, `v0.3.0` |
| Phase 4: Workspace databases | Done, 2026-11-14 (0.4.0; a share link shows a note where a database is) | `phase-4`, `v0.4.0` |
| Phase 5: Cash Gear ecosystem | Not started | |
| Phase 6: Collaboration | Not started | |
| Phase 7: Editable ERP blocks, plugins, AI | Not started | |
| Track U: `CashGear.React.UI` components | Not started | |
| Track S: Cash Gear Sheet embed and cloud workbooks | S1 and S2 done in `cashgear-sheet` (2026-11-13); S3 to S5 not started | |
| Track E: Cash Gear ERP connect contract | Not started | |

## Planning

- [x] `ARCHITECTURE.md`
- [x] `DATA_MODEL.md`
- [x] `SYNC_DESIGN.md`
- [x] `INTEGRATIONS.md`
- [x] `IMPLEMENTATION_PLAN.md`
- [x] `DECISIONS.md`
- [x] `PROGRESS.md`
- [x] `CLAUDE.md`

## Phase 0: Scaffold and spikes

Done 2026-11-11. CI run for the evidence below: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43019133145
(commit `6346d23`, all jobs green). Local results are from `bench/results/` on the reference machine (Windows 10
19045, Chrome 157.0.8103.50, WebView2 157.0.4341.42, .NET 10.0.15, LocalDB 17.0.4025.3).

Milestones

- [x] M0.1 Scaffold: workspaces, configs, web app, desktop shell, CI, licence gate. Commits `1a31905`, `b5ca59b`, `47f6338`; CI run 43001602936 green (standing checks, web build, Chrome and Edge smoke, desktop build and WebView2 smoke)
- [x] M0.2 Spike S1: block schema and block ids under collaboration. `bench/editor/src/s1-fuzz.test.ts`, `s1-scenarios.test.ts`; commit `cfa61c9`
- [x] M0.3 Spike S2: old client meets a newer document. `bench/editor/src/s2-version-gate.test.ts`
- [x] M0.4 Spikes S3 and S4: Yjs on the server. `crates/cgw-ydoc` (commit `ec1b001`), `bench/ydoc-dotnet`, `pnpm bench:s3`; S4 not needed
- [x] M0.5 Spike S5: RTL and Arabic input. `bench/editor/run-browser.mjs --s5`, `bench/webview2-host`
- [x] M0.6 Spike S6: performance. `bench/editor/run-browser.mjs --s6`, `bench/editor/src/generate.ts`
- [x] M0.7 Spikes S7, S8, S9: hostile updates, sequence under load, Sheet in an iframe. `crates/cgw-ydoc/src/hostile_tests.rs`, `run-browser.mjs --s7`, `bench/sequence-dotnet`, `bench/sheet-embed` (commit `1ce99d3`)
- [x] M0.8 Close: results in `DECISIONS.md` (2026-11-11: Phase 0 results), content expressions in `DATA_MODEL.md`, `bench/spikes/` removed and its harnesses moved under `bench/` (commit `ce830e5`); CI runs S1, S2, S3, S5, S6 and S7 (commit `21d836d`)

Notes

- Commits `1ce99d3`, `21d836d` and `ce830e5` fail `format:check` (an unformatted
  `bench/README.md`; CI run 43017712882). `6346d23` fixes it; every other check passed on them.
- `cargo deny check advisories` (informational, as in Sheet) reports `smallstr` 0.3.1 as
  unmaintained; `yrs` 0.28.1 depends on it.
- S6 on the hosted runner (Chrome 156.0.8078.80, run 43019133145), the first rows of the
  benchmark history: open p95 34.8 / 114.4 / 297.4 ms and keystroke p95 16.7 / 20.0 / 25.1 ms at
  200 / 2,000 / 5,000 blocks; heap 19.5 MB at 5,000.

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| CI green on `main` with all standing checks | Pass | Run 43019133145 on `6346d23`: licence gates; format, lint, typecheck, unit tests (with the S1 fuzz at 1,500 operations, S1 scenarios, S2, the Yjs pending case); Rust fmt, clippy, tests (with S7's server side); web build; e2e in Chrome and Edge; desktop build and WebView2 smoke; S3, S5, S7 and S6 in Chrome |
| S1: no duplicate ids, ids stable on move, no caret jump | Pass, after changing the schema (D3) and with the id-aware binding (Q18) | 12 runs of 10,000 operations, 2 and 3 clients: 0 duplicate ids, 0 ids changed by a move, 0 content errors, 291 to 843 repairs a run (`s1-fuzz-recommended.json`); no caret jump in jsdom (`s1-scenarios.json`) and in Chrome and WebView2 (`s5-rtl.json`). The original schema failed 9 of 12 runs (`s1-fuzz-final.json`) |
| S2: old build read-only, server bytes unchanged | Pass | Read-only, 0 updates pushed, 281 bytes identical (`s2-version-gate.json`) |
| S3: `cgw-ydoc` matches Yjs on 1,000 fuzzed documents; no crash; 1 MB compacts in under 200 ms | Pass | 1,000 documents, 0 differences locally and 300 on every CI run (`s3/verify-summary.json`); 2,520 malformed calls, no panic or crash; 1 MB page 24.8 ms median; fragmented 1 MB history 307 ms, against 642 ms for Yjs 13 (`s3/dotnet-summary.json`) |
| S4: YDotNet suite and soak (only if S3 fails) | Not run | S3 passed; YDotNet wraps the same `yrs` |
| S5: RTL and IME checklist | Pass | 17 of 17 in Chrome and in WebView2 (`s5-rtl.json`) |
| S6: budgets met at 2,000 blocks; 5,000 usable | **Fail on one budget** | Keystroke to paint at 200 blocks p95 19.1 ms (Chrome) and 17.0 ms (WebView2) against 16 ms. Met: open 200 p95 46.5 / 34.7 ms, open 2,000 p95 167 / 202 ms, keystroke at 5,000 p95 47.5 / 45.5 ms, heap at 5,000 19.6 MB (`s6-perf.json`). Raised as Q19 |
| S7: hostile corpus inert | Pass | No script, unsafe link, event attribute or dialog in Chrome and WebView2 (`s7-browser.json`); 8 hostile-input tests in `cgw-ydoc`. Gap raised as Q20 |
| S8: no missed update with 50 writers | Pass | 3,998 updates, 8 readers, 0 missed under READ COMMITTED and READ_COMMITTED_SNAPSHOT; the `IDENTITY` control missed about 70 % (`s8-sequence.json`) |
| S9: Sheet draws a range inside an iframe | Pass | A workbook drawn in a sandboxed iframe from a parent without COEP, Chrome and WebView2 (`s9-embed.json`, `s9-*-plain.png`) |
| Q1 to Q4 answered in `DECISIONS.md` | Done | 2026-11-11: Phase 0 results, "Answers to Q1 to Q4" |
| Final content expressions in `DATA_MODEL.md` | Done | "Content expressions" |

## Phase 1: Core block editor (MVP)

Done 2026-11-11. CI run for the evidence below: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43090750008
(commit `572eaf9`, all jobs green). Local results are from `bench/results/` on the reference machine
(Windows 10 19045, Chrome 157.0.8103.50, Edge, WebView2 157.0.4341.46). Answers and defaults are in
`DECISIONS.md` (2026-11-11: Phase 1); what changed for users is in `CHANGELOG.md` (0.1.0).

Milestones

- [x] M1.1 Shell, themes, languages. Commit `91a8c83`
- [x] M1.2 Document model and basic blocks. Commit `21042e4`
- [x] M1.3 Slash menu, Markdown shortcuts, bubble toolbar. Commit `21042e4`
- [x] M1.4 Nesting, selection, drag. Commit `21042e4`
- [x] M1.5 The remaining MVP blocks. Commit `21042e4`
- [x] M1.6 Pages and the sidebar. Commits `0016712`, `80406e4`
- [x] M1.7 Local persistence. Commits `847f33f`, `581cf81`
- [x] M1.8 Search. Commit `7ce146d`
- [x] M1.9 Desktop packaging and polish. Commits `987e0ff`, `daf233e`, `19acc65`, `3368731`, `62bd3f2`, `572eaf9`; 0.1.0 in `b179ab3`

Notes

- `f4d29c8` is an incomplete commit of M1.2 to M1.5 (a refused write to `.git/objects` left only
  the removal of `bench/editor/vendor` staged); `21042e4` is the complete one.
- `.gitignore`'s `bin/` kept `crates/cgw-store/src/bin/cgw-store-cli.rs` out of the commits from
  `847f33f` to `7ce146d`; they pass locally but not in CI (run 43051050646 failed at
  `cargo fmt`). `581cf81` adds the file and scopes the rule.
- Other runs that failed, and what fixed them: 43045311528 (`0016712`, e2e races; `80406e4`),
  43070320300 (`b179ab3`, two e2e races on the slower runner; `daf233e`), 43073289097
  (`daf233e`, the kill test hung probing Chrome; `19acc65`), 43078539645 (`19acc65`, the theme
  test sampled outside CI's smaller desktop window; `3368731`), 43083799788 (`3368731`, the kill
  test named the page before its new one opened; `62bd3f2`), 43085875615 (`62bd3f2`, S7 counted the
  image block's own `<img>` as hostile; `572eaf9`). Runs 43043296339, 43043375644,
  43050440631, 43052902043 and 43053120075 were cancelled by later pushes.
- Screen reader: no screen reader was run. The pass is the accessibility tree, checked by e2e
  (named landmarks, a tree with levels and set sizes, a named editor and title, every control
  named, an ARIA snapshot of the tree), with Axe on every main screen. A pass with NVDA or
  Narrator by hand is worth doing before a wider release.
- The installer test ran locally (`bench/results/installer-test.json`): two signed builds,
  install, `cgw-installer-test://` opened the app on its route cold and in the running app (one
  process), update from a local feed to the next version, uninstall with nothing left. It runs
  again in the release workflow on the `v0.1.0` tag.
- In the web kill test one save came 1,119 ms after the last key, in 1,770 pauses (p95 199 ms);
  every other was within a second.
- The updater's private key and its password are only in the repository's secrets (made by
  `scripts/updater-key.mjs`, never written or shown); the public key is in `tauri.conf.json`.
  Without Azure Artifact Signing (`CGW_SIGN_*` unset) the release is signed with a throwaway
  certificate, and its notes say so.

Exit criteria

Each e2e spec runs in Chrome and Edge (`pnpm test:e2e`) and on the built desktop app over CDP
(`pnpm test:e2e:desktop`; narrow screens and Axe are browser-only).

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Create a workspace | Pass | `pages.spec.ts` "creates a workspace, then a second one from the switcher" |
| 2 | Create and organise pages | Pass | `pages.spec.ts` "nests, renames, moves by drag, trashes and restores pages", "favourites, templates and page mentions" |
| 3 | Edit block-based documents | Pass | `editor.spec.ts` "types, splits into blocks and saves", "turns Markdown shortcuts into blocks and marks"; every MVP block is in the Getting started pages, which Axe checks |
| 4 | Slash commands | Pass | `editor.spec.ts` "slash menu inserts blocks, filtered in English and in Arabic", "slash menu in the Arabic interface" |
| 5 | Format text | Pass | `editor.spec.ts` "bubble toolbar formats a selection and edits a link"; the touch toolbar in `narrow.spec.ts` |
| 6 | Drag and reorder blocks, ids unchanged | Pass | `editor.spec.ts` "moves blocks by keyboard and by drag, keeping their ids"; `narrow.spec.ts` "the touch toolbar moves, indents and inserts blocks"; the S1 fuzz on the product's id plugin (`pnpm test`) |
| 7 | Insert images and tables | Pass | `editor.spec.ts` "tables: insert, type across cells with Tab, add a row and a header column", "images: pick a file, then it shows from local bytes with a caption" |
| 8 | Autosave (kill test) | Pass | 1,000 kills while typing on each target, 0 failures. Web (Chrome, IndexedDB): 1,810 saved checks, 445 kills while saving, durable p50 169 ms, p95 199 ms. Desktop (SQLite): 1,784 saved checks, 433 kills while saving, durable p50 171 ms, p95 201 ms, max 269 ms (`kill-web-1000.json`, `kill-desktop-1000.json`). CI runs 25 of each |
| 9 | Open saved documents | Pass | `persistence.spec.ts` "a page and its tree are there after the app starts again" (a new tab; the desktop app started again), "keeps a version and restores it, and the restore can be undone", "exports a workspace and imports it as a new one" |
| 10 | Search pages, Arabic and English | Pass | `search.spec.ts` "finds text in English and Arabic, normalised alike", "keeps the index after a reload and drops pages in the trash", "runs a command from the palette"; FTS5 in the SQLite conformance suite |
| 11 | Dark and light themes | Pass | `themes.spec.ts`: each theme's screenshot read back pixel by pixel (page, sidebar and top bar in that theme's colours, title contrast above 7:1, the themes differing almost everywhere), attached to the report; `smoke.spec.ts`; the desktop smoke sets the window's theme |
| 12 | Arabic and English, RTL | Pass | `arabic.spec.ts` "the Arabic interface is right to left, with no English of its own" (every visible text, label, placeholder and tooltip on ten screens); `smoke.spec.ts`; the S5 checklist in CI |
| 13 | Runs in a browser | Pass | CI: web build, Chrome and Edge e2e, the web kill test |
| 14 | Runs in a Tauri desktop app | Pass | CI: release build, WebView2 smoke, desktop e2e, the desktop kill test; the installer test (notes) |
| | `LocalStore` conformance on both stores | Pass | `describeLocalStore` on memory, IndexedDB (`packages/store-web/src/store.test.ts`) and SQLite through `cgw-store-cli` (`packages/store-desktop/src/store.test.ts`) |
| | Benchmarks within budget | Pass | Below |
| | Axe, keyboard-only and screen-reader passes | Pass; the screen reader by its tree (notes) | `a11y.spec.ts`: Axe (WCAG 2.2 AA rules) on first run, a page with every block, search, the block menu, settings and trash, in light and dark, English and Arabic, and on a phone with the drawer open; "the main tasks can be done with the keyboard alone"; "a screen reader finds named landmarks, a named tree and a named editor" |
| | No stand-in component left unlisted | Pass | Below |

Benchmarks (`bench/phase1.mjs`, gated in CI against the budgets and the last run on `main`)

| Budget | Limit | CI (run 43090750008) | Local |
| --- | --- | --- | --- |
| Open a 200-block page from the store, p95 | 300 ms | 59.2 ms | 77.6 ms |
| Open a 2,000-block page, p95 | 1000 ms | 298.3 ms | 448.6 ms |
| Editor work per keystroke, 200 blocks, p95 (Q19) | 8 ms | 4.6 ms | 5.1 ms |
| Keystroke to the next frame, 200 blocks, p95 (Q19) | 33 ms | 16.7 ms | 20.6 ms |
| Keystroke to the next frame, 5,000 blocks, p95 | 50 ms | 24.5 ms | 48.5 ms |
| Heap with a 5,000-block page open | 150 MB | 36.5 MB | 36.5 MB |
| Sidebar: expand a node of 999 in 10,000 pages, p95 | 100 ms | 17.6 ms | 20.7 ms |
| Search over 10,000 pages, Arabic and English, p95 | 100 ms | 44.5 ms | 61 ms |
| Initial JavaScript, gzip | 350 kB | 150 kB | 150 kB |
| Desktop cold start to an editable page, median | 1500 ms | 842 ms | 1240 ms |
| Edit durable after the last key, web, p95 | 1000 ms | 190 ms | 199 ms |
| Edit durable after the last key, desktop, p95 | 1000 ms | 190 ms | 201 ms |

Local editor work is S6's (`s6-perf.json`); desktop cold start is the median of five starts, from
process start to the first editable page. The first gated run has no run on `main` to compare
with: the regression half of the gate starts with the next one.

Stand-ins waiting on Track U

| Component | Stand-in in | Replaced |
| --- | --- | --- |
| U1 Command menu | `packages/editor/src/ui/SlashMenu.tsx` (slash and mention menus), `packages/shell/src/search/Palette.tsx` | |
| U2 Selection toolbar | `packages/editor/src/ui/BubbleToolbar.tsx`, `TouchToolbar.tsx` | |
| U3 Drag handle, drop indicator | `packages/editor/src/handle.ts`, `ui/BlockMenu.tsx` | |
| U4 `CgTreeView` with drag, rename, virtualisation | `packages/shell/src/sidebar/PageTree.tsx` | |
| U5 Breadcrumb | `packages/shell/src/page/PageHeader.tsx` (`Breadcrumbs`) | |
| U6 Emoji picker and page icons | `packages/shell/src/page/PageHeader.tsx` (`EmojiPicker`) | |
| U8 Block-type icons | glyphs in `packages/editor/src/actions.ts` | |

Defects in `@cashgear/ui` worked around here, for Track U

| Defect | Worked around in |
| --- | --- |
| `CgSplitter`'s pane scrolls as a whole, and its content box has no height to fill | `.cgw-pane` in `packages/shell/src/shell.css` |
| `CgSplitter` names its separator with an English template ("Resize A and B") | `Frame.tsx` sets the name from the catalogue |
| The primary button's white text on the dark theme's accent is 2.5:1 | `shell.css`: dark text there, as the library's own dialog actions use |
| `CgDrawer` refuses a CSS `min()` size | `openSize="20rem"` |

## Phase 2: Cloud document platform

Done 2026-11-12. CI run for the evidence below: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43154795775 (commit `85d92d8`, all jobs green). Local
results are from `bench/results/` on the reference machine (Windows 10 19045, Chrome, Edge, WebView2,
SQL Server LocalDB without full-text, Azurite 3.37.0). Answers and defaults are in `DECISIONS.md`
(2026-11-12: Phase 2); what changed for users is in `CHANGELOG.md` (0.2.0).

Milestones

- [x] M2.1 Server scaffold. Commit `edb52c7`
- [x] M2.2 Identity. Commits `edb52c7`, `3a7ad68` (desktop sign-in), `2ef4837` (the separate review's findings)
- [x] M2.3 Workspaces and metadata sync. Commits `aa269d0`, `2af864f`, `9ba6f67`, `ad601ec`, `b80abb7`
- [x] M2.4 Documents in the cloud. Commits `aa269d0`, `9ba6f67`, `ad601ec`, `537a9b0`
- [x] M2.5 Assets. Commit `aa269d0`
- [x] M2.6 Permissions and sharing. Commits `b084c08`, `ad601ec`, `9ba0e78` (the separate review's findings)
- [x] M2.7 Search and history. Commits `b084c08`, `ad601ec`, `207800e`
- [x] M2.8 Operations. Commits `b084c08`, `7f8f569`, `742200b`; deployment is yours (below)

Notes

- Two reviews, separate from the work, as the plan's risks ask: M2.2 (accounts and sign-in, 13
  findings) and M2.6 (permissions and sharing, 18 findings). Every finding was fixed with a test
  that failed before the fix, or accepted and recorded in `DECISIONS.md` (two: answers that tell an
  id exists across workspaces, which need a guessed random id; and a file id named in a page's
  content making that file readable through it). The worst of them: a web session ended a minute
  after sign-in (the device claim was lost at the security-stamp refresh); any link could sign a
  desktop in without asking; five wrong passwords by anyone signed every desktop out; a member
  could move a shared page into their private section and take its restricted pages with it; a
  removed admin could rejoin with the old invitation.
- The e2e specs against the real stack found four client bugs the unit tests had not: a page's
  first update pushed before the page and set aside on the 404; an upload replacing operations and
  updates written while it ran (the first-run pages of a workspace made while signed in); a guest's
  open of a page writing its meta (refused, and the guest told their changes were kept aside); a
  named version written with edits made after it was named. Each has a test now.
- Full-text search runs only in CI (SQL Server 2022 with full-text in a container); LocalDB here has
  none and takes the `LIKE` path. Both paths are tested (`SearchTests`), and CI requires full-text.
- Under load the worker's validation falls behind, and edits reach other people late, though none is lost: the time from an update's push to others' pulls serving it was, at p95, 0.75 s with 50 people, 1.1 s with 100, 2.4 s with 150 and 26 to 60 s with 200 here (65 s in CI). The cause is lock waits, not CPU: `ValidateJob` holds the workspace row through each page's validation while every request's membership check reads it. No budget measures it and none fails, but the 5-second criterion would not hold at that load. Left to Phase 3 (M3.2, the robust sync loop); its brief says so.
- The load test's author found the worker's Yjs client-id check (Q9) bypassable: an update continuing a client named no client, so a member could write as the owner's client. Fixed in `fc928d1` (the ranges come from the update's blocks), with a Rust test, a fixture made by Yjs and a server test. It also made search's `LIKE` side compare code points (`85d92d8`), which took search at 10,000 pages from 992 ms to about 210 ms on LocalDB.

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| A new user signs up, creates a workspace, and a second device sees an edit within 5 s | Pass | `cloud.spec.ts` "signs up, keeps a workspace in the account, and a second device sees an edit within 5 seconds" (Chrome and Edge; the time is attached to the report: 1.87 s in Chrome and 1.90 s in Edge in CI run 43148561258); `desktop-cloud.spec.ts` "signs in through the browser, syncs a workspace, and a browser sees its pages" (the built desktop app, signing in through the system browser and its loopback listener) |
| A local-only workspace from Phase 1 uploads intact: tree, documents, assets, ids | Pass | `cloud.spec.ts` "a workspace made before signing in uploads intact: tree, documents and ids"; `engine.test.ts` "uploads a local workspace intact, and a second device gets the same tree and documents", "uploads assets of a synced workspace and keeps them when offline"; the store conformance case "an upload keeps operations written while it was prepared" on memory, IndexedDB and SQLite |
| A member with view cannot push; a guest sees only what was shared; another workspace's user gets 404 for every id | Pass | `AuthorizationTests` "Every_role_and_page_level_gets_what_the_rules_say_on_every_page_endpoint" (6 page set-ups × 4 roles × 10 endpoints) and "Every_route_with_an_id_is_404_to_another_workspace_and_401_without_a_session" (a sweep of every route with an id, which fails on a route it does not know); `SharingTests` "A_guest_sees_only_pages_shared_with_them_by_name"; `cloud.spec.ts` "a guest sees only the page shared with them; a view link opens it read-only until withdrawn" |
| An image is unreachable without a fresh signed URL, and a signed URL stops working after its lifetime | Pass | `AssetTests` "A_signed_url_stops_working_after_its_lifetime", "Others_read_an_asset_only_through_a_page_they_can_read", "An_image_uploads_by_signed_url_is_checked_and_reads_by_a_fresh_one"; the container is private (`BlobStore`) |
| Search returns only pages the caller may read, in Arabic and English | Pass | `SearchTests` "Search_returns_only_pages_the_caller_may_read", "Words_are_found_by_their_start_in_titles_and_text_in_arabic_and_english", "A_document_edited_through_the_real_path_is_found_by_its_text", "Full_text_is_used_where_the_server_has_it" (required in CI); `AccessReviewTests` "A_search_cursor_is_sealed_to_its_user_and_workspace" |
| A version can be viewed and restored; the restore is undoable | Pass | `cloud.spec.ts` "a version kept in the account is viewed and restored, and the restore can be undone"; `HistoryTests` "A_version_is_the_page_as_it_was_when_it_was_named", "A_named_version_is_written_by_the_worker_and_read_by_a_signed_url", "A_hard_restore_moves_the_epoch_and_can_itself_be_undone" |
| A restore from backup into a scratch environment opens pages correctly | Pass | `node scripts/deploy-rehearsal.mjs` (`bench/results/deploy-rehearsal.json`): rehearsal and drill pass with the 0.2.0 package (from `85d92d8`): the migration bundle applied to a scratch database, the published API and worker started as Staging, sign-up confirmed by mail and sign-in on the API's page, three pages pushed, checked by the worker and read back, an image checked, a named version written, server search found all three; then the database was backed up and restored under a new name, Blob storage copied, and the restored environment opened every page exactly as written, with its tree and its image (`identical: true`) |
| Unit and integration tests per module against real SQL Server and Azurite | Pass | 148 server tests (`pnpm server:test`), on LocalDB here and on SQL Server 2022 with full-text in CI |
| Contract: the generated client matches the OpenAPI document; every error code has a test | Pass | `pnpm api:check` in `pnpm check` and CI; `ErrorCodeTests` "Every_code_clients_use_is_asserted_by_a_test" (a guard over `Codes.All`) and one test per code no other test reaches |
| Authorisation matrix: role × page level × endpoint | Pass | `AuthorizationTests` (above) |
| Tenant isolation: every entity filtered; cross-workspace requests fail | Pass | `InfraTests` "Tenant_rows_are_invisible_without_a_scope" (fails for a table with `WorkspaceId` and no filter); the 404 sweep above; `SyncTests` "A_non_member_gets_404_for_every_workspace_route" |
| Sync: two clients converge on documents and on the tree; outbox replay after a lost response; 50 concurrent writers on one page | Pass | `engine.test.ts` "carries edits both ways within a pass", "replays the outbox after a lost answer without duplicating anything", "pushes a page's document only once the page itself is on the server"; `SyncTests` "A_second_device_converges_from_the_feed", "A_repeated_batch_is_answered_from_applied_ops"; `DocTests` "Fifty_concurrent_writers_and_no_reader_misses_an_update" |
| Hostile updates (S7's corpus) against the real push path and worker | Pass | `DocTests` "Hostile_updates_are_refused_before_any_other_client_receives_them" (the fixtures from `packages/doc/src/server-fixtures.test.ts`, made by Yjs); `AccessReviewTests` "The_worker_refuses_an_update_whose_pusher_may_no_longer_edit_the_page" |
| Compaction killed at each step | Pass | `DocTests` "Compaction_replaces_the_rows_with_a_snapshot_and_a_crash_at_each_step_loses_nothing" |
| e2e: sign-up to shared page, in the browser and the desktop app | Pass | `cloud.spec.ts` (5 specs, Chrome and Edge) and `desktop-cloud.spec.ts` (the built app), against the server stack Playwright starts (`scripts/server-stack.mjs --e2e`); the Phase 1 specs still pass beside them: 72 browser tests passed and 2 skipped (desktop-only), 0 flaky; 23 desktop tests passed and 5 skipped (browser-only) |
| The security table checked row by row | Pass | Below |
| Benchmarks within budget | Pass | Below |
| Deployed | Yours | The deploy package (`node scripts/server-publish.mjs`), `deploy/iis/install.ps1` and `docs/OPERATIONS.md` are ready and rehearsed on this machine; the answer to the deployment question was "I build, you deploy". The row is ticked when the web app and the API answer at `workspace.cashgearerp.com` and `workspace-api.cashgearerp.com` |

Benchmarks (`bench/phase2.mjs`, gated in CI against the budgets and the last run on `main`)

| Budget | Limit | CI (run 43154795775) | Local |
| --- | --- | --- | --- |
| Push round trip at the server, p95 | 200 ms | 14.7 ms | 8.0 ms |
| Pull of 200 updates, p95 | 300 ms | 9.3 ms | 7.9 ms |
| Change feed, 1,000 changes, p95 | 500 ms | 81.5 ms | 143 ms |
| Search at 10,000 pages, Arabic and English, p95 | 300 ms | 182 ms (full-text) | 211 ms (`LIKE`) |
| Compaction of a 1 MB document, p95 (merge and compact) | 200 ms | 59.2 ms | 195 ms |
| First sync of a 1,000-page workspace, median of 5 | 5 s | 262 ms | 592 ms |
| Load test: 200 people typing for 60 s, updates missed | 0 | 0 of 12,496 (49,984 deliveries checked) | 0 of 20,774 (83,096 checked) |
| Load test: error rate | 0.1 % | 0 % of 57,515 requests | 0 % of 68,813 requests |

The server figures are in process on SQL Server and Azurite, in Release (`server/tests/Cgw.Tests/Phase2Bench.cs`, run by `pnpm bench:phase2 -- --server`); CI's are on a 4-core Linux runner with SQL Server 2022 Developer and full-text search, the local ones on this machine's LocalDB Express (4 cores at most). First sync is the real app in Chrome: from landing back from sign-in to the 1,000 pages in IndexedDB. The load test is 200 people in 5 workspaces, 4 to a page, each making a sync pass every 500 ms while the worker's jobs run beside them; afterwards every update is checked against every reader of its page, and each page rebuilt from scratch. The first gated run has no run on `main` to compare with: the regression half of the gate starts with the next one.

Security (`ARCHITECTURE.md`, Security), row by row

| Row | Checked by |
| --- | --- |
| Authentication | ASP.NET Core Identity and OpenIddict as documented: cookie for the web, PKCE with a loopback listener for the desktop, a consent page before a desktop code; lockout (5 tries, 15 minutes) that slows guessing without signing devices out; per-IP limits on the forms and on the token endpoint. `AccountTests`, `AccountSecurityTests` (22), the M2.2 review |
| Authorisation | Every request decided on the server from membership, role and page level (`Access.cs`); the client's hidden buttons are never the check. `AuthorizationTests`, `TreeAccessTests`, `AccessReviewTests`, the M2.6 review |
| Tenant isolation | Workspace from the route, membership filter, one EF query filter on every tenant table (a test fails for one without it), blob keys under the workspace id, 404 for every id of another workspace (the sweep) |
| Workspace roles | Owner, admin, member, guest; only owners change owners; the last owner protected under the workspace lock (`SyncTests`, `AccessReviewTests`) |
| Page sharing | Access lists with inheritance, restricted pages, private sections; moves and fallbacks never loosen access; share links made by a person, 32 random bytes stored hashed, expiring, revocable, view only, reading the worker's JSON (`SharingTests`, `TreeAccessTests`) |
| No public URLs | Nothing without a session or a link (the 401 sweep); the container private; signed URLs short-lived (`AssetTests`) |
| Attachments | A signed URL for one blob after a permission check; files served as `attachment` with `application/octet-stream`, raster images inline as images (`AssetTests` "Files_download_as_attachments…") |
| Upload safety | Allow-list, 25 MB, the bytes sniffed against the type, SVG never inline, quarantine; the scan hook (`IAssetScanner`) before `ready`, none configured (`AssetTests` "A_file_the_scan_refuses_is_quarantined_and_never_served") |
| XSS | The editor's schema (Phase 1, S7); the worker refuses unknown elements and unsafe link schemes before anyone receives them (`DocTests` hostile updates); the API's pages encode every value and send no script |
| Links | Scheme allow-list in the editor (Phase 1) and in the worker's check |
| Embedded content | Bookmarks are static cards; previews fetched by the server (below); frames from Sheet only (Phase 5) |
| Link previews | The SSRF guard: public addresses only, the connection pinned to the checked address, every redirect checked, 5 s and 1 MB (`AssetTests` "Previews_refuse_private_addresses_even_through_a_redirect") |
| Content Security Policy | The web app's from `apps/web/vite.config.ts`, sent by `vite preview` (so every e2e run is under it) and written into `staticwebapp.config.json`; the desktop's in `tauri.conf.json`; the API pages' own (no script) |
| Tauri | Typed commands only; the sign-in commands talk only to the API bases fixed when the app was built, whatever the page asks; the refresh token never reaches the webview |
| Rate limiting | Per IP on anonymous routes, the sign-in forms and the token endpoint; per user on the rest, tighter on push, search and previews; per page on pushes (`ErrorCodeTests` limit.rate) |
| Audit | Sign-ins and failures, sign-ups, resets, devices signed out, sharing and member changes, exports, permanent deletions, restores, refused updates; with the correlation id (`SharingTests` audit row, `AccountTests`) |
| Token storage | Web: the cookie only (`__Host-` in production). Desktop: Windows Credential Manager. Invitation and link tokens stored hashed |
| Secrets | `scripts/check-secrets.mjs` first in `pnpm check` and in CI (with a self-test); production refuses to start without its required settings and refuses development shortcuts; no key in a file: certificates by thumbprint, Blob by managed identity |
| Transport | HTTPS only on IIS (`install.ps1` binds https), HSTS outside development, `__Host-` cookies |
| Export and deletion | `OperationsTests` (export of what the requester may read, purges, account deletion); deletion on the API's page after the password |
| Backup and restore | The rehearsal's restore drill and the reconcile job (`OperationsTests` "Reconcile_puts_rows_and_blobs_back_in_step_and_can_run_any_time") |
| Dependencies | npm, cargo and NuGet licence gates with a self-test; `cargo deny`; lockfiles committed |

Stand-ins waiting on Track U

| Component | Stand-in in | Replaced |
| --- | --- | --- |
| U7 Avatar and avatar stack | `packages/shell/src/cloud/CloudUi.tsx` (the account button shows the name; members are a list without pictures) | |

## Phase 3: Offline

Done 2026-11-12. CI run for the evidence below: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43230351447
(commit `3a1e9f3`, all jobs green); the Mac's:
https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43230347697 (the same commit), and
run 43198666321 (commit `7df33d5`) for the figures quoted below. Local results are from `bench/results/` on the reference machine (Windows 10 19045,
24 threads, Chrome 157, Edge, WebView2, SQL Server LocalDB, Azurite), the e2e server stack
(`scripts/server-stack.mjs --e2e`) on LocalDB. Answers and defaults are in `DECISIONS.md`
(2026-11-12: Phase 3); what changed for users is in `CHANGELOG.md` (0.3.0).

Milestones

- [x] M3.1 Offline availability. Commits `8759f6a` (store schema 3: pins), `aea77b0` (pins in the engine), `438a624` (the app: offline start, the service worker, Settings → Offline, the marks), `404c610` (the marks read again when the network goes)
- [x] M3.2 Robust sync loop. Commits `aea77b0` (backoff, `Retry-After`, sleep, batches, the feed past its retention, resync), `ef09131` (the server: read-committed snapshot, the sequence lock, retention jobs, the worker's lag)
- [x] M3.3 Conflicts. Commits `aea77b0` (every row, set-aside and recover), `d327665` (the move intent and its notice), `438a624` (notices and recovered pages), `a6e70c7` (pages the account may only view open read-only)
- [x] M3.4 Versions and migrations. Commits `8759f6a` (store 3 on all three stores, fixtures from the released code), `d327665` (document schema 2: `tableOfContents`, migrations on open, read-only for an older build)
- [x] M3.5 Crash and recovery. Commits `d327665` (the state hash), `aea77b0` (repair, quarantine), `ef09131` (`StateHashJob`), `a86dc88` (kill tests during sync, compaction and migration)
- [x] M3.6 macOS. Commits `1231ce5`, `7df33d5`; signing in against the deployed API is yours (below)

Notes

- The worker's lag (Phase 2's note) is gone: with 200 people typing, the time from an update's push to others' pulls serving it is 2.2 s at p95 (it was 26 to 60 s), now gated at 5 s in `bench/phase2.mjs` (`loadVisibleP95`). Validation runs on its own loop, and the database reads with read-committed snapshot, so a membership check no longer waits on a page's validation. On GitHub's 4-core runner the gate first read 3.5 to 5.25 s (one run over); a validation pass there was bound by its database round trips, about 35 ms each under load, not by the Yjs work. `8421700` remembers who may edit between passes, runs the passes back to back under load and cuts the transaction's round trips: CI then read 3.15, 3.53 and 3.50 s in three runs of 43288019365, the worker's own part 2.2 to 2.6 s.
- The convergence simulator found two tree bugs before any test did: a scoped resync dropped a page moved out from under its root on the server (its document and unsent edits set aside though the page still existed); and a trash applied to the subtree as this device saw it, not as the server did, left a page wrong for ever. Both are fixed and scripted (`conflicts.test.ts`, "a trash that races a move out of the subtree").
- The repair path found that the server judged a repair's update as forged when it carried other clients' blocks. The worker now judges an update by what it adds to the server's state (its diff against the state vector), which also lets a device send back what the server lost.
- The proof stream found four bugs, fixed in `2af879b` and `404c610`, each with a test that failed before: the sidebar marked pages opened or made this session "Not available offline" when the network went; a status report that finished after a later one showed "Signed out" for about 200 ms at start; the offline and error status, and danger buttons, failed contrast in the dark theme (undefined colour tokens); the selected row of a page not on this device failed contrast. CI's first run of the specs found a fifth (`3a1e9f3`): opening the trash straight after "Move to trash" landed on "No page is open", because the app went home once the trash was written, whatever was open by then.
- Chrome loses IndexedDB writes it reported committed when only its browser process is ended at once: a page that writes nothing but a counter lost a session's completed transactions in 5 of 70 trials, 1 of 40 with strict durability, 0 of 40 when the whole process tree is ended. The app cannot prevent it, so the web kill tests end the tree, as Phase 1's did; the desktop's SQLite store is killed at once and loses nothing.
- The first long desktop runs came back signed out after 44 of 1,049 kills (nothing typed was lost: the changes waited for a sign-in). Those runs shared one keychain entry with other desktop tests running beside them, which rolled its refresh token from under them. With an entry of each run's own and nothing else running, 220 runs had none (`kill-sync-desktop-100b.json`, `kill-sync-desktop-isolated.json`). One real window remains, accepted: a kill after the server rolls the refresh token and before the keychain holds the new one (or between the entry's two parts) leaves a spent token; started again within 30 s (OpenIddict's reuse leeway) the app signs in as before, later it asks for a sign-in, and its changes wait for it. The window is one token request's round trip, at start and every 15 minutes.
- The v0.2.0 draft release's Windows app talks to `http://127.0.0.1:5280`: `release.yml` did not pass the API's address to the web build (fixed in `1231ce5`). The draft must not be published; 0.3.0's is right.
- An old build meets a migrated page: v0.2.0 opens a version-2 page it has held read-only, sends nothing, and the server's bytes do not change. A version-2 page it never held opens editable until it is reopened; typing there is refused (426) and the server keeps its bytes, so nothing reaches anyone (`old-build.spec.ts` records it). It cannot be fixed in a released build.
- Left for later: a workspace made in the first moment after the app loads, before the first account check answers, stays "On this device only" (seen once in the suite).

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Start, open, edit and create offline; sync on reconnect with no action | Pass | `offline.spec.ts` "offline: the app starts, pinned pages open, edits and a new page are saved, and all syncs on its own" in Chrome, Edge and the built desktop app (in Edge: synced 351 ms after the network returned, the other device had everything at 451 ms); "pages made on this device are not marked "not available offline" when the network goes" (Chrome, Edge and the desktop app); `offline.test.ts` "starts offline with the cached account, says what waits, then syncs with no action" |
| Every conflict row scripted, with its notice | Pass | Metadata and across the models: `packages/workspace/src/sync/conflicts.test.ts` (20 rows, each ending in the stated result and its notice code); inside a page: `packages/editor/src/conflicts.test.ts` "inside a page: every row of the conflict table" (11 rows), "the move notice, measured"; end to end: `offline.spec.ts` "a page edited offline and deleted for good elsewhere comes back as a recovered page" |
| Old build against a migrated document: read-only, nothing pushed, the server's bytes unchanged | Pass | `old-build.spec.ts` "the v0.2.0 build shows a migrated page read-only, sends nothing, and the server keeps its bytes" (Chrome and Edge; v0.2.0's web build from the tag, which is what the v0.2.0 desktop app embeds): the banner, typing changes nothing, no `/doc/updates` or `/doc/repair` request, the state hash and update bytes equal before and after; `migrations.test.ts` "a build that knows only version 1 meets a version-2 page (S2)" |
| 1,000 kills during sync lose nothing reported saved | Pass | `node scripts/kill-test.mjs --sync`, signed in to a synced workspace, the API cut through CDP in some runs and lost while typing in others; every 25 runs and at the end the server's text of the page must equal the device's. Web (Chrome, IndexedDB): 1,000 runs in 60 min, 0 lost, 0 doubled, 162 kills during a request (85 during a push), 171 runs offline and 77 cut while typing, 40 server checks equal, final text 29,026 characters on both sides, durable p50 166 ms, p95 205 ms (`kill-sync-web-1000.json`). Desktop (SQLite): 928 + 100 + 120 runs, 0 lost, 215 kills during a request and 36 server checks equal in the first alone (`kill-sync-desktop-1000.json`, `kill-sync-desktop-100b.json`, `kill-sync-desktop-isolated.json`). Compaction: killed during it 28 times on the web (26 found committed after the reopen, 1 rolled back) and 15 on the desktop (all committed), 0 lost (`kill-compaction-web.json`, `kill-sync-web-1000.json`, `kill-compaction-desktop.json`). Store migration: 200 kills over the v1 and v2 fixtures (39 before the copy, 94 during it, 37 after it before the commit, 30 after); after each kill the store gave the release's exact answers (6,811 reads, 0 differences; in 13 runs the copy was seen too late to check read by read), the `workspace.v{n}.db` copy matched the old file byte for byte, and the app opened the folder all 200 times (`kill-migration-200.json`). CI runs 25 of each and 10 migration kills (in the evidence run: 0 failures, the server's text equal to the device's on both targets, 375 reads checked after the migration kills) |
| Three-client convergence simulator in CI | Pass | `packages/doc/src/sync-sim/convergence.test.ts`: three clients, random partitions, loss, duplication and reordering, on documents and the tree together; 4 seeds of 40 rounds in every `pnpm test` and CI run; locally 60 seeds of 200 rounds (about 590 updates, 260 operations and 350 faults a seed) and 8 seeds of 800, all converged |
| Access granted and revoked while offline | Pass | `conflicts.test.ts` "access granted and revoked while a device is offline" (granted; revoked; granted then revoked and revoked then granted), "edit access removed while offline", "read access removed too"; `AccessReviewTests` "The_worker_refuses_an_update_whose_pusher_may_no_longer_edit_the_page"; `viewonly.spec.ts` "a page shared to view opens read-only and switches when edit is given" |
| Store and document migrations from every earlier version | Pass | SQLite: `migrates_every_earlier_store_with_all_it_held` over stores written by the v0.1.0 and v0.2.0 builds (`crates/cgw-store/tests/fixtures`), `a_migration_that_fails_leaves_the_store_as_it_was`, `refuses_a_store_from_a_newer_version`; IndexedDB: "opens a version-1 store at version 3 with all it held", "opens a version-2 store at version 3 with all it held, sync state included", "refuses a store a newer version wrote, and leaves it as it was"; documents: `migrations.test.ts` (the version-1 fixture holding every block kind, "runs when a page opens with edit rights, is saved like an edit, and loses nothing", "two devices migrating at once converge on version 2 with the content untouched", "does not run for someone who may only read the page") |
| macOS app installs, signs in, edits offline, syncs | Installs and edits offline: pass on the runner. Signs in and syncs: yours, once the API is deployed | Run 43198666321 (`macos.yml`, `scripts/macos-acceptance.mjs` through the test-only bridge, `bench/results/macos-acceptance.json`): installed from the DMG (codesign passes); started with no server reachable, a workspace and a page made and typed into, kept across a restart and across ⌘Q straight after typing, a second page made offline; a `cashgear-workspace://` link opened this copy, cold and running; the native sign-in (PKCE, the loopback listener) against a stand-in token endpoint kept the refresh token in the login keychain in two parts, refreshed with exactly it after a restart, and removed it on sign-out; the update from 0.2.0 to 0.2.1 through a local feed took 2.8 s, restarted and kept every page. The release-shaped universal build passed its checks (both architectures, the bridge absent). Signing in on the real API's page and syncing is in the same run, skipped until `CGW_MACOS_API_BASE`, `CGW_MACOS_TEST_EMAIL` and `CGW_MACOS_TEST_PASSWORD` name the deployed API. Signed and notarised once the `APPLE_*` secrets exist |
| Benchmarks within budget | Pass | Below |

Benchmarks (`bench/phase3.mjs`, gated in CI against the budgets and the last run on `main`)

| Budget | Limit | CI (run 43230351447) | Local |
| --- | --- | --- | --- |
| Reconnect with 1,000 waiting updates across 50 pages | 30 s | 2.3 s | 3.4 s |
| Cold start offline (desktop, median of 5) | the online budget, 1,500 ms | 877 ms (online 910 ms) | 1,271 ms (online 1,277 ms) |
| Pin a 500-page subtree | 2 min | 8.8 s | 11.4 s |
| Typing while it pins: keystroke to next frame, p95 | 33 ms | 17.1 ms | 20.4 ms |
| Local store for 1,000 cached pages | tracked | 3.6 MB of IndexedDB, 1.3 MB of it documents | 3.6 MB of IndexedDB, 1.2 MB of it documents |

The workspace is made through the API as a client makes one (1,000 pages in two subtrees, and a
page of 200 blocks), validated by the worker before anything is timed; then a fresh Chrome profile
signs in. The 1,000 updates are made in the real app while offline (20 saved edits on each of 50
pages, each save one update, as autosave makes them); the time is from the network's return to
"Synced", after which the server's text of each page must hold its last word. Pinning is the first
subtree pinned from its page menu while a key is typed into the open 200-block page every 35 ms,
until all 500 pages are on the device. Cold start offline is the built desktop app, signed in with
a synced workspace, started five times with no server answering (its window's and its native
side's requests through a proxy that is not there): process start to the first editable page,
measured the same way as Phase 1's cold start online beside it. CI's figures are from GitHub's 4-thread Windows runner. This run was the first
with Phase 3's figures, so it had no earlier run on `main` to compare with: the regression half of
the gate starts with the next one.

## Phase 4: Workspace databases

Done 2026-11-14. CI run for the evidence below: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43534259613
(commit `c37a2bd`, all jobs green); the Mac's: https://github.com/MohamedSadat/cashgear-workspace/actions/runs/43534259587
(the same commit). Local results are from
`bench/results/` on the reference machine (Windows 10 19045, 24 threads, Chrome 157, Edge,
WebView2, SQL Server LocalDB, Azurite), the e2e server stack (`scripts/server-stack.mjs --e2e`)
on LocalDB. Answers and defaults are in `DECISIONS.md` (2026-11-12: Phase 4); what changed for
users is in `CHANGELOG.md` (0.4.0).

Milestones

- [x] M4.1 Model and sync. Commit `d357113` (store schema 4 on memory, IndexedDB and SQLite; the
      operations; the server's tables, operations, feed and tree; document schema 3; holds, row
      fetches and row documents in the engine), `7300ad6` (assets before operations)
- [x] M4.2 Table view and property editing. Commits `d357113`, `7782516` (tab clicks), `7300ad6`
      (menus, focus, the database page's scroll, a cell edit before the store answers)
- [x] M4.3 Filter, sort, group. Commit `d357113` (one definition in TypeScript and C#, held by
      `db-query-vectors.json`; the server's in-memory query engine, keyset paged)
- [x] M4.4 Board and list views. Commit `d357113`
- [x] M4.5 Calendar and gallery views. Commit `d357113`
- [x] M4.6 Formula, relation, rollup. Commit `d357113` (Q14: our own language in TypeScript and
      C#, `db-formula-vectors.json` and `db-compute-vectors.json`)
- [x] M4.7 Templates and import. Commits `d357113` (database and row templates, CSV both ways on
      the device and through the server's routes, export format 2), `7782516`

Notes

- The work ran as nine streams in one checkout (core rules, stores, server, document and editor,
  sync engine, table, other views, shell, then polish and proof), each to a written contract; the
  layers interlock, so the feature is one commit (`d357113`) with the fixes after it.
- The convergence simulator found two bugs no test had: a refused operation's answer carries only
  its own entity while the planner had changed others with it (reverse relations, converted rows,
  reverse properties), and a feed record waiting behind an operation whose answer carries another
  record was dropped (this one older than Phase 4: a page renamed elsewhere stayed stale while a
  visit to it waited). Both are fixed and scripted.
- The proof found ten bugs, each fixed with a test that failed before (`7300ad6`): among them a
  file added to a row lost because its operation reached the server first, a database's own page
  scrolling at 4.5 frames a second at 50,000 rows, a cell edit shown only after IndexedDB
  committed, menus cut off at the window's edge (class names shared with the shell's stylesheet),
  and four Axe findings. The polish stream fixed eight findings of the streams (`7782516`), among
  them mouse clicks on view tabs (`CgTabs` with `reorderable`, below).
- The load gate after Phase 4's changes to access and the feed: `loadVisibleP95` 2.26 s locally,
  2.81 s and 3.26 s on CI (runs 43331388381 and 43336521393), under 5 s. Phase 2's compaction
  budget read 220 ms locally against 200 (195 ms at Phase 2 on this machine; no compaction code
  changed; CI reads 61.6 ms).
- CI runs that failed, and what fixed them: 43331388381 (`d357113`) and 43336521393 (`7782516`), three
  earlier specs that did not know databases (the tree snapshot, "CSV" in Arabic, the old build
  expecting the schema version it knew; `fb38c06`); 43422682011 (`8f8c885`), the desktop's narrower
  window left a column undrawn where the spec looked (`003a8c1`); 43527509783 (`003a8c1`), Phase 3's
  benchmark pushed version-3 documents as a version-2 client's and the worker refused them
  (`c37a2bd`).
- Track S1 and S2 (Q15) were built in their own session in `cashgear-sheet` (commits
  `b8a2a42..95fc04d`, Sheet CI run 43316697418 green); the contract as built is for Phase 5.
- Left for later: a share link shows a note where a database is, not its rows; cell copy and
  paste and multi-cell selection; a server date-range query for large calendars; dragging board
  columns and gallery cards; a screen-reader pass on the grid (Axe only); pins hold databases'
  rows, not every row's document.

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Every first-release property type in all five views, both languages | Pass | `database.spec.ts` "a database with every property type is made, edited and shown in all five views, in English and Arabic" (Chrome, Edge, desktop): 20 properties (text, number, date, checkbox, select, multi-select, status, person, URL, email, phone, files, relation with its reverse, rollup, formula, created and edited time and by) set on a row's page in a synced workspace; the table (scrolled across), board, list, calendar and gallery each show the values; again in Arabic; the server's row holds the values and its computed results. `database-rtl.spec.ts` (Chrome, Edge, desktop): the board right to left, a card dragged by `page.mouse` to another column takes its status; the calendar's week from Saturday on the right, a row dragged two days on takes that date. `a11y.spec.ts` "Axe finds nothing on the database screens" (table, board, list, calendar, gallery, the filter panel, a property menu, a row page; light and dark, English and Arabic). Also in `database.spec.ts`: filter, sort and group; a row as a page; an inline database and a linked view; database and row templates; CSV in and out; rows trashed and restored |
| Offline edits on two devices follow the per-property rule | Pass | `database-sync.spec.ts` "a database reaches a second device, and offline edits on two devices follow the per-property rule" (Chrome, Edge, desktop): both devices offline, one sets Status and Priority, the other Notes and Priority; online in turn, Status and Notes both stand and Priority is the last to reach the server's, on both devices and the server, its version risen. `packages/workspace/src/sync/conflicts.test.ts` (15 database rows: the same and different properties, a type change racing an offline edit, a property or option deleted while edited, relations, refusals); the convergence simulator with databases, views and rows (4 seeds of 40 rounds in CI; 100 seeds of 200 rounds locally, all converged) |
| Client and server give the same rows for the same filter and sort | Pass | `db-query-vectors.json` (150 cases) run by `packages/workspace/src/db/vectors.test.ts` and the server's `DatabaseVectorTests`, with the conversion (263), formula (279), compute (31) and CSV (63) vectors; end to end, `database-sync.spec.ts` "the same filter and sort give the same rows here and on the server": a view with a filter and two sorts on 200 rows, the table's rows in order equal `POST /databases/{id}/query` with the view |
| 50,000-row database within budget | Pass | Below. End to end, `database-sync.spec.ts` "over 5,000 rows…": 6,000 rows imported through the server's route, the table paged by the server's query, a server sort and search, only the window's rows drawn, offline the rows on the device with its notice, the view exported by the server's route |
| Deleting a property or option never corrupts rows | Pass | `database.spec.ts` "deleting a property or an option never corrupts a row" (Chrome, Edge, desktop): an option deleted reads empty, a property deleted is hidden, the server's row values are unchanged after both, the property restored shows its value again; `DatabaseTests` (the server never rewrites a row on either); `conflicts.test.ts` (deleted while edited on another device) |

Also: `old-build.spec.ts` "the v0.3.0 build shows a page with a database read-only, sends
nothing, and never sees rows" (Chrome, Edge), beside v0.2.0's case: a schema-3 page opens
read-only with the block as a placeholder, the database page is a page, no row reaches the old
build, it sends no document update and no operation but visits, and the server's state hash and
bytes are unchanged. Store migrations from v1, v2 and v3 (`crates/cgw-store/tests/fixtures/v3`
written by the v0.3.0 code; IndexedDB from version 3), killed at every moment
(`scripts/kill-migration.mjs`: 36 runs locally, 0 failures, 1,718 reads equal to the releases').

Benchmarks (`bench/phase4.mjs`, gated in CI against the budgets and the last run on `main`)

| Budget | Limit | CI | Local |
| --- | --- | --- | --- |
| First rows of a 50,000-row database (median of 5 opens after the first) | 500 ms | 74.1 ms | 154.5 ms |
| First open (the server fills its query cache) | tracked | 1,514 ms | 2,396 ms |
| Scrolling 50,000 rows: frame interval p95 (60 frames a second) | 17.5 ms | 16.7 ms (60 fps) | 16.8 ms |
| Server query, 50,000 rows, one filter and one sort, p95 | 300 ms | 240.2 ms (SQL Server, Linux) | 268.4 ms (LocalDB) |
| Board drag: frame interval p95 | 17.5 ms | 16.8 ms | 16.8 ms |
| Cell edit, local (Enter to the cell showing the value), p95 | 16 ms | 6.1 ms web, 6.0 ms desktop | 14.9 ms web, 13.3 ms desktop |
| Cell edit to the next frame, p95 (two frames, as Q19) | 33 ms | 13.9 ms web, 9.6 ms desktop | 21.3 ms web, 19.9 ms desktop |
| Cell edit durable, p95 | 1 s | 15.8 ms web, 11.7 ms desktop | 24.4 ms web, 28 ms desktop |
| Import of 50,000 rows through the route | tracked | 14.4 s | 11.1 s |

The browser and desktop figures are the real app over the e2e server stack, the database seeded
through the import route; the server query is `Phase4Bench` in process (CI: the Linux server job
on SQL Server). This run was the first with Phase 4's figures, so it had no earlier run on `main`
to compare with: the regression half of the gate starts with the next one.

Stand-ins waiting on Track U

| Component | Stand-in in | Replaced |
| --- | --- | --- |
| A tag box with creatable options and per-option actions (rename, recolour, regroup, reorder, delete), grouped and single choice | `packages/database/src/pickers/OptionPicker.tsx` | |
| A tag box with caller-drawn chips and caller-supplied results | `packages/database/src/pickers/ListPicker.tsx` | |
| A menu surface holding inputs and switches, with panels | `packages/database/src/properties/MenuList.tsx` | |
| A sortable list (handle, arrows) | `packages/database/src/pickers/reorder.ts` | |
| A text and number editor that keeps no React draft | plain inputs in `packages/database/src/cells/` | |
| A pointer drag-and-drop helper with a drag copy and edge scrolling | `packages/database/src/views/board/drag.ts` | |
| A live-region announcer | `Live` in `packages/database/src/views/board/shared.tsx` | |
| A kanban board | `packages/database/src/views/board/` | |
| A month calendar that takes zero-length items and inclusive ends, without its own editor (`CgScheduler` assessed) | `packages/database/src/views/calendar/` | |
| A file picker that only gives the file | the import dialog's `<input type="file">` (`packages/database/src/csv/`) | |

Defects in `@cashgear/ui` worked around here, for Track U

| Defect | Worked around in |
| --- | --- |
| `CgTabs` with `reorderable` captures the pointer on the tab's wrapper, so a mouse click never selects a tab | `packages/database/src/DatabaseView.tsx` takes the wrapper's click |
| `CgFlyout` drops an explicit `width` (its positioned overlay spreads `width: undefined` over it) | `packages/database/src/cells/CellFlyout.tsx` passes it in `style` |
| `CgFlyout` mounted `open` is not reliably focused through `onAfterOpen` | `CellFlyout.tsx` focuses its first control a frame after mount |
| `CgFlyout` with an element anchor watches the whole document while mounted, even closed | flyouts mounted only while open |
| `CgButton appearance="soft"` with the neutral intent draws a nearly invisible label | `outline` or `ghost` instead |

## Phase 5: Cash Gear ecosystem

Milestones

- [ ] M5.1 Contracts and mocks
- [ ] M5.2 Workbooks as documents
- [ ] M5.3 Sheet block, stage 5a
- [ ] M5.4 Sheet block, stage 5b
- [ ] M5.5 Sheet block, stage 5c
- [ ] M5.6 ERP link and session
- [ ] M5.7 ERP view block

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Insert, preview, open in Sheet, save, refresh | | |
| No preview without access to the workbook | | |
| Stored picture offline | | |
| ERP block respects the user's privileges | | |
| No ERP data in any Workspace store after viewing | | |
| Origins off the allow-list cannot drive either integration | | |
| Contract suites pass against the real Sheet and ERP | | |

## Phase 6: Collaboration

Milestones

- [ ] M6.1 Hub
- [ ] M6.2 Presence
- [ ] M6.3 Live metadata
- [ ] M6.4 Comments
- [ ] M6.5 Mentions and notifications
- [ ] M6.6 Load and failure

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Two users in one paragraph converge within 300 ms | | |
| Editing continues over HTTP with the socket blocked | | |
| App-pool recycle loses no edit | | |
| Revoked access stops updates within 60 s | | |
| Comments stay on their block through moves and edits | | |
| Load test | | |

## Phase 7: Editable ERP blocks, plugins, AI

Milestones

- [ ] M7.1 Editable ERP blocks
- [ ] M7.2 Plugin blocks
- [ ] M7.3 AI foundation
- [ ] M7.4 AI features

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| ERP edits written only after review and commit, audited, conflicts shown | | |
| No commit without the edit privilege, by any request | | |
| A plugin block survives a build without the plugin | | |
| AI off sends nothing; AI on sends only readable content; output enters on accept | | |
| No AI path reaches `Commit` | | |

## Track U: `CashGear.React.UI`

- [ ] U1 Command menu
- [ ] U2 Selection toolbar
- [ ] U3 Drag handle, drop indicator, drag-and-drop helper
- [ ] U4 `CgTreeView`: drag-and-drop, inline rename, virtualisation, lazy children
- [ ] U5 Breadcrumb
- [ ] U6 Emoji picker and page icons
- [ ] U7 Avatar and avatar stack
- [ ] U8 Block-type icons

## Track S: Cash Gear Sheet

- [x] S1 Cloud platform: open by ticket, save with `If-Match` (Sheet commits `b8a2a42..95fc04d`, its CI run 43316697418; against a mock of Workspace's routes, which Phase 5 builds)
- [x] S2 `/cloud` launch route (the same commits)
- [ ] S3 `/embed` route and `sheet-embed.1`
- [ ] S4 Preview pictures and chart views
- [ ] S5 Shared contract suite

## Track E: Cash Gear ERP

- [ ] E1 App session with an audience and connectors
- [ ] E2 Workspace link
- [ ] E3 Connect flow in the ERP client
- [ ] E4 Read-only connectors
- [ ] E5 Rate limiting and CORS on the connect routes
- [ ] E6 Editable connectors and audit
- [ ] E7 Contract suite against UnifiedAPI
