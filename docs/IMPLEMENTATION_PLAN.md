# Cash Gear Workspace: implementation plan

> Approved for planning on 2026-11-11. No phase starts until you say so.

## Context

Cash Gear Workspace is a Notion-style workspace for the Cash Gear ecosystem: block documents, a
page tree, databases, embedded sheets and ERP data, in the browser and as a Tauri desktop app.
The design is in `ARCHITECTURE.md`, `DATA_MODEL.md`, `SYNC_DESIGN.md` and `INTEGRATIONS.md`; the
reasons are in `DECISIONS.md`; what is done is in `PROGRESS.md`.

The plan is written for coding agents. Each phase is split into milestones that one session can
build and prove. Every milestone ends with the app running and its checks green.

## Working rules

These are the rules cashgear-sheet works by.

- **`main` only.** All work is committed and pushed to `main`. No branches, worktrees or pull
  requests. Small Conventional Commits scoped by package or crate, for example
  `feat(editor): slash menu`. Every commit builds and passes the standing checks.
- **One phase at a time.** At the start of a phase: read this plan, `PROGRESS.md` and
  `DECISIONS.md`; ask all of the phase's questions in one batch, recommended option first; wait
  for the answers; log them with the date in `DECISIONS.md`.
- **Small choices are made and logged** under "Defaults picked". Anything expensive to reverse
  stops for a question.
- **End of a phase.** Record evidence for each exit criterion in `PROGRESS.md` (a CI run, a
  measurement, a test name). Commit, push, tag `phase-N`. From Phase 1 each phase is also a
  release: a `CHANGELOG.md` section, one version bumped everywhere, tag `v0.N.0`. Report, then
  show a card that starts the next phase in a new session.
- **Other repos are tracks.** Work in `CashGear.React.UI`, `cashgear-sheet` or the ERP is listed
  under Tracks U, S and E. It is proposed, agreed and done in that repo, never from a session in
  this one without your say-so.
- **No invented paths.** Package names in this plan are proposals. The phase that creates a
  package decides its files and records the layout in `CLAUDE.md`.

### Hard limits

- Nothing shipped under GPL, AGPL, LGPL, SSPL or BUSL. The licence gate runs in CI.
- The editor never saves, loads or calls the network. The workspace layer never looks inside a
  document. (`ARCHITECTURE.md`, dependency rules.)
- A client never drops document content it does not understand.
- Block ids never change and are never minted in response to a remote change.
- Schema content expressions use `*` only; new attributes are optional with defaults.
- The API process loads no Yjs library.
- No ERP data is written to a document, a local store or a Workspace table.
- No credential in `localStorage`, in a file, or in the repo.
- Nothing is reachable without a session or a share link a person created.
- A missing generic component is built in `CashGear.React.UI` and used by bumping the pinned
  commit, not built here.

### Standing checks

Phase 0 creates one command per check and one that runs them all; `CLAUDE.md` lists them. Every
commit passes: format, lint (zero warnings), typecheck, unit tests, Rust `fmt`, `clippy` and
tests, the licence gate, and from Phase 2 the .NET build and tests. End-to-end tests and
benchmarks run in CI on every push to `main`.

## Phases at a glance

| Phase | Outcome | Release |
| --- | --- | --- |
| 0 | Scaffold, CI, and the spikes that could change the architecture | `phase-0` |
| 1 | **MVP**: a complete local block editor and page tree, in the browser and in Tauri | `v0.1.0` |
| 2 | Accounts, cloud storage and sync while online, sharing, search, history | `v0.2.0` |
| 3 | Offline: pinned pages, conflicts, recovery; macOS build | `v0.3.0` |
| 4 | Workspace databases and their views | `v0.4.0` |
| 5 | Sheet embeds and read-only ERP blocks | `v0.5.0` |
| 6 | Real-time editing, presence, comments, mentions | `v0.6.0` |
| 7 | Editable ERP blocks, plugin blocks, optional AI | `v0.7.0` |

Changes from the brief's suggested phases, and why:

- Tauri packaging and the SQLite store move into Phase 1, because the MVP must run on the desktop
  and is local-first.
- "Desktop and offline" becomes "Offline" (Phase 3): the desktop app already exists by then.
- Collaboration (Phase 6) ships alone; ERP editing, plugins and AI move to Phase 7.

## Track U: missing components in `CashGear.React.UI`

Built in that repo, to its rules (one folder per component, logical CSS, Arabic labels, stories,
Axe). Each is needed by the milestone named.

| # | Component | Needed by |
| --- | --- | --- |
| U1 | Command menu: filtered, grouped list anchored to a point, full keyboard | M1.3 |
| U2 | Selection toolbar: a `CgToolbar` in a `CgFlyout` that follows a rectangle | M1.3 |
| U3 | Drag handle and drop indicator; a small pointer-and-keyboard drag-and-drop helper | M1.4 |
| U4 | `CgTreeView`: drag-and-drop, inline rename, virtualisation, lazy children | M1.6 |
| U5 | Breadcrumb with overflow | M1.6 |
| U6 | Emoji picker (data set licence checked) and page-icon set | M1.6 |
| U7 | Avatar and avatar stack | M2.2 |
| U8 | Block-type icons added to `CgIcon` | M1.3 |

Until a component lands, the milestone uses a local stand-in behind the same props and replaces
it when the pin moves. Stand-ins are listed in `PROGRESS.md` so none is forgotten.

## Track S: Cash Gear Sheet

Listed in `INTEGRATIONS.md`: S1 cloud platform, S2 `/cloud` launch route, S3 `/embed` route,
S4 preview pictures and charts, S5 the shared contract suite. Needed by Phase 5; S1 should start
during Phase 4.

## Track E: Cash Gear ERP

Listed in `INTEGRATIONS.md`: E1 app session with an audience, E2 workspace link, E3 connect flow
in the ERP client, E4 read-only connectors, E5 rate limiting and CORS, E6 editable connectors,
E7 the contract suite. E1 to E5 are needed by Phase 5; E6 by Phase 7.

---

## Phase 0: Scaffold and spikes

**Goals**

- A repo that builds, tests and gates licences in CI, shaped like Sheet's.
- Evidence for or against each risky decision before any feature depends on it.

**Dependencies**

- Read access to `cashgear-sheet` (template) and `CashGear.React.UI`.
- Nothing from the ERP.

**Questions for you (one batch)**

- Q1 to Q4 in `DECISIONS.md`, each answered by a spike's result.
- Q12: code signing for the desktop app.

**Tasks**

*M0.1 Scaffold*

- [ ] pnpm workspace, Cargo workspace, root configs copied from Sheet and renamed (`tsconfig`,
      ESLint, Prettier, `.npmrc`, `.node-version`, `rust-toolchain.toml`, `deny.toml`,
      `license-policy.json`, Vitest, Playwright).
- [ ] `apps/web`: a Vite React app that renders one `@cashgear/ui` component in light, dark,
      English and Arabic.
- [ ] `apps/desktop`: the Tauri 2 shell showing the same page; CSP as in `ARCHITECTURE.md`.
- [ ] CI workflow: the standing checks, the web build, the desktop build and a smoke test.
- [ ] Licence gate scripts and third-party notices, copied from Sheet.
- [ ] `CLAUDE.md` updated with the real layout and commands.

*M0.2 Spike S1: block schema and block ids under collaboration*

- [ ] A throwaway editor with the container schema, the id plugin and Yjs.
- [ ] A fuzz harness: two and three clients, 10,000 random operations (type, split, merge, move,
      paste, duplicate, indent, convert), random delivery order, offline merges.
- [ ] Record the content expression that survives, in `DATA_MODEL.md`.

*M0.3 Spike S2: old client meets a newer document*

- [ ] Two builds of the throwaway editor whose schemas differ by one node type.
- [ ] Prove the gate: the old build opens read-only and pushes nothing.

*M0.4 Spikes S3 and S4: Yjs on the server*

- [ ] `crates/cgw-ydoc`: merge updates, state vector from an update, diff, compact with garbage
      collection, document to JSON and to plain text, list of client-id ranges in an update.
      Bytes in, bytes out; errors returned, never a panic across the boundary.
- [ ] Called from a .NET console test by P/Invoke on Windows x64.
- [ ] S4: the same suite against YDotNet, plus a 24-hour soak, only if S3 fails or is marginal.

*M0.5 Spike S5: RTL and Arabic input*

- [ ] A scripted checklist in Chrome and WebView2: mixed paragraphs, lists, tables, the block
      handle, selection across directions, the Arabic IME, caret movement with arrows.

*M0.6 Spike S6: performance*

- [ ] The document generator (Arabic, English, mixed; block mix; size).
- [ ] Measure every editor budget in `ARCHITECTURE.md` at 200, 2,000 and 5,000 blocks.

*M0.7 Spikes S7, S8, S9*

- [ ] S7: a corpus of hostile updates (forged client ids, oversized, malformed, `javascript:`
      links, script-bearing attributes) against the throwaway editor and `cgw-ydoc`.
- [ ] S8: a minimal .NET harness and SQL Server: sequence assignment under a page-row lock with
      50 concurrent writers.
- [ ] S9: a static page embedding Sheet's deployed web app in a sandboxed iframe, in Chrome and
      WebView2, to see what cross-origin isolation requires.

*M0.8 Close*

- [ ] Each spike's result and the decision it confirms or changes, in `DECISIONS.md`.
- [ ] Spike code deleted or moved under `bench/`; nothing throwaway ships.

**Files and modules**

Root configs; `apps/web`; `apps/desktop`; `crates/cgw-ydoc`; `bench/`; `scripts/`;
`.github/workflows/`. Spike code lives under `bench/spikes/` until M0.8.

**API contracts**

None. `cgw-ydoc`'s function list is recorded as the worker's future interface.

**Database changes**

None. S8 uses a scratch database.

**Acceptance criteria**

| Spike | Pass | Fail means |
| --- | --- | --- |
| S1 | No duplicate ids after quiescence; ids never change on a move; no caret jump when a peer types in the same paragraph | Change the schema or the binding before Phase 1 |
| S2 | Old build opens read-only; the document's bytes are identical afterwards | No release until fixed; it is a data-loss path |
| S3 | Output loads in Yjs 13 with identical JSON across 1,000 fuzzed documents; malformed input returns an error; a 1 MB document compacts in under 200 ms | Use YDotNet (S4), worker only |
| S4 | Same suite; flat memory over 24 hours | Compile `cgw-ydoc` to WASI and run it under Wasmtime |
| S5 | Every item on the checklist correct | A ProseMirror-level fix is needed; stop and ask |
| S6 | All budgets met at 2,000 blocks; 5,000 usable | Lighter node views; revisit the 5,000 target |
| S7 | Everything rejected or drawn inert; no script runs | Fix before Phase 2 |
| S8 | No reader ever misses an update with repair switched off | Change the sequence design |
| S9 | The embed draws a range inside the iframe | Phase 5 uses the stored picture only until Sheet changes |

**Automated tests**

- The fuzz harnesses from S1, S3 and S7 are kept and run in CI from here on.
- The scaffold's smoke tests: the web page renders; the desktop app starts.

**Performance benchmarks**

S6's measurements become the first rows of the benchmark history.

**Risks**

- A spike fails late. Each is time-boxed to one session; a failure is a result, recorded, and
  the plan changes before Phase 1.
- Tiptap's binding has open caret issues (see `DECISIONS.md`). S1 measures them.

**Definition of done**

- CI is green on `main` with all standing checks.
- Every spike has a recorded result and Q1 to Q4 have answers.
- `DATA_MODEL.md` holds the final content expressions.
- Tag `phase-0`. A card for Phase 1 is shown.

---

## Phase 1: Core block editor (MVP)

**Goals**

A complete standalone editor with no account: create a workspace, organise pages, edit blocks,
slash commands, formatting, drag and reorder, images and tables, autosave, reopen, search, light
and dark, Arabic and English, in the browser and in the Tauri app.

**Dependencies**

- Phase 0 passed, with its decisions recorded.
- Track U1 to U6 and U8 (stand-ins allowed).

**Questions for you (one batch)**

- The MVP's block list: confirm bookmark shows the URL only, and that sheet, ERP and database
  blocks are absent until their phases.
- Export format in the MVP (default: zip of Markdown, JSON and assets).
- Desktop file association and deep-link scheme (default: `cashgear-workspace://`, no file type).
- The first-run content (default: one "Getting started" page in each language).

**Tasks**

*M1.1 Shell, themes, languages*

- [ ] `@cgw/shell`: app frame with a resizable, collapsible sidebar, top bar, routing by page id.
- [ ] Theme controller (light, dark, system) and the window's title-bar theme on the desktop.
- [ ] i18next with `en` and `ar`; `dir` on `<html>`; a language switch; a lint rule against
      untranslated UI strings.
- [ ] The platform interface with web and desktop implementations.
- [ ] The command registry and the shortcut map through `event.code`.

*M1.2 Document model and basic blocks*

- [ ] `@cgw/doc`: the schema for paragraph, headings, list items, checklist, quote, divider; the
      id plugin; the Yjs seam; plain-text and Markdown output; the schema-version check.
- [ ] `@cgw/editor`: the editor component over a given `Y.Doc`; plain DOM node views.
- [ ] Marks: bold, italic, underline, strike, code, link with the scheme allow-list.
- [ ] Undo and redo through Yjs.
- [ ] The `dir` attribute and direction from the first strong character.

*M1.3 Slash menu, Markdown shortcuts, bubble toolbar*

- [ ] Slash menu from the command registry, filtered, with keywords in both languages.
- [ ] Input rules for the Markdown shortcuts listed in `ARCHITECTURE.md`.
- [ ] Bubble toolbar on text selection; link editing; text colour and highlight as tokens.
- [ ] "Turn into" between all text block kinds, keeping id, text and children.

*M1.4 Nesting, selection, drag*

- [ ] Indent and outdent; children under any block; toggle with per-device open state.
- [ ] Block selection (Esc), multi-block selection, delete, duplicate, move by keyboard.
- [ ] The block handle and drag to reorder and to nest, with a drop indicator; a move keeps ids.
- [ ] Copy, cut and paste: our format, HTML through the schema parser, Markdown, plain text;
      pasted blocks get new ids.

*M1.5 The remaining MVP blocks*

- [ ] Callout, code block (language, wrap, no marks), numbered list numbering when drawn.
- [ ] Table: insert, add and remove rows and columns, header row and column, column widths,
      cell navigation by Tab and arrows.
- [ ] Image: paste, drop and pick; stored locally; width, alignment, alt text, caption.
- [ ] File attachment: stored locally; name and size from the asset record.
- [ ] Bookmark (URL card) and child-page block.

*M1.6 Pages and the sidebar*

- [ ] `@cgw/workspace`: the page tree, order keys (in-house fractional index with test vectors),
      operations applied to a local mirror, tree rules.
- [ ] Sidebar: sections, nested pages, create, rename in place, move by drag, favourites, recent.
- [ ] Breadcrumbs; page icon (emoji) and cover image; page links and mentions.
- [ ] Trash: delete with descendants, restore, delete for good; retention.
- [ ] Page templates: mark a page as a template; "New from template" copies it with new ids.

*M1.7 Local persistence*

- [ ] The `LocalStore` interface and its conformance suite.
- [ ] `@cgw/store-web` on IndexedDB; the persistent-storage request and its notice.
- [ ] `crates/cgw-store` on SQLite behind typed Tauri commands; binary across the boundary.
- [ ] Autosave: batch, append, flush on hide and close, compaction of the local log.
- [ ] Crash recovery by replaying the log; the kill test.
- [ ] Local page history: a snapshot kept on a schedule, with view and restore.
- [ ] Export a workspace as a zip, and import one.

*M1.8 Search*

- [ ] Text normalisation for Arabic and English, with shared test vectors.
- [ ] Browser: an in-memory index in a worker. Desktop: FTS5.
- [ ] Ctrl+K: search titles and text, open a result, run a command.

*M1.9 Desktop packaging and polish*

- [ ] NSIS installer, signing, updater feed, as Sheet does.
- [ ] Narrow-screen layout: drawer sidebar, touch toolbar, move up and down.
- [ ] Axe on the main screens; a keyboard-only pass; a screen-reader pass.
- [ ] `CHANGELOG.md`, version `0.1.0`.

**Files and modules**

`@cgw/doc`, `@cgw/editor`, `@cgw/workspace`, `@cgw/store-web`, `@cgw/shell`, `apps/web`,
`apps/desktop`, `crates/cgw-store`, `crates/cgw-native`, `tests/e2e`, `bench/`.

**API contracts**

No server. The contracts fixed in this phase are internal and typed: `LocalStore`,
`WorkspacePlatform`, `Operation` and its payloads, the command registry, the clipboard format,
and the export manifest. `Operation` is the same shape Phase 2 sends to the server.

**Database changes**

Local only: the SQLite schema and the IndexedDB stores for the collections in `DATA_MODEL.md`,
each at store schema version 1.

**Acceptance criteria**

Each of the brief's 14 MVP items, shown working in the browser and in the desktop app:

| # | Item | Proof |
| --- | --- | --- |
| 1 | Create a workspace | e2e |
| 2 | Create and organise pages | e2e: nest, move, rename, trash, restore |
| 3 | Edit block-based documents | e2e over every MVP block |
| 4 | Slash commands | e2e in both languages |
| 5 | Format text | e2e |
| 6 | Drag and reorder blocks | e2e, and ids unchanged |
| 7 | Insert images and tables | e2e |
| 8 | Autosave | Kill test |
| 9 | Open saved documents | e2e after restart |
| 10 | Search pages | e2e, Arabic and English queries |
| 11 | Dark and light themes | Screenshot tests |
| 12 | Arabic and English | e2e with `dir="rtl"`; no untranslated string |
| 13 | Runs in a browser | CI |
| 14 | Runs in a Tauri desktop app | CI build and smoke test |

**Automated tests**

- Unit: schema, id plugin, order keys, tree rules, normalisation, Markdown output.
- `LocalStore` conformance on both stores.
- Fuzz: block ids (from S1) on the real editor.
- e2e (Playwright): the table above, plus RTL, clipboard, keyboard-only use.
- Kill test: 1,000 random kills while typing.
- Accessibility: Axe on the main screens.

**Performance benchmarks**

Every budget in `ARCHITECTURE.md` that needs no server, gated in CI against the last run on
`main`: open 200 and 2,000 blocks, keystroke p95, heap at 5,000 blocks, sidebar at 10,000 pages,
local search at 10,000 pages, durability within 1 s, initial bundle size.

**Risks**

- Browser storage is evicted: export exists from M1.7, and the app says "on this device only".
- The UI library lacks components: stand-ins behind the same props, replaced as Track U lands.
- Scope creep in the editor: the block list is fixed above; anything else goes to "Later".

**Definition of done**

- The 14 items pass in CI on Chrome and on the built desktop app.
- All benchmarks within budget.
- No stand-in component remains, or each remaining one is listed with its Track U item.
- Evidence in `PROGRESS.md`; tags `phase-1` and `v0.1.0`; a card for Phase 2.

---

## Phase 2: Cloud document platform

**Goals**

Accounts, workspaces on the server, documents and assets in the cloud, sync while online across
a user's devices, members and page sharing, server search, version history.

**Dependencies**

- Phase 1.
- A SQL Server database and an Azure Storage account for development and for production.
- Decisions Q5 to Q11 and Q13.
- Track U7.

**Questions for you (one batch)**

Q5 (domain), Q6 (API hosting), Q7 (full-text search on the host), Q8 (email), Q9 (Yjs client
ids), Q10 (tiers and quotas), Q11 (region), Q13 (link previews).

**Tasks**

*M2.1 Server scaffold*

- [ ] `server/`: API and worker hosts, modules, EF Core with migrations, ProblemDetails, OpenAPI
      checked in, health checks, structured logs with a correlation id, rate limiter.
- [ ] Tests against SQL Server in a container; Azurite for Blob.
- [ ] `@cgw/api` generated from the OpenAPI document; CI fails if it is stale.

*M2.2 Identity*

- [ ] ASP.NET Core Identity; sign-up, email confirmation, sign-in, sign-out, password reset.
- [ ] OpenIddict: cookie session for the web; authorisation code with PKCE for the desktop.
- [ ] Desktop sign-in through the system browser; refresh token in the OS keychain.
- [ ] Devices; sign out a device; lockout; the audit log.

*M2.3 Workspaces and metadata sync*

- [ ] Workspaces, members, roles, invites.
- [ ] The operations endpoint with `AppliedOps`; the change feed with its safe window.
- [ ] Sections and pages on the server, with the closure table and the tree rules.
- [ ] The sync engine's metadata loop in `@cgw/workspace`; the status indicator.
- [ ] Upload a local-only workspace after sign-in.

*M2.4 Documents in the cloud*

- [ ] Push and pull by sequence, with epoch and schema-version checks.
- [ ] The worker with `cgw-ydoc`: validation, compaction snapshots to Blob, derived JSON and text.
- [ ] Yjs client-id registration and the check in the worker.
- [ ] The sync engine's document loop; a second device sees the first one's edits.

*M2.5 Assets*

- [ ] Upload tickets and read URLs as user-delegation SAS; private containers.
- [ ] Type and size checks; dimensions; the reference count and clean-up job.
- [ ] The client's upload queue and cache.
- [ ] Bookmark previews behind the SSRF guard (if Q13 says yes).

*M2.6 Permissions and sharing*

- [ ] Access resolution as in `DATA_MODEL.md`, applied to every endpoint.
- [ ] Share dialog: people, level, restricted pages; private sections.
- [ ] `grant` and `revoke` events in the change feed and the client's scoped resync.
- [ ] Share links (view only), hashed, expiring, revocable.

*M2.7 Search and history*

- [ ] Server search over normalised text and titles, filtered by access at query time.
- [ ] Merge server and local results in the search palette.
- [ ] History snapshots on a schedule; named versions; view; restore as a forward edit; hard
      restore for admins with the epoch bump.

*M2.8 Operations*

- [ ] Deploy the web app and the API; migrations as a release step.
- [ ] Backups configured; the restore drill; the SQL and Blob reconcile job.
- [ ] Workspace export from the server; workspace and account deletion.
- [ ] Security review: every row of the security table in `ARCHITECTURE.md` checked off.

**Files and modules**

`server/` (Identity, Workspaces, Pages, Documents, Assets, Search, Sharing, Sync, Audit modules;
API and worker hosts); `@cgw/api`; `@cgw/workspace` (sync engine); `@cgw/shell` (sign-in, members,
share dialog, history); `crates/cgw-ydoc`; `crates/cgw-native` (keychain, deep link).

**API contracts**

All under `/api/v1`, defined by the checked-in OpenAPI document. Shapes for the sync routes are
in `SYNC_DESIGN.md`.

| Area | Routes |
| --- | --- |
| Account | `POST /account/register`, `/account/confirm`, `/account/password/forgot`, `/account/password/reset`; `GET /account/me`; `GET`, `DELETE /account/devices/{id}`; OpenIddict's `/connect/authorize`, `/connect/token`, `/connect/logout` |
| Workspaces | `GET`, `POST /workspaces`; `GET`, `PATCH`, `DELETE /workspaces/{id}`; `GET`, `PATCH`, `DELETE /workspaces/{id}/members`; `POST /workspaces/{id}/invites`, `POST /invites/accept` (as built: the token in the body, never in a path a server logs; people join only by invitation, so no answer says whether an address has an account) |
| Metadata sync | `POST /workspaces/{id}/ops`; `GET /workspaces/{id}/changes?after=&limit=`; `GET /workspaces/{id}/tree?root=` (scoped resync) |
| Documents | `GET /pages/{id}/doc?after=`; `POST /pages/{id}/doc/updates`; `GET /pages/{id}/doc/json` (read-only view for old clients) |
| Assets | `POST /workspaces/{id}/assets` → upload ticket; `POST /assets/{id}/complete`; `GET /assets/{id}/url` |
| Sharing | `GET`, `PUT /pages/{id}/permissions`; `GET`, `POST`, `DELETE /pages/{id}/share-links` |
| Search | `GET /workspaces/{id}/search?q=&limit=&cursor=` |
| History | `GET`, `POST /pages/{id}/versions`; `GET /pages/{id}/versions/{vid}`; `POST /pages/{id}/versions/{vid}/restore` |
| Yjs clients | `POST /workspaces/{id}/yjs-clients` (issue a pool, register local ids) |
| Export | `POST /workspaces/{id}/exports`; `GET /exports/{id}` |

Error codes used by clients: `auth.required`, `access.denied`, `version.conflict`, `tree.cycle`,
`tree.parentMissing`, `doc.epochMismatch`, `client.tooOld`, `page.gone`, `limit.size`,
`limit.rate`, `asset.typeNotAllowed`, `request.invalid`.

**Database changes**

The first migrations: Identity tables, `Devices`, `YjsClients`, `Workspaces`, `WorkspaceMembers`,
`WorkspaceInvites`, `Sections`, `Pages`, `PageAncestors`, `Favourites`, `PageVisits`,
`PageDocUpdates`, `PageDocSnapshots`, `PageDocDerived`, `PageLinks`, `Assets`, `AssetRefs`,
`PagePermissions`, `ShareLinks`, `WorkspaceChanges`, `AppliedOps`, `AuditLog`; the full-text
catalogue and index. Local stores move to schema version 2 (cursors, acknowledgements).

**Acceptance criteria**

- A new user signs up, creates a workspace, and sees the same pages on a second device within
  5 seconds of an edit while both are online.
- A local-only workspace from Phase 1 uploads intact: tree, documents, assets, ids.
- A member with `view` cannot push; a guest sees only what was shared; a user in another
  workspace gets 404 for every id, proven by a test that tries each endpoint.
- An image is unreachable without a fresh signed URL, and a signed URL stops working after its
  lifetime.
- Search returns only pages the caller may read, in Arabic and English.
- A version can be viewed and restored; the restore is undoable.
- A restore from backup into a scratch environment opens pages correctly.

**Automated tests**

- Unit and integration tests per module against real SQL Server and Azurite.
- Contract: the generated client matches the OpenAPI document; every error code has a test.
- Authorisation matrix: role × page level × endpoint.
- Tenant isolation: every entity is filtered; cross-workspace requests fail.
- Sync: two simulated clients converge on documents and on the tree; outbox replay after a lost
  response; 50 concurrent writers on one page.
- Hostile updates (S7's corpus) against the real push path and worker.
- Compaction killed at each step.
- e2e: sign-up to shared page, in the browser and the desktop app.

**Performance benchmarks**

- Push round trip p95 ≤ 200 ms at the server; pull of 200 updates ≤ 300 ms.
- Change feed: 1,000 changes ≤ 500 ms.
- Search p95 ≤ 300 ms at 10,000 pages.
- Compaction of a 1 MB document ≤ 200 ms.
- First sync of a 1,000-page workspace (metadata only) ≤ 5 s.
- Load test: 200 concurrent users editing, no missed update, no error above 0.1%.

**Risks**

- Identity mistakes are costly: use the frameworks as documented, no custom crypto, and review
  M2.2 and M2.6 separately before release.
- SQL and Blob drift after a restore: the reconcile job and the drill.
- Full-text search may be missing on the host: the fallback in Q7.
- The worker falls behind: its lag is measured and alarmed; pulls still work without it.

**Definition of done**

- All acceptance criteria proven in CI or by a recorded drill.
- The security table checked row by row, with evidence.
- Benchmarks within budget.
- Deployed; evidence in `PROGRESS.md`; tags `phase-2` and `v0.2.0`; a card for Phase 3.

---

## Phase 3: Offline

**Goals**

Work with no network on the desktop and in the browser: open cached and pinned pages, edit,
create pages, and sync later, with every conflict resolved by its stated rule. A macOS build.

**Dependencies**

Phase 2.

**Questions for you (one batch)**

- Trash retention and the longest offline window (defaults: 60 and 30 days).
- Whether "pin for offline" is per page, per subtree, or also "whole workspace" (default: page
  and subtree).
- macOS signing and notarisation.

**Tasks**

*M3.1 Offline availability*

- [ ] Pin a page or subtree; background fetch and refresh of pinned pages; storage used, shown.
- [ ] Open, edit and create pages offline; the mirror serves the tree and title search.
- [ ] Connection status and the count of waiting changes.

*M3.2 Robust sync loop*

- [ ] Backoff with jitter; resume after sleep; pause on 401 without discarding.
- [ ] Full resync when the cursor is older than the feed's retention, keeping the outbox.
- [ ] State-vector repair path.

*M3.3 Conflicts*

- [ ] Every row of the conflict tables in `SYNC_DESIGN.md`, with its notice.
- [ ] Quarantine to a recovered page; the "Recovered" list.
- [ ] Epoch change handling on the client.
- [ ] The move intent in the id plugin.

*M3.4 Versions and migrations*

- [ ] The schema-version gate end to end, including the read-only view from derived JSON.
- [ ] Local store migrations with a copy first; the "store is newer than the app" refusal.
- [ ] The first real document migration, as a rehearsal, with its fixture.

*M3.5 Crash and recovery*

- [ ] Kill tests during sync, during compaction, during a store migration.
- [ ] A corrupt local update is skipped and reported; the rest load.

*M3.6 macOS*

- [ ] Build, sign, notarise, updater; the keychain store; the deep link.

**Files and modules**

`@cgw/workspace` (sync engine, conflicts, pins); `@cgw/doc` (gate, migrations, move intent);
`@cgw/store-web`; `crates/cgw-store`; `@cgw/shell` (status, notices, recovered pages);
`apps/desktop`; `server/` Sync and Documents modules.

**API contracts**

Additions: `GET /pages/{id}/doc/state-hash` for the repair check; `POST /pages/{id}/doc/repair`
(full state in, missing updates out). `Retry-After` on 429 and 503. No breaking change.

**Database changes**

Server: retention jobs for `WorkspaceChanges` (90 days) and the trash; an index for pinned-page
refresh by head sequence. Local stores: schema version 3 (pins, quarantine, repair state).

**Acceptance criteria**

- With the network off: the app starts, pinned pages open, edits are saved, a new page is
  created; with the network back, everything syncs with no action from the user.
- Each conflict row has a scripted test that ends in the stated result and shows the stated
  notice.
- An old desktop build against a migrated document: read-only, nothing pushed, the server's bytes
  unchanged.
- 1,000 random kills during sync lose nothing that was reported saved.
- The macOS app installs, signs in, edits offline and syncs.

**Automated tests**

- The convergence simulator with three clients, random partitions, loss, duplication and
  reordering, on documents and the tree together.
- The conflict scripts.
- Access granted and revoked while a client is offline.
- Migration tests with fixtures from every earlier store and document version.
- Kill tests.

**Performance benchmarks**

- Reconnect with 1,000 waiting updates across 50 pages: synced in ≤ 30 s.
- Cold start offline ≤ the online budget.
- Pinning a 500-page subtree: ≤ 2 minutes on a typical connection, without blocking typing.
- Local store size for 1,000 cached pages, recorded and tracked.

**Risks**

- Yjs moves lose concurrent edits: stated, tested, and the notice says where history is.
- A long-offline device returns with a huge outbox: batches, progress, and no timeouts that
  restart from zero.
- Browser background limits stop sync in hidden tabs: sync resumes on focus; the status says so.

**Definition of done**

- All acceptance criteria proven; the simulator runs in CI.
- `SYNC_DESIGN.md` matches the code, including any rule that changed.
- Tags `phase-3` and `v0.3.0`; a card for Phase 4.

---

## Phase 4: Workspace databases

**Goals**

Structured databases embedded in pages: typed properties, rows that are pages, table, board,
list, calendar and gallery views, with filter, sort and group.

**Dependencies**

Phase 3 (rows sync through the same operations). Q14 (formulas). `CgGrid` assessed for the table
view. Track S1 should start now (Q15).

**Questions for you (one batch)**

- Q14: formula engine. Q15: Track S timing.
- Property types in the first release (default: all but formula, relation and rollup, which land
  in M4.6).
- Row limits per database for local filtering before the server takes over (default: 5,000).

**Tasks**

*M4.1 Model and sync*

- [ ] `Databases`, `DatabaseViews`, `DatabaseRows` on the server and in both local stores.
- [ ] Operations `db.update`, `view.upsert`, `view.delete`, `row.update` with per-property
      versions; rows as pages of kind `row`.
- [ ] The `databaseView` block and full-page databases.

*M4.2 Table view and property editing*

- [ ] Add, rename, reorder, hide and delete properties; change a property's type with a stated
      conversion.
- [ ] Cell editors for text, number, date, checkbox, select, multi-select, status, person, URL,
      files.
- [ ] Open a row as a page; virtualised rows.

*M4.3 Filter, sort, group*

- [ ] One filter and sort definition, evaluated by the same rules on the client and the server,
      with shared test vectors.
- [ ] Server-side query for large databases, keyset paged.

*M4.4 Board and list views*

- [ ] Board grouped by select or status; drag between columns and within a column.
- [ ] List view.

*M4.5 Calendar and gallery views*

- [ ] Calendar by a date property; drag to change the date.
- [ ] Gallery with a cover from a files property or the page cover.

*M4.6 Formula, relation, rollup*

- [ ] The formula spike and decision (Q14); then formula properties with cached results.
- [ ] Relations with a kept-in-step reverse property; rollups over a relation.

*M4.7 Templates and import*

- [ ] Row templates; database templates.
- [ ] CSV import and export.

**Files and modules**

`server/` Databases module; `@cgw/workspace` (row and view operations, local query); a new
`packages/database` (`@cgw/database`: views and cell editors); `@cgw/editor` (the block);
possibly a formula crate (per Q14).

**API contracts**

- Operations as above, on the existing `/ops` endpoint.
- `POST /databases/{id}/query` `{viewId | filter, sorts, group, after, limit}` → rows and group
  counts.
- `POST /databases/{id}/import`, `GET /databases/{id}/export`.

**Database changes**

Server: `Databases`, `DatabaseViews`, `DatabaseRows`; computed or persisted columns and indexes
for sortable property values, decided by measurement in M4.3. Local stores: schema version 4.

**Acceptance criteria**

- A database with every first-release property type can be created, edited and viewed in all five
  views, in both languages, and survives offline edits on two devices with the per-property rule.
- The same filter and sort give the same rows on the client and the server (shared vectors).
- A 50,000-row database scrolls, filters and sorts within budget.
- Deleting a property or an option never corrupts rows.

**Automated tests**

- Filter and sort vectors run in TypeScript and C#.
- Property conversion table.
- Convergence simulator extended with row operations.
- e2e per view; RTL for board and calendar.
- Formula vectors, if Formualizer is used on both sides.

**Performance benchmarks**

- Table view: first rows of a 50,000-row database ≤ 500 ms; scroll at 60 frames a second.
- Server query p95 ≤ 300 ms at 50,000 rows with one filter and one sort.
- Board drag: paint ≤ 16 ms.
- Editing a cell: local ≤ 16 ms, durable ≤ 1 s.

**Risks**

- JSON property bags are slow to filter in SQL Server: measured in M4.3; the fallback is a typed
  value table for indexed properties.
- Formulas only on the client cannot be filtered on the server: cached values with a version.
- Relations across large databases: paged, with limits.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `DATA_MODEL.md` updated with what was built.
- Tags `phase-4` and `v0.4.0`; a card for Phase 5.

---

## Phase 5: Cash Gear ecosystem

**Goals**

Sheet workbooks embedded in pages, and read-only ERP blocks, each through its contract.

**Dependencies**

Phase 2 at least; Phase 4 for range import. Track S1 to S4. Track E1 to E5. Both can be built
against mocks first.

**Questions for you (one batch)**

- Q16: which ERP connectors after Vendors.
- Whether a workbook can be shared outside its workspace (default: no).
- Limits: workbook size for embedding, cells per range (defaults: 20 MB, 5,000).

**Tasks**

*M5.1 Contracts and mocks*

- [ ] `sheet-embed.1` and `erp-connect.1` as typed contracts with validators for every message
      and response.
- [ ] A mock embed page and a mock ERP server; contract suites that run against the mocks and,
      when available, the real systems.

*M5.2 Workbooks as documents*

- [ ] `Workbooks`, versions, permissions; create, list, rename, trash.
- [ ] Launch ticket, file session, read URL, save with `If-Match`.

*M5.3 Sheet block, stage 5a*

- [ ] Insert an existing workbook or create one; stored picture; "Open in Cash Gear Sheet".

*M5.4 Sheet block, stage 5b*

- [ ] The iframe host, handshake, view picker, resize, theme and direction, refresh, errors.
- [ ] Lazy load near the viewport; the picture offline.

*M5.5 Sheet block, stage 5c*

- [ ] Chart views; import a range into a database; export a view to a workbook.

*M5.6 ERP link and session*

- [ ] Link and unlink a workspace; the connect flow in the browser and on the desktop.
- [ ] `@cgw/erp`: session in memory, renew, end, every response validated.

*M5.7 ERP view block*

- [ ] Pick a connector, fields, filter, sort; table with paging; refresh; every empty and error
      state.
- [ ] Proof that nothing is stored: a test that inspects the document, both local stores, the
      search index and history after viewing.

**Files and modules**

`@cgw/erp`; a sheet-embed host in `@cgw/editor`; `server/` Workbooks and ErpLinks modules;
`tests/mocks`. In other repos: Tracks S and E.

**API contracts**

`sheet-embed.1`, the sheet-session routes, and `erp-connect.1`, all in `INTEGRATIONS.md`. Plus
`GET`, `POST /workspaces/{id}/workbooks`; `GET`, `PATCH`, `DELETE /workbooks/{id}`;
`GET`, `PUT /workbooks/{id}/permissions`; `GET`, `POST`, `DELETE /workspaces/{id}/erp-links`.

**Database changes**

`Workbooks`, `WorkbookVersions`, `WorkbookPermissions`, `WorkbookPreviews`, `ErpLinks`, and
tables for launch tickets and file sessions (hashed).

**Acceptance criteria**

- A workbook is inserted, previewed live, opened in Sheet, saved, and the block shows the new
  version after refresh.
- A reader without access to the workbook sees no preview.
- Offline, the block shows the stored picture with its date.
- An ERP block shows vendors for a user with the privilege, and a specific refusal for one
  without; two users see different rows where the ERP says so.
- After viewing ERP data, none of it is found in any Workspace store.
- Neither integration can be driven from a page on an origin that is not on the allow-list.

**Automated tests**

- Contract suites against the mocks in CI, and against the real systems on demand.
- Message validation: malformed, wrong origin, wrong version.
- Ticket and session rules: single use, expiry, scope.
- The "nothing stored" test.
- e2e with the mocks.

**Performance benchmarks**

- Embed: first paint of a 1,000-cell range ≤ 2 s after it enters the viewport; a page with 10
  embeds stays within the keystroke budget.
- ERP block: first page of results ≤ 1 s plus the ERP's own time.

**Risks**

- Tracks S and E land late: mocks keep this phase moving, and 5a ships without S3.
- Cross-origin isolation blocks the embed: decided by S9; the picture is the fallback.
- Session lifetimes annoy users: renew while the page is open; clear messages.

**Definition of done**

- Acceptance criteria proven against the real Sheet and ERP, not only the mocks.
- `INTEGRATIONS.md` matches what shipped.
- Tags `phase-5` and `v0.5.0`; a card for Phase 6.

---

## Phase 6: Collaboration

**Goals**

Several people editing a page at once, seeing each other's cursors, with comments and mentions.

**Dependencies**

Phase 3. Q17 (scale-out). WebSockets enabled on the host.

**Questions for you (one batch)**

- Q17. Notification channels for mentions and comments (default: in-app only, email later).
- Whether presence shows in the sidebar (default: yes, avatars on pages others have open).

**Tasks**

*M6.1 Hub*

- [ ] SignalR hub: join a page after the permission check; send and relay updates through the
      same code path as HTTP push; gap detection and HTTP catch-up.
- [ ] Re-check of access per connection; reaction to `revoke`.

*M6.2 Presence*

- [ ] Awareness through the hub; cursors and selections in the editor; avatars in the top bar.

*M6.3 Live metadata*

- [ ] The hub announces change-feed movement; sidebars update without polling.

*M6.4 Comments*

- [ ] Threads anchored on block ids with a relative position and quoted text; resolve; edit;
      delete; a comments panel.

*M6.5 Mentions and notifications*

- [ ] `userMention`; an inbox of mentions and replies.

*M6.6 Load and failure*

- [ ] Load test; socket loss; app-pool recycle; the scale-out decision.

**Files and modules**

`server/` Realtime and Comments modules; `@cgw/workspace` (socket transport beside HTTP);
`@cgw/doc` (awareness); `@cgw/editor` (cursors, comment marks); `@cgw/shell` (panel, inbox).

**API contracts**

- Hub methods: `JoinPage`, `LeavePage`, `PushUpdates`, `Awareness`; client events `Updates`,
  `Awareness`, `ChangesAvailable`, `AccessRevoked`.
- REST: `GET`, `POST /pages/{id}/comments/threads`; `POST`, `PATCH`, `DELETE` on comments;
  `GET /account/notifications`.

**Database changes**

`CommentThreads`, `Comments`, `Notifications`.

**Acceptance criteria**

- Two users typing in the same paragraph see each other within 300 ms and end with the same text.
- With the socket blocked, editing continues over HTTP with no error shown beyond the status.
- Recycling the app pool mid-session loses no edit.
- A user whose access is revoked stops receiving updates within 60 seconds.
- A comment stays on its block after the block moves and after the text around it changes.

**Automated tests**

- The convergence simulator over the hub.
- Fault injection: dropped, duplicated and reordered frames; reconnect storms.
- Comment anchoring across moves, splits and deletions.
- Permission re-check.

**Performance benchmarks**

- 20 editors on one page: relay p95 ≤ 150 ms at the server; keystroke budget still met.
- 2,000 concurrent connections on one node, measured for memory and CPU.

**Risks**

- One node is not enough: the hub is stateless, so scale-out is configuration.
- Cursor and caret bugs in the binding: found early by S1; fixed in our seam or upstream.

**Definition of done**

- Acceptance criteria and load test proven.
- Tags `phase-6` and `v0.6.0`; a card for Phase 7.

---

## Phase 7: Editable ERP blocks, plugins, AI

**Goals**

Edit selected ERP fields from a page with review and commit; first-party plugin blocks; optional
AI features.

**Dependencies**

Phase 5; Track E6. Phase 6 is not required.

**Questions for you (one batch)**

- Which connectors become editable first (default: Vendors, as Sheet).
- The first plugin blocks (default: chart, then kanban over a database).
- AI: which modes ship first (default: bring your own key), which providers, and whether it is
  off by default per workspace (default: off).

**Tasks**

*M7.1 Editable ERP blocks*

- [ ] Pending changes in memory; marks on changed cells; leave-page warning.
- [ ] Validate (`dryRun`), review screen, commit with `commitId`, `CommitStatus` after a lost
      response, per-field conflict resolution.
- [ ] Audit entries on both sides.

*M7.2 Plugin blocks*

- [ ] `pluginBlock` in the schema (a schema version rise, with its migration test).
- [ ] The `BlockDefinition` interface; chart and kanban as first-party definitions.

*M7.3 AI foundation*

- [ ] `IAiProvider`, provider configuration per workspace, key encryption, metering, audit,
      the off switch.

*M7.4 AI features*

- [ ] Rewrite selection, summarise page, extract action items, generate a page, each as a
      proposal the user accepts.
- [ ] Generate a database as a proposal. Search over content with permission filtering.
- [ ] Prepare ERP changes in an editable block, with no path to commit.

**Files and modules**

`@cgw/erp`; `@cgw/editor`; a new `packages/plugins`; `server/` Ai module; `@cgw/shell` (review
screen, AI panel, settings).

**API contracts**

- `erp-connect.1` `Commit` and `CommitStatus` (`INTEGRATIONS.md`).
- `POST /ai/complete` (streamed), `GET`, `PUT /workspaces/{id}/ai-settings`.

**Database changes**

`AiSettings` (encrypted key reference, provider, model, enabled), `AiUsage`, `PageEmbeddings`.

**Acceptance criteria**

- An edit to an ERP field is written only after review and commit, appears in the ERP's audit
  with the page it came from, and a conflicting change in the ERP is shown and not overwritten.
- A user without the edit privilege cannot commit by any request, proven against the API.
- A document with a plugin block opens in a build without that plugin and is unchanged after.
- With AI off, no request leaves for any provider. With it on, only content the user can read is
  sent, and output enters the document only on accept.
- No AI path reaches `Commit`.

**Automated tests**

- The contract suite's commit cases, including retry by `commitId` and 409.
- Plugin block round trip through an older build.
- AI: permission filtering, the off switch, key never returned, a test that the commit route is
  unreachable from AI code.

**Performance benchmarks**

- Review of 500 changed records ≤ 2 s plus the ERP's time.
- First AI token ≤ 2 s plus the provider's time.

**Risks**

- A page becomes a back door into the ERP: the ERP enforces everything; Workspace adds no
  permission of its own.
- AI sends more than intended: one place builds the request, and it is tested.

**Definition of done**

- Acceptance criteria proven against the real ERP.
- Tags `phase-7` and `v0.7.0`; "Later" reviewed with you.

---

## Later

Not planned in any phase; listed so they are not lost.

- Timeline and chart views for databases.
- Embedded presentations, once that app exists.
- Third-party plugins in sandboxed iframes.
- Groups in permissions; single sign-on; passkeys.
- Email notifications; a public page site.
- Linux desktop build; a mobile app.
- A shared `@cashgear/app-kit` for the platform split, theme and shortcuts.
- SQLite on OPFS in the browser.
- Yjs 14, when its binding is stable.
- Import from Notion, Markdown folders and Word.

## Top risks, by the earliest phase that exposes them

| Risk | Phase | Answer |
| --- | --- | --- |
| The block schema or ids do not survive Yjs | 0 | S1 |
| A stale client deletes content | 0 | S2, the gate |
| Server-side Yjs is unreliable | 0 | S3, S4 |
| Arabic input or bidi is wrong in WebView2 | 0 | S5 |
| Large pages are slow | 0 | S6 |
| The UI library lacks what a block editor needs | 1 | Track U |
| Local browser storage is lost | 1 | Export, persistence request |
| Identity or tenant isolation has a hole | 2 | Frameworks, the matrix tests, a review |
| Offline merges surprise users | 3 | Stated rules, notices, history |
| JSON properties are slow to query | 4 | Measure, typed value table |
| Other repos' work is late | 5 | Mocks, staged delivery |
| Real-time outgrows one node | 6 | Stateless hub |
| A page becomes a path into ERP transactions | 7 | The ERP enforces; explicit commit |

## Verification

Before any phase is called done:

1. The standing checks pass on `main` in CI.
2. Every acceptance criterion has evidence in `PROGRESS.md`.
3. The benchmarks are within budget, or the miss is recorded with your decision.
4. The documents match the code: any design that changed is updated in the same phase.
5. The app is run, in the browser and on the desktop, in English and in Arabic, in light and in
   dark, and the phase's features are used by hand once.
