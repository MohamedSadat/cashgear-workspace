# Cash Gear Workspace: implementation plan

> Approved for planning on 2026-11-11. Phases 8 to 10 added on 2026-11-15, chosen from "Later"
> after 0.7.0. Phases 11 to 13 added on 2026-11-19, from the themes chosen after 0.10.0. Phases 14
> and 15 added on 2026-11-22, from the themes chosen after 0.13.0. Three phases added on 2026-11-24,
> from a comparison with Notion (automations, forms, workflows and tasks), and put first the same
> day: they are Phases 15 to 17, and AI, further, planned as Phase 15, is Phase 18. No phase starts
> until you say so.

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
| 8 | Hardening and moving in: reliability, the library's components, bulk cell editing, import, email notifications | `v0.8.0` |
| 9 | Publishing and views: a public page site, the timeline view, workbooks in the export and their history | `v0.9.0` |
| 10 | Editable Customers and Items on hand, AI search by embeddings, third-party plugin blocks | `v0.10.0` |
| 11 | Sign-in and permissions: groups, passkeys, single sign-on | `v0.11.0` |
| 12 | Databases and ERP at scale: a chart view, lanes on the timeline, the grid with a screen reader, row documents in pins, ERP reports, the ERP's queries paged in SQL | `v0.12.0` |
| 13 | AI and plugins: a plugin's own network, plugins in the change feed, property values by meaning, an approximate index, a local embedding model, AI by subscription | `v0.13.0` |
| 14 | Publishing: a site at its workspace's own domain, publishing changes in the change feed, a rate limit in the Sites process, an index of rows' files | `v0.14.0` |
| 15 | Automations: a database's rules of a trigger, conditions and actions, run on the server; buttons, webhooks, the run log | `v0.15.0` |
| 16 | Forms: a database's form view, answered by members and by anyone with a form link, starting rules | `v0.16.0` |
| 17 | Workflows and tasks: waits, branches and approvals in a rule; recurring rows, reminders, sub-items, dependencies on the timeline, a unique id | `v0.17.0` |
| 18 | AI, further: completions on a local model, billing for Cash Gear's subscription | `v0.18.0` |

Changes from the brief's suggested phases, and why:

- Tauri packaging and the SQLite store move into Phase 1, because the MVP must run on the desktop
  and is local-first.
- "Desktop and offline" becomes "Offline" (Phase 3): the desktop app already exists by then.
- Collaboration (Phase 6) ships alone; ERP editing, plugins and AI move to Phase 7.
- Phases 8 to 10 were chosen from "Later" and the earlier phases' deferrals on 2026-11-15, after
  0.7.0, and split into three releases (`DECISIONS.md`).
- Phases 11 to 13 are the four themes chosen on 2026-11-18, after 0.10.0, sized against the code
  on 2026-11-19 and proposed as three releases: about two of Phase 10 in all, with the riskiest
  change to the server's core (who may read what) first, before more is built on it.
- Phases 14 and 15 are the two themes chosen on 2026-11-22, after 0.13.0, sized against the code
  the same day and proposed as two releases: publishing first, as it is smaller and its host work
  (DNS, a binding, a certificate's terms) is yours early; AI second, behind its spike. AI, further,
  became Phase 18 on 2026-11-24.
- Phases 15 to 17 are the three themes you chose on 2026-11-24 from a comparison with Notion,
  sized against 0.14.0 the same day and proposed as three releases, each built on the one before:
  rules first (the engine, and a rule acting for a person, the riskiest change to the server),
  forms second (a public way in, whose answers start rules), then the runs that wait and the tasks'
  views. Planned after AI, further, they were put before it the same day, at your word.

## Track U: missing components in `CashGear.React.UI`

Built in that repo, to its rules (one folder per component, logical CSS, Arabic labels, stories,
Axe). Each is needed by the milestone named.

| # | Component | Needed by |
| --- | --- | --- |
| U1 | Command menu: filtered, grouped list anchored to a point, full keyboard | M1.3 |
| U2 | Selection toolbar: a `CgToolbar` in a `CgFlyout` that follows a rectangle | M1.3 |
| U3 | Drag handle and drop indicator; a small pointer-and-keyboard drag-and-drop helper, with a drag copy and edge scrolling (Phase 4's board) | M1.4 |
| U4 | `CgTreeView`: drag-and-drop, inline rename, virtualisation, lazy children | M1.6 |
| U5 | Breadcrumb with overflow | M1.6 |
| U6 | Emoji picker (data set licence checked) and page-icon set | M1.6 |
| U7 | Avatar and avatar stack | M2.2 |
| U8 | Block-type icons added to `CgIcon` | M1.3 |
| U9 | Tag boxes: creatable options with per-option actions (rename, recolour, regroup, reorder, delete), single and grouped; and caller-drawn chips over caller-supplied results | M4.2 |
| U10 | A menu surface that holds inputs, switches and panels | M4.2 |
| U11 | A sortable list (a handle and arrow keys) | M4.2 |
| U12 | Text and number editors that keep no React draft | M4.2 |
| U13 | A live-region announcer | M4.4 |
| U14 | A kanban board | M4.4 |
| U15 | A month calendar that takes zero-length items and inclusive ends, with no editor of its own | M4.5 |
| U16 | A file picker that only gives the file | M4.7 |
| U17 | An editable area with a suggestion list (the comment composer's "@") | M6.4 |
| U18 | A timeline: bars over a date axis, lanes, drag to move and resize, zoom | M9.2 |
| U19 | `CgTimeline`: a bar moved to another lane by pointer and keys, the lane in its move's details, right to left | M12.2 |
| U20 | `CgTimeline`: links between bars (an arrow from one bar's end to another's start, routed round bars, drawn for the bars in view, named for a screen reader), right to left | M17.4 |
| U21 | Recurrence: `CgScheduler`'s recurrence fields and their arithmetic (`schedulerRecurrence.ts`) exported as a component and functions of their own | M17.2 |

Until a component lands, the milestone uses a local stand-in behind the same props and replaces
it when the pin moves. Stand-ins are listed in `PROGRESS.md` so none is forgotten. U9 to U17 are
the stand-ins Phases 4 to 7 listed there (added here on 2026-11-15); Phase 8 builds U1 to U17 and
fixes the library defects `PROGRESS.md` lists, and Phase 9 needs U18. U20 and U21 added on
2026-11-24, for Phase 17.

## Track S: Cash Gear Sheet

Listed in `INTEGRATIONS.md`: S1 cloud platform, S2 `/cloud` launch route, S3 `/embed` route,
S4 preview pictures and charts, S5 the shared contract suite. Needed by Phase 5; S1 should start
during Phase 4. Added on 2026-11-15: S6, Sheet's desktop app opening a Workspace launch ticket by
its deep link, needed by Phase 9 (M9.3); `INTEGRATIONS.md` gains it when Phase 9 starts.

## Track E: Cash Gear ERP

Listed in `INTEGRATIONS.md`: E1 app session with an audience, E2 workspace link, E3 connect flow
in the ERP client, E4 read-only connectors, E5 rate limiting and CORS, E6 editable connectors,
E7 the contract suite. E1 to E5 are needed by Phase 5; E6 by Phase 7. Added on 2026-11-15: E8,
Customers and Items on hand editable with the audit, and E9, their cases in the contract suite,
needed by Phase 10 once E1 to E7 are pushed; `INTEGRATIONS.md` gains them when Phase 10 starts.
Added on 2026-11-19: E10, the connectors' `Query` filtered, sorted and paged in SQL rather than
over every row of the company in memory (as 0.10.0's connectors do), and E11, report connectors
(`kind: 'report'`, with parameters), both needed by Phase 12; `INTEGRATIONS.md` gains them when
Phase 12 starts.

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

## Phase 8: Hardening and moving in

**Goals**

Close what 0.6.0 and 0.7.0 left open in reliability and server cost, replace the stand-in
components with the UI library's own, and make it easy to bring work in: bulk cell editing in
databases, import from Markdown, Notion and Word, and email for mentions and replies.

**Dependencies**

Phase 7. Track U (U1 to U17 and the library's defects) in `CashGear.React.UI`, agreed for this
phase: M8.2 swaps each component as it lands, and no other milestone waits for it. Mail as
deployed (decisions, 2026-11-14: production hosting).

**Questions for you (one batch)**

- Track U: who builds it and on which branch of `CashGear.React.UI` (default: a session of its
  own in that repo, on the branch both pins follow, `claude/cashgear-react-ui-library-xq8tsz`,
  since the library has no `main`; Sheet moves its own pin when it chooses).
- If Chrome is shown to lose IndexedDB writes it reported complete with the whole process tree
  ended: strict durability on document writes, with "Saved" waiting for it (default: yes, if the
  1 s durability budget still holds).
- Paste: what a paste past the last row does (default: adds rows, at most 1,000 a paste), and how
  a paste is taken back (default: the notice after a paste offers Undo, which writes the old
  values back; databases have no undo yet).
- Import: where it runs (default: on the device, so it works in a local workspace and the server
  never opens an uploaded archive), and its limits (default: 2,000 pages and 500 MB an import).
- Email: the choices per person and the default (default: on, mentions and replies at most every
  15 minutes and only while still unread; a daily digest or off by choice), and the sender
  (default: the SMTP account already set, `Smtp__From`).

**Tasks**

*M8.1 Reliability*

- [ ] The web loss after "Saved" (CI run 43746282731, `PROGRESS.md`, Phase 7): reproduced at
      size with the web kill test during sync; found whether Chrome lost a completed transaction
      or "Saved" came early; fixed. The kill tests' run counts raised until the loss rate is known.
- [ ] The server's work per push (about 55 ms of the API's CPU and 45 ms of the worker's on the
      reference machine, `PROGRESS.md`, Phase 6): profiled; each validation pass loads a document
      once (its meta, the check and the state hash).
- [ ] Why CI's work per key doubled from Phase 5 to Phase 6 (the median too, desktop and web):
      found from the benches' figures and fixed, or the cause recorded.
- [ ] An operation refused for access (`access.denied`: a guest making a section, a cover file
      not readable) says what happened (decisions, 2026-11-15, after 0.7.0).

*M8.2 The library's components*

- [ ] Track U's U1 to U17, and the defects `PROGRESS.md` lists, built in `CashGear.React.UI` to
      its rules (one folder per component, logical CSS, Arabic labels, stories, Axe).
- [ ] Each stand-in replaced by bumping the pinned commit, its local copy deleted, its row in
      `PROGRESS.md` ticked; each workaround for a fixed defect removed.
- [ ] Every spec and budget of Phases 1 to 7 holds after each swap.

*M8.3 Bulk cell editing*

- [ ] Cell selection in the table: a rectangle by Shift and the arrows, Shift+click and pointer
      drag; whole rows and columns; kept while the table's window scrolls; right to left.
- [ ] Copy as tab-separated text and an HTML table, the values as shown. Paste tab-separated text
      (from Sheet, Excel or the table) into a rectangle, each value read by its property's
      conversion rules; refused cells left as they were and counted. One batch of `row.update`
      operations a paste; Delete clears the selection.
- [ ] Board columns and gallery cards dragged into a new order, by pointer and keyboard, as board
      cards move today; where each order is kept is the phase's choice, logged.

*M8.4 Import*

- [ ] A folder or zip of Markdown files: a page tree after its folders, links between the files
      as page links, images and attachments as assets; through `@cgw/doc`'s Markdown in.
- [ ] A Notion export (Markdown and CSV, zipped): pages and their nesting; databases from their
      CSV, property types inferred as the CSV import does; row pages from the database's folder;
      Notion's id suffixes taken off names; links between pages kept.
- [ ] Word `.docx`: headings, paragraphs, lists, tables, images, links and marks into blocks,
      through a reader under an allowed licence or one of our own over the file's XML.
- [ ] Each import ends with a report of what was made and what was skipped, and why (tracked
      changes, comments, text boxes, a type with no counterpart). An import that fails or is
      stopped leaves nothing half made, and never writes into an existing page.

*M8.5 Email notifications*

- [ ] Settings per person in the account (on, a daily digest, off); each mail turns mail off in
      one click without signing in (`List-Unsubscribe` and `List-Unsubscribe-Post`, a signed
      token).
- [ ] The worker mails `mention`, `commentMention` and `reply` notifications still unread after
      the delay, grouped per person: access checked again when sending; excerpts by the inbox's
      rules (plain text, mentions as `@` only); in the person's language (`User.Locale`) and
      direction; links to the page and block.
- [ ] Mail kept in a queue in the database, sent with retries under a daily cap below the SMTP
      account's limit; failures logged without content.

**Files and modules**

`@cgw/store-web` (durability); `server/` Documents (the validation pass), Notifications and Mail;
`@cgw/database` (selection, clipboard, column and card order); `@cgw/shell` (`exchange/` and an
import panel, the mail settings); `@cgw/doc` (Markdown in, a `.docx` reader); the pinned
`@cashgear/ui` everywhere. In another repo: Track U.

**API contracts**

- `GET`, `PUT /account/notification-settings`; `POST /mail/unsubscribe` (the token from the
  mail; the same answer for any token).
- No new operation: a paste is `row.update`s, and an import uses the existing operations, asset
  uploads and `POST /databases/{id}/import`.

**Database changes**

Server: mail settings per account, `Notifications.EmailedAt`, a mail queue. Local stores: none
(store schema stays 4) unless the durability fix needs one.

**Acceptance criteria**

- The web and desktop kill tests during sync run 1,000 times each and lose nothing reported
  saved; or the browser's own loss is measured and your decision recorded.
- The server's CPU per push (the API's and the worker's) is at most half of 0.7.0's on the
  reference machine.
- No stand-in that Track U replaced is left; every spec and budget of Phases 1 to 7 passes after
  the swaps.
- 1,000 cells copied from Excel and from Sheet paste into the table, each value converted as the
  conversion table says, reach a second device and can be taken back; a rectangle copied from the
  table pastes into Excel as shown.
- A Notion export, a Markdown folder and a `.docx` file each import with their structure, links,
  databases with typed properties, row pages and images, into a local and a synced workspace,
  and say what they skipped.
- A person mentioned while away gets one mail, in their language, that opens the block; none for
  a page they can no longer read, and none once they have read it in the app; one click in the
  mail turns mail off; with mail off, nothing is sent.

**Automated tests**

- The kill tests at size; a unit test for the durability fix that fails without it.
- The validation pass's document loads counted.
- Paste: the conversion vectors over pasted text; selection by keyboard and pointer; right to
  left.
- Import fixtures made here (a Notion export, Markdown folders, `.docx` files), each with its
  expected pages; hostile archives (paths out of the folder, a zip bomb, huge images).
- Mail: the e2e stack's pickup folder; access checked when sending; the unsubscribe token;
  Arabic; the daily cap.
- Axe and the Arabic check on the new screens.

**Performance benchmarks**

- A paste of 1,000 cells shown ≤ 500 ms, on the server ≤ 5 s.
- A 1,000-page Notion export imported on the device ≤ 60 s, the uploads apart.
- The server's CPU per push ≤ half of 0.7.0's; the relay p95 at 20 editors still ≤ 150 ms.
- Every budget of Phases 1 to 7 unchanged after the Track U swaps.

**Risks**

- Chrome loses writes it reported complete: the fix is in what "Saved" waits for, measured
  against the 1 s budget, since the browser cannot be fixed from here.
- Track U lands late: the stand-ins not yet replaced stay, listed, with your decision.
- Imports meet files no fixture covers: what is not understood is reported, never dropped
  silently.
- Mail through a Gmail account has a daily sending limit: the cap, the queue and the digest.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `DATA_MODEL.md`, `ARCHITECTURE.md` and `INTEGRATIONS.md` updated with what was built.
- Tags `phase-8` and `v0.8.0`; a card for Phase 9.

---

## Phase 9: Publishing and views

**Goals**

Publish a page tree as a public, read-only site; a timeline view for databases; workbooks that
travel in the workspace's export and show their history.

**Dependencies**

Phase 8 (the library's components). Track U18 for the timeline; Track S6 for Sheet's desktop deep
link. An origin and a host for the site.

**Questions for you (one batch)**

- The site's address and host (default: an origin of its own, for example
  `pages.cashgearerp.com`, never the app's or the API's, so a published page can read neither's
  session).
- Custom domains for a site (default: not in 0.9.0).
- Search engines (default: not indexed unless the publisher turns it on for the site).
- Databases on a published page, and on a share link (default: their rows, read-only, through the
  block's view, and a database's full page; Phase 4 left a note there).
- Workbooks on a published page (default: a placeholder, as on a share link: Phase 5's answer
  keeps a workbook inside its workspace).
- The timeline in Arabic (default: time runs right to left).
- Track S6: who builds Sheet's desktop deep link (default: a session of its own in
  `cashgear-sheet`).

**Tasks**

*M9.1 Publishing*

- [ ] Publish a page and its subtree, by someone with `full` on the page: a slug, unpublish at
      once, publish again. The pages a site holds follow a share link's rules: restricted, hidden
      and private pages, and what is under them, never.
- [ ] The site is HTML rendered on the server from the worker's derived JSON (no Yjs, no script
      needed to read), on its own origin with a strict CSP: titles, icons, covers, the tree as
      navigation, both languages and directions, light and dark from the reader's system; images
      and files by short signed URLs checked against the site.
- [ ] Other blocks on a published page: databases as answered, chart and kanban blocks drawn from
      those rows, a placeholder for workbooks and always for ERP views; nothing of comments,
      presence or history.
- [ ] Caching, with an unpublish that holds within a minute; `noindex` unless indexing is on; an
      audit entry for each publish and unpublish.

*M9.2 Timeline view*

- [ ] A sixth view type, `timeline`: bars from a date property's range or from two date
      properties; zoom by day, week, month and quarter; drag to move and to resize; rows without
      a date listed beside; lanes by a select or status property; keyboard and screen reader.
- [ ] `POST /databases/{id}/query` takes a date window, so a calendar or timeline over a large
      database fetches only the rows it shows; the calendar's 5,000-row note goes for those.
- [ ] `ViewType` in TypeScript and C#, with vectors. Older builds show a timeline view as a table
      (their fallback) and must never change its type or settings.

*M9.3 Workbooks*

- [ ] The workspace export holds each workbook the exporter can read: its newest version as
      `.xlsx`, its name and view settings (export format version 3). Import makes them again in a
      synced workspace and says it skipped them in a local one.
- [ ] A workbook's history: its kept versions with time and saver; a version opened read-only;
      restore as a new version, with `edit` or above.
- [ ] On the desktop, "Open in Cash Gear Sheet" opens Sheet's desktop app by its deep link with a
      launch ticket when it is installed, else the web app (Track S6).

**Files and modules**

`server/` Sharing and a Sites module (the renderer from derived JSON to HTML), Databases (the date
window), Workbooks, Exports; `@cgw/database` (the timeline over U18); `@cgw/workspace` (the view
type and the query); `@cgw/shell` (the publish dialog, a workbook's history, `exchange/`);
`crates/cgw-native` (Sheet's link); `deploy/iis` (the site's origin). In other repos: Tracks S6
and U18.

**API contracts**

- `GET`, `PUT`, `DELETE /pages/{id}/site`; on the site's origin, `GET /{slug}` and
  `GET /{slug}/{pageId}` (HTML) and the files those pages show.
- `POST /databases/{id}/query` gains `window: {propertyId, from, to}`.
- `GET /workbooks/{id}/versions`, `POST /workbooks/{id}/versions/{versionId}/restore`.
- Export format version 3, with workbooks.

**Database changes**

`PublishedSites` (root page, slug, indexing, who published and when, unpublished); view records of
type `timeline` and their settings; nothing new for workbooks (`WorkbookVersions` exists).

**Acceptance criteria**

- A published subtree reads in a browser with no account and with script off, in English and in
  Arabic; a restricted page under it, its comments, its history and its Yjs updates are never
  reachable; an ERP view and a workbook show placeholders; after unpublishing, every address
  answers 404 within a minute.
- Nothing on the site's origin can read the app's or the API's session, proven by a test.
- A timeline view of a 50,000-row database shows the rows in its window and moves and resizes
  bars by pointer and keyboard, in both directions; an older build that shows it keeps its type
  and settings.
- A workspace exported with workbooks imports into a new synced workspace with them; an older
  version of a workbook is restored as a new one by an editor and refused for a reader.
- On the desktop with Sheet's app installed, "Open in Cash Gear Sheet" opens the app on the
  workbook.

**Automated tests**

- The site's scope matrix (restricted, private, hidden, trashed, unpublished), as share links'
  are; the renderer's vectors from derived JSON (every node of schema 6, hostile content
  escaped).
- The timeline's layout and drag tests, right to left; the date window's vectors in TypeScript
  and C#; v0.8.0 and an older build meeting a timeline view (`old-build.spec.ts`).
- The export's round trip with workbooks; the history routes' access matrix; the desktop's deep
  link from the event on.
- Axe and the Arabic check on the site and the new screens.

**Performance benchmarks**

- A published page of 2,000 blocks: first byte p95 ≤ 200 ms from the cache, ≤ 1 s rendered
  fresh.
- Timeline: the first bars of a 50,000-row database ≤ 500 ms; dragging at 60 frames a second.

**Risks**

- A site shows more than the publisher meant: a share link's scope rules, a list of what will be
  published before publishing, unpublish at once.
- People's content on an origin that holds a session: the site has an origin of its own and no
  cookie.
- An older build writes a timeline view away: the old-build spec, and the server keeps what an
  older client does not send (the phase decides how).

**Definition of done**

- Acceptance criteria and benchmarks proven, the site on its deployed origin.
- `DATA_MODEL.md`, `ARCHITECTURE.md`, `INTEGRATIONS.md` and `OPERATIONS.md` updated.
- Tags `phase-9` and `v0.9.0`; a card for Phase 10.

---

## Phase 10: Editable Customers and Items, AI search by embeddings, third-party plugins

**Goals**

Customers and Items on hand editable from ERP blocks as Vendors are; AI search that finds pages by
meaning; plugin blocks by other authors, isolated in sandboxed iframes.

**Dependencies**

Phase 7. Tracks E1 to E7 pushed in `CashGear` (yours), then Tracks E8 and E9. An embeddings
provider: Anthropic offers no embedding model. Phase 9 is not required.

**Questions for you (one batch)**

- Track E8: which Customers and Items on hand fields become editable, at which privilege, and
  whether on-hand quantities can change at all (default: what the ERP's own screens let that
  privilege change; quantities never, since stock moves only by the ERP's transactions). Who
  builds E8 and E9 (default: a session of its own in `CashGear`, on LocalDB only, as E1 to E7).
- Embeddings: the provider (default: Voyage AI with the workspace's own key and `voyage-4`, which
  Anthropic's documentation points to; the alternative is the open-weight `voyage-4-nano`,
  Apache-2.0, run by the worker, so nothing leaves the server), off for every workspace until
  turned on, and what is embedded (default: pages' derived text in chunks; never ERP data).
- Where vectors are kept and searched (default: `PageEmbeddings` rows in SQL Server, searched in
  the API process per workspace; SQL Server's own vector type if the host's version has one).
- Third-party plugins: who may add one (default: a workspace's owners and admins); where its code
  is served from (default: a bundle an admin uploads, served from a sandbox origin of its own,
  never the author's server); what it may read (default: its block's props, and a database view's
  rows only when the block names one, and only what the reader may read); whether it may use the
  network (default: no).

**Tasks**

*M10.1 Editable Customers and Items on hand*

- [ ] `erp-connect.1`'s `Commit` and `CommitStatus` for `customers` and `itemsOnHand`, written in
      full first in `INTEGRATIONS.md`; the mock ERP's commits for both; the contract suite's cases.
- [ ] The ERP block's editing, review and conflict screens for both, through Phase 7's path; the
      AI assist prepares changes for them, still with no path to `Commit`.
- [ ] Tracks E8 and E9 in the ERP.

*M10.2 Embeddings*

- [ ] `IAiProvider.EmbedAsync` (in the interface since Phase 7, optional) for the chosen provider:
      its key under Data Protection and never returned, metering in `AiUsage`, audit, the off
      switch.
- [ ] `PageEmbeddings`: the worker embeds a page's derived text in chunks after it changes,
      debounced; removes a page's vectors when it is trashed or deleted or the workspace turns
      embeddings off; embeds again when the model changes.

*M10.3 Search by meaning*

- [ ] `ask` and the palette's search find pages by meaning and by words together, with the
      permission filter applied at query time, as ordinary search's; English and Arabic, and
      across the two.
- [ ] Vectors never leave the server; a page the person cannot read never counts.

*M10.4 Plugin frames*

- [ ] `plugin-frame.1`: a versioned message contract like `sheet-embed.1` (handshake, props in
      and out, theme, direction and language, resize, a view's rows when granted), typed, with
      validators and shared vectors.
- [ ] The host: a sandboxed iframe on the sandbox origin, mounted near the viewport; a placeholder
      when the plugin is missing or turned off; read-only for a reader who cannot edit. The
      document keeps the block's `type`, `version` and `props` as they are (`pluginBlock`, schema
      6; no schema rise).

*M10.5 Plugin install and trust*

- [ ] A workspace's plugins: add (a bundle and its manifest: name, type, version, what it asks to
      read), turn on and off, update, remove; by owners and admins; audited.
- [ ] Serving: the bundle from the sandbox origin with a CSP that allows no network and none of
      Workspace's origins; the desktop's CSP the same.

**Files and modules**

`@cgw/erp`, `tests/mocks/erp`, `tests/contracts/erp`; `server/` Ai (embeddings), Search and a
Plugins module; `@cgw/plugins` (the frame host); `@cgw/editor` (the plugin block's frame);
`@cgw/shell` (plugin settings, AI settings); the sandbox origin's hosting (`deploy/`). In another
repo: Tracks E8 and E9.

**API contracts**

- `erp-connect.1` `Commit` and `CommitStatus` for `customers` and `itemsOnHand`.
- `PUT /workspaces/{id}/ai-settings` gains the embeddings provider, model and key;
  `POST /ai/complete`'s `ask` searches by meaning when they are on.
- `plugin-frame.1`; `GET`, `POST /workspaces/{id}/plugins`;
  `PATCH`, `DELETE /workspaces/{id}/plugins/{pluginId}`; the bundles' routes on the sandbox
  origin.

**Database changes**

`PageEmbeddings` (page, chunk, model, vector, the text's version); the embeddings settings in
`AiSettings`; `WorkspacePlugins` (manifest, the bundle's blob key, on or off, who and when). No
document schema rise.

**Acceptance criteria**

- An edit to a customer or an item is written only after review and commit, is in the ERP's audit
  with its page, and a conflicting ERP change is shown, not overwritten; a user without the
  privilege cannot commit by any request, proven against the API; none of either connector's data
  is in any Workspace store.
- With embeddings on, `ask` finds a page from a question that shares none of its words, in English
  and in Arabic, and never cites a page the person cannot read; with them off, no text leaves for
  the embeddings provider; a page restricted or trashed stops counting at once.
- A third-party plugin draws in its frame with only what it was given. It cannot reach the
  document, the session, cookies, other blocks or the network, proven by a hostile plugin in the
  tests; a page holding it opens unchanged in a workspace without it and in an older build.

**Automated tests**

- The contract suite's commit cases for both connectors, against the mock and against UnifiedAPI
  on LocalDB.
- Embeddings: the permission matrix at query time; the off switch; chunks made again on change; a
  mock embeddings provider beside `tests/mocks/ai`.
- `plugin-frame.1`'s vectors; a hostile plugin (it reads `parent`, cookies and storage, calls
  `fetch`, navigates, opens pop-ups, posts to other frames); a missing, disabled or newer plugin.
- Axe and the Arabic check on the new screens.

**Performance benchmarks**

- Review of 500 changed customers ≤ 2 s plus the ERP's time.
- Retrieval by meaning over 100,000 chunks: p95 ≤ 300 ms, apart from the provider's time to embed
  the question.
- A page with 10 plugin frames stays within the keystroke budget.

**Risks**

- Vectors are content: text can be approximated from them, so they are kept and deleted as page
  text is, filtered by permission at query time, and never sent to a client.
- A third-party plugin is hostile: an origin of its own, a sandbox without `allow-same-origin`, no
  network, and a contract that grants nothing by default.
- Track E's earlier work is not pushed: E8 starts once E1 to E7 are; Workspace builds against its
  mock meanwhile.
- Stock edited outside the ERP's transactions: the ERP decides what is editable; Workspace adds no
  rule of its own.

**Definition of done**

- Acceptance criteria proven against the real ERP and the chosen embeddings provider.
- `INTEGRATIONS.md`, `DATA_MODEL.md` and `ARCHITECTURE.md` updated.
- Tags `phase-10` and `v0.10.0`; "Later" reviewed with you.

---

## Phase 11: Sign-in and permissions

**Goals**

Give access to groups of people as well as to each person; sign in with a passkey; sign in through
a workspace's own identity provider.

**Dependencies**

Phase 2's identity (ASP.NET Core Identity 10.0.15, which has passkeys built in, and OpenIddict
7.8.0) and Phase 6's hub, which re-checks access. No other repository. An OpenID Connect provider
for the live check (yours: a test app in Microsoft Entra ID or Google Workspace); CI runs against a
mock provider beside `tests/mocks`.

Sized against the code on 2026-11-19: groups touch every place access is decided (six copies of
the rule in `Access.cs`, the push's own SQL in `DocService`, workbooks' copy), so they are the
phase's risk; passkeys are Identity's own, with the sign-in pages gaining their first script;
single sign-on is the largest part (domains, a provider per workspace, accounts with no password).

**Questions for you (one batch)**

- How the four themes chosen after 0.10.0 are split (default: three releases, each planned now and
  built one at a time: Phase 11 sign-in and permissions, Phase 12 databases and ERP at scale,
  Phase 13 AI and plugins).
- Groups: who makes them, who may be in one, and what a group's row means beside a person's own
  (default: owners and admins make and manage them; members, admins and owners, never guests; a
  group is given access to pages and workbooks as a person is; at the page that decides, a
  person's own row first, then the highest of their groups' rows, then the workspace's).
- Single sign-on: the protocol and who sets it up (default: OpenID Connect, set up per workspace
  by its owners for email domains the workspace has proven by a DNS record; an account made at the
  first sign-in; the workspace may require it for those domains; no SAML in 0.11.0).
- Passkeys: beside the password or instead of it (default: beside it; added in Settings on the
  API's own page, then sign in with either; a passkey answers wherever the password is asked
  again).

**Tasks**

*M11.1 Groups*

- [ ] Groups of a workspace and their people: owners and admins make, rename and delete a group
      and add and remove its people; members read the groups and who is in them, guests none;
      audited.
- [ ] `group` as a principal in `PagePermissions` and `WorkbookPermissions`, decided by one rule
      in every path that decides access: `Access.cs`'s copies, the push's SQL fast path
      (`DocService`), workbooks, the hub's re-checks. One oracle test holds every path to the same
      answers over a random matrix of pages, rows, groups and roles.
- [ ] A group's people changed, or the group deleted: an `access` change for each person
      affected, so their tabs fetch their tree again and the hub re-checks their connections.
- [ ] The share dialog and a workbook's access take people and groups in one picker, a group shown
      with its number of people; Settings → Members gains Groups.
- [ ] An older build never drops a group's row: none is sent to a client that does not ask for
      groups, and a list saved by one keeps the stored rows of principals it did not send (as the
      server keeps a view's settings, Phase 9).

*M11.2 Passkeys*

- [ ] Identity's passkeys (its schema version 3, `UserPasskeys`), the relying party the API's own
      host; every ceremony on the API's own pages, which gain one script of their own
      (`script-src 'self'`) and nothing else.
- [ ] "Sign in with a passkey", and the browser's autofill of passkeys where it offers it, on the
      web and through the desktop's system browser; each sign-in makes a device, as a password's
      does.
- [ ] Settings → Account lists passkeys (name, added, last used); adding one opens the API's page,
      after a recent sign-in; rename and remove; audited. A passkey answers wherever the password
      is asked again (deleting the account).

*M11.3 Single sign-on*

- [ ] Domains: an owner adds an email domain and proves it with a DNS `TXT` record the server
      reads; a domain belongs to one workspace.
- [ ] A workspace's OpenID Connect provider: its issuer (read by discovery), client id and secret
      (under Data Protection, never returned); the authorisation code flow with PKCE, `state` and
      `nonce`; the id token checked for its signature by the provider's published keys, issuer,
      audience, expiry and nonce; the email must be in a verified domain of the workspace.
- [ ] "Sign in with your organisation's account": the email first, then that domain's provider. The
      first sign-in makes the account, with no password, and, if the workspace allows it, a
      membership as a member; an existing account with that email is linked to the provider.
- [ ] Sign-on required for a domain: its accounts' password and passkey sign-ins refused, except
      the workspace owners'; a session goes back to the provider after `SsoSessionHours` (24), the
      desktop's refresh tokens likewise; turning it on needs a sign-in through the provider first.
- [ ] Removing a provider or a domain, audited; people keep their accounts and may set a password
      by the reset mail.

**Files and modules**

`server/`: `Cgw.Core/Access.cs`, `Sharing/`, `Workbooks/WorkbookAccess.cs`, `Documents/DocService.cs`
and the hub's re-checks; a Groups module; Identity (`AccountService`, `AccountPages`, the connect
endpoints) and a sign-on module. `@cgw/shell`: `cloud/ShareDialog.tsx`, `CloudUi.tsx` (members,
groups, the account's passkeys, single sign-on), `sheet/WorkbookPermissions.tsx`. `@cgw/api`
regenerated. `tests/mocks/oidc`: a mock OpenID Connect provider. No document, store or sync
change.

**API contracts**

- `GET`, `POST /workspaces/{id}/groups`; `PATCH`, `DELETE /workspaces/{id}/groups/{groupId}`;
  `PUT /workspaces/{id}/groups/{groupId}/members` (the whole list, with `If-Match`).
- A page's and a workbook's permissions take `group` rows; their `GET` sends them only when asked
  (`?principals=group`).
- `GET /account/passkeys`, `PATCH`, `DELETE /account/passkeys/{id}`; the ceremonies' options and
  results on the API's own pages.
- `GET`, `POST /workspaces/{id}/sso/domains`, `POST …/domains/{domain}/verify`, `DELETE`;
  `GET`, `PUT`, `DELETE /workspaces/{id}/sso/provider`; the API's pages for the sign-in and its
  callback.

**Database changes**

`WorkspaceGroups`, `WorkspaceGroupMembers`; `group` rows in `PagePermissions` and
`WorkbookPermissions`; Identity's `UserPasskeys`; `SsoDomains`, `SsoProviders`; `UserLogins`, which
Identity has mapped since Phase 2, used for the first time.

**Acceptance criteria**

- A page restricted to a group is read and edited by exactly that group's people, at the group's
  level, through every path (the routes, a push, the hub, search and search by meaning, Ask AI's
  sources, the change feed, an export, a mail); a person's own row still decides over their
  groups'; removing someone from the group takes the page away at once in their open tab and live
  connection; a 0.10.0 build that edits the page's access keeps the group's row.
- A person signs in with a passkey added in Settings, in Chrome and Edge and through the desktop's
  system browser; a passkey of another account, or made for another site, is refused; one removed
  stops at once.
- A person of a verified domain signs in through the workspace's provider with no password, the
  first time making their account; an unverified domain, an id token with a wrong signature,
  issuer, audience, nonce or expiry, and an email outside the domains are each refused; with
  sign-on required, that domain's password and passkey sign-ins are refused and sessions go back
  to the provider after the limit.

**Automated tests**

- The access oracle over every path, groups among the principals; `AuthorizationTests`,
  `TreeAccessTests` and `RealtimeTests` with groups; v0.10.0 meeting a group's row
  (`old-build.spec.ts`).
- Passkeys through a virtual authenticator (the browser's WebAuthn testing domain); the server's
  refusals (another origin, another relying party, a challenge used twice, a counter going back).
- Single sign-on against the mock provider: every refusal above, `alg: none`, a key the provider
  never published, a `state` used twice; the DNS check through a fake resolver.
- Axe and the Arabic check on the new screens and the API's pages.

**Performance benchmarks**

- The server's CPU per push within 10 % of 0.10.0's, the push's fast path deciding for a person in
  20 groups (`bench/phase8-server.mjs`'s method).
- Search, and the tree's access read, at 10,000 pages for a person in 20 groups with 500 group
  rows: within Phase 2's budgets (search p95 ≤ 300 ms; 1,000 changes of the feed ≤ 500 ms).
- A sign-in by passkey and one through single sign-on: the API's own time, p95 ≤ 200 ms each, the
  authenticator and the provider apart.

**Risks**

- One path decides access without groups: one oracle over every path, and every copy of the rule
  listed before building.
- An older build drops a group's row: it is never sent one, and its save keeps them.
- Taking over an account through a workspace's provider: only domains proven by DNS, the email
  checked against them, the id token checked in full.
- Everyone locked out by a broken provider: owners keep their password, and required sign-on is
  turned on only after a sign-in through the provider.
- WebAuthn takes no IP address as its relying party, and development runs on `127.0.0.1`: the
  passkey specs run against a build of the app on `localhost`.
- Someone removed at the provider keeps a session: sessions capped by `SsoSessionHours`; no SCIM
  in 0.11.0.

**Definition of done**

- Acceptance criteria and benchmarks proven; single sign-on against the mock in CI, and against a
  real provider when you have one.
- `DATA_MODEL.md`, `ARCHITECTURE.md` and `OPERATIONS.md` updated.
- Tags `phase-11` and `v0.11.0`; a card for Phase 12.

---

## Phase 12: Databases and ERP at scale

**Goals**

A chart view for databases; timeline bars moved between lanes; a database grid a screen reader
reads well; pins that hold every row's document; ERP reports as read-only blocks; the ERP's
queries filtered, sorted and paged in its database, not over a company's whole table.

**Dependencies**

Phase 11. Track U19 in `CashGear.React.UI` (`CgTimeline` has lanes but no drop on another lane).
Tracks E10 and E11 in `CashGear`.

Sized on 2026-11-19: the chart block's drawing and settings already exist (`@cgw/plugins`) and the
site already draws charts as SVG; an older build reads an unknown view type as a table and could
send it back as one, which the server must catch by the types that build knew. 0.10.0's connectors
read every row the user may see and then search, sort and page in C#, keeping Arabic away from the
database's collation; `maxRecords` is advertised and not enforced. The ERP has AP aging, stock
balance on a date and a trial balance as services, and no AR aging.

**Questions for you (one batch)**

- The reports (default: AP aging by vendor, stock balance on a date, trial balance).
- Tracks U19, E10 and E11: who builds them (default: sessions of their own in those repositories,
  the ERP's on LocalDB only, as before).
- The ERP's order and search once paged in SQL (default: exactly 0.10.0's answers, the same
  records in the same order and Arabic searched as now, held by the suite against both).
- A chart view over a large database (default: counts from the query's group counts at any size;
  sums and averages over at most 5,000 rows on the device, marked partial past that, as the chart
  block).
- Pins of row documents (default: every row's document of a pinned database that has one, up to
  5,000 a database, through a batch pull).
- Screen readers (default: NVDA and Narrator on Windows and VoiceOver on the Mac, each by hand once,
  and the grid's accessibility tree checked in CI).

**Tasks**

*M12.1 Chart view*

- [ ] A seventh view type, `chart`: bars, a line or a pie, grouped by the view's group, measured by
      a count or a number, formula or rollup; the chart block's drawing and settings move into
      `@cgw/database` and the block uses them from there.
- [ ] `ViewType` in TypeScript and C#; an older build's `viewTypes` read as the types it knew, so
      6 keeps a `chart` it sent back as a table; v0.10.0 in the old-build spec; share links and
      sites draw it as the block, a measure on a property no view shows refused on both.

*M12.2 Lanes*

- [ ] Track U19; a bar dropped on another lane writes the lane's property with its dates in one
      `row.update`, by pointer and keys, right to left.

*M12.3 The grid with a screen reader*

- [ ] Row count and indices from the query's total (group, load-more and new-row lines not
      counted); the title as each row's header; headers named without their type; groups as a
      tree grid; editing announced when it starts, is saved and is cancelled.

*M12.4 Pins with row documents*

- [ ] A pinned database holds each row's document that has one, up to 5,000; a batch pull, so a
      pin stays inside the person's rate limit; Settings' progress counts them.

*M12.5 The ERP's queries paged in SQL (Track E10)*

- [ ] Filter, sort and page in SQL with a keyset cursor: the same records in the same order as
      0.10.0, `total` by a count, the field and record rules unchanged, `maxRecords` enforced; the
      suite's cases at 100,000 records against UnifiedAPI on LocalDB.

*M12.6 Reports (Track E11)*

- [ ] Report connectors in `erp-connect.1`, written in full first: parameters in `Schema` and
      `Query`, a key per row, read-only; the mock ERP's reports; the suite's cases.
- [ ] The ERP block's parameters (dates, lookups) and its report table; nothing of a report
      stored anywhere (the hard limit).

**Acceptance criteria**

- A chart view draws from its database's rows in the app, on a share link and on a site; an older
  build that edits it keeps it a chart.
- A bar moved to another lane by pointer and by keys changes its lane and dates in one edit, in
  both directions.
- NVDA, Narrator and VoiceOver read a row's title, its position of the true total and the column
  as one moves; editing is announced.
- A pinned database of 5,000 rows opens every row's document offline.
- The ERP answers a query of a 100,000-record table without reading it whole, with 0.10.0's
  records and order; each report reads with its parameters, as the ERP lets the user see it, and
  none of it is stored.

**Performance benchmarks**

- A chart view of 50,000 rows by count: first drawn ≤ 1 s.
- Pinning a 5,000-row database with its documents ≤ 120 s, the keystroke budget held meanwhile.
- The ERP's first page of a 100,000-record connector ≤ 500 ms at the ERP, its memory not growing
  with the table (Track E10's own measure).

**Risks**

- An older build turns a chart into a table: the server reads `viewTypes` as a count of types.
- The SQL path orders or matches Arabic differently from 0.10.0: the suite compares both on the
  same records.
- A report is heavy on a large ledger: `maxRecords` and the ERP's own limits; the block asks once
  per Refresh.

**Definition of done**

- Acceptance criteria and benchmarks proven, against the real ERP on LocalDB for M12.5 and M12.6.
- `INTEGRATIONS.md`, `DATA_MODEL.md` and `ARCHITECTURE.md` updated.
- Tags `phase-12` and `v0.12.0`; a card for Phase 13.

---

## Phase 13: AI and plugins

**Goals**

Plugins that may reach hosts an admin approved; plugins learned of through the change feed; rows
found by their property values as well as their text; search by meaning past what an exact search
holds; a local embedding model on the host; AI on Cash Gear's own subscription.

**Dependencies**

Phase 10. A spike before M13.4: an open-weight model on the host's processor, measured. Cash Gear's
own provider keys for the subscription, on the host only.

Sized on 2026-11-19: the plugins origin's CSP is one for every plugin (`connect-src 'none'`), so a
host list means a CSP per bundle; the plugin list already takes the change feed's lock and adds no
change; a row's values are JSON beside its row and never read by the `embed` job; the exact search
holds about 1,000,000 chunks a process in 1 GB and ranks 100,000 in about 10 ms; no model runs on
the host today, and the question is embedded in the API, so a local model loads there too.

**Questions for you (one batch)**

- A plugin's network (default: https hosts named in its manifest, approved by an admin when it is
  added and whenever an update changes them; a plugin with a view's rows and a network approved
  for both together, told that it can send what it is shown).
- Property values (default: text, number, select, status, date, checkbox, URL and email values in
  the row's own chunks; never a person, created-by or edited-by, or a formula or rollup of one).
- The approximate index (default: in the API process past 200,000 chunks a workspace, exact
  below; at least 0.95 of the exact search's first ten found).
- The local model (default: after the spike, `voyage-4-nano` on ONNX Runtime in the worker and the
  API, on the processor, as a third choice in Settings beside Voyage's API; AI's local-model mode
  on the desktop stays on "Later").
- The subscription (default: Cash Gear's own Anthropic and Voyage keys from the host's
  environment; a workspace chooses its own key or Cash Gear's; a monthly allowance per workspace
  set by whoever runs the server, reserved before each call; no billing in 0.13.0).

**Tasks**

*M13.1 A plugin's network*

- [ ] The manifest's hosts, shown and approved in Settings → Plugins; the plugins origin's CSP per
      bundle (`connect-src` those hosts); the hostile plugin still blocked from every other host.

*M13.2 Plugins in the change feed*

- [ ] A `plugin` change for each add, update, switch and removal; a tab's list read again on it;
      older builds ignore the type.

*M13.3 Property values by meaning*

- [ ] The `embed` job reads a row's values by the default above, and embeds it again when they
      change, formulas and rollups included.

*M13.4 The approximate index and a local model*

- [ ] The index past the threshold, fed by `EmbeddingChanges`, over-fetching for the permission
      filter.
- [ ] The spike, then the local model behind `IEmbeddingProvider`: its own model's vectors, a model
      change embedding everything again, as Phase 10's.

*M13.5 AI by subscription*

- [ ] A workspace's choice of key; the allowance, reserved before a call and settled after it;
      usage shown against it; refused past it (`ai.limit`).

**Acceptance criteria**

- A plugin reaches the hosts an admin approved and no other; a new host in an update waits for
  approval.
- An added, updated, switched or removed plugin reaches an open tab without a reload.
- A question finds a row by a property value its text does not hold, never by a person's.
- At 1,000,000 chunks, search by meaning answers within budget, and finds at least 0.95 of the
  exact search's first ten.
- With the local model, no text leaves the host for embeddings.
- A workspace on the subscription uses AI with no key of its own, and is refused past its
  allowance.

**Performance benchmarks**

- Retrieval by meaning over 1,000,000 chunks, p95 ≤ 300 ms, less the provider's time.
- The local model: the spike sets the budget for a chunk and a question on the host's processor.
- Typing between ten plugin frames within Phase 10's budget, with networked plugins.

**Risks**

- A plugin with rows and a network sends them away: approval names both together, and an admin
  can turn it off at once.
- An approximate index misses a page the exact search finds: recall measured, exact below the
  threshold.
- A local model is too slow on the host: the spike decides before anything is built on it.
- Subscription use runs past an allowance with calls at once: tokens reserved before each call.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `INTEGRATIONS.md`, `DATA_MODEL.md`, `ARCHITECTURE.md` and `OPERATIONS.md` updated.
- Tags `phase-13` and `v0.13.0`; "Later" reviewed with you.

---

## Phase 14: Publishing

**Goals**

A published site at a domain its workspace owns; publishing changes that reach an open tab; a Sites
process that bounds what one address may ask of it; files on sites, on share links and in members'
reads found by an index of rows' files rather than by a scan.

**Dependencies**

Phase 9's Sites process and Phase 11's proof of a domain by DNS. A spike on the production host
before M14.4's certificates: its IIS bindings read, and one catch-all binding tried on a scratch site.
A test host name of yours, and Let's Encrypt's subscriber agreement, which are yours to give.

The spike ran on 2026-11-22 (DECISIONS.md, "Phase 14: the host spike"): IIS refuses a catch-all
binding over its Centralized Certificate Store, and a store binding by name needs a port-wide HTTP.sys
entry that would stand between the host's unbound names and its default certificate. So each name is
bound as the host's other sites are, by a scheduled task (`deploy/iis/site-bindings.ps1`), and the
host's catch-all http site sends ACME's path alone to the sites' own host.

Sized on 2026-11-22, against 0.13.0 (nothing run):

- **Custom domains.** The Sites process routes by path only (`/{slug}`, `/{slug}/{pageId}`,
  `/{slug}/files/{assetId}`); the renderer writes every link under `/{slug}` (`PageUrl`, `FileUrl`
  and three direct uses), and a page's cache key holds the site. A site at its own host name is a
  second way to the same `SiteState`, with links from `/`. Proving a name by DNS exists (Phase 11's
  `cgw-verify=` `TXT` record through DnsClient, `ISsoDns`, and the mock's DNS stand-in). Nothing on
  the host makes certificates: the `*.cashgearerp.com` certificate is bound by SNI to three names,
  and IIS takes a binding for another name only from an administrator, unless one catch-all binding
  over IIS's Centralized Certificate Store serves every name; whether the host's other sites on 443
  and 80 allow that is what the spike finds. In development a site's host can be any `*.localhost`
  name, which Chrome sends to the loopback address, so the e2e stack needs no DNS.
- **The change feed.** Publishing writes no change; the share dialog and Settings read the routes
  when they open. Phase 13's `plugin` change is the pattern: every build ignores a type it does not
  know (`entityRecord` and `batchOf` drop it).
- **The rate limit.** The Sites process has no limiter (an unknown slug is remembered 5 s); the
  API's (`Http.cs`) is a fixed window per partition in process. IIS runs both in process, so the
  client's address is the connection's.
- **Row files.** A site's or share link's file check (`SharedDatabases.ShowsFileAsync`) is
  `Values LIKE '%<id>%'` over the scope's databases' rows. Found while sizing, by reading (a test
  confirms it first): a file in a row's file cell is in `AssetRefs` only once the row's own document
  is derived (`DocJobs.RowFilesAsync`, run only for a page with a document and only when it changes).
  Until then a member other than its uploader cannot read it (`AssetService.CanReadAsync`), and the
  hourly clean-up marks it unreferenced and deletes it 30 days after; blob soft delete keeps its
  bytes 30 days more. Production has held rows' files since 0.5.0 (2026-11-14), so the first could
  go from 2026-12-14.
- **The budget.** The initial JavaScript is 349.5 kB of 350. What the first screen gains is the
  engine's `site` event (a case and an event kind); the domain screens are in Settings and the share
  dialog's publish view, both loaded later, with their words in sections (`i18n/sections.ts`);
  measured after every change (`bench/phase1.mjs`'s `initialJs`).
- **CI.** The Windows job takes about 110 of its 180 minutes; the phase's specs (a site at a
  `*.localhost` host, the feed, the limit) add a few minutes in Chrome and Edge.

**Questions for you (one batch)**

- How the themes split (default: two releases, this phase and Phase 15, AI further).
- Certificates for a site's domain (default, after the spike: made by the worker by ACME from Let's
  Encrypt, the HTTP-01 challenge answered by the Sites process, kept in IIS's Centralized
  Certificate Store and renewed 30 days before they end, behind one catch-all binding on the sites'
  site added once by `install.ps1`; if the spike finds the host cannot take that binding, an
  administrator's step per domain by a script).
- Who adds a domain (default: owners and admins prove a host name for the workspace by a DNS `TXT`
  record, as single sign-on's domains; whoever may publish a site chooses one of them for it; one
  site a host name).
- The spike and a test domain (default: on the production host over Remote Desktop at a quiet hour,
  with your sign-in: its bindings read, the catch-all tried on a scratch site and removed; a host
  name of yours outside `*.cashgearerp.com`; Let's Encrypt's staging environment first).

Proposed defaults, logged with the answers: a domain serves the site's root at `/`, its pages at
`/<pageId>`, files at `/files/<assetId>` and a `robots.txt` of its own, and the slug's address
redirects there (302) once the certificate is live; the Sites process allows one address 300
requests a minute for pages and files on any site (the plugins host 1,200), answering 429 with
`Retry-After`, `robots.txt`, health and ACME's challenges outside it; a `site` change goes to whoever
can read the site's root page, a domain's to owners and admins.

**Tasks**

*M14.1 Row files*

- [ ] A test that shows the defect above, then `DatabaseRowFiles` (a row, a property, an asset)
      written in the same statements as a row's values on every server path (`RowStore`'s writes,
      `DatabaseOps`, the tree's), and filled for existing rows by a worker job once.
- [ ] A row's file readable by whoever can read its row; the clean-up counts it as held; the site's
      and share link's check by the index, still only for a property some view shows.

*M14.2 Publishing in the change feed*

- [ ] A `site` change for each publish, change and unpublish (whatever the reason: a person, the
      switch, the purge) and for a domain's changes; the engine's `sites` event; the share dialog's
      publish view and Settings → Publishing read again; older builds ignore the type.

*M14.3 A rate limit in the Sites process*

- [ ] Per address on every host the process answers, before anything reads the database; 429 with
      `Retry-After` and a page in the site's language.

*M14.4 Custom domains*

- [ ] The spike, on the host (done 2026-11-22; the binding by a scheduled task, not the store).
- [ ] A workspace's host names, proven by DNS and checked again before each renewal; one attached
      to a site by whoever may publish it (the share dialog's publish view); Settings → Publishing's
      domains for owners and admins; audit.
- [ ] The Sites process by host name: a domain's site from `/`, its links, files, cache keys and
      `robots.txt`; the slug's redirect; a host it does not know, the 404 page.
- [ ] Certificates as answered: an ACME client in the worker (account, order, HTTP-01, a CSR by
      .NET's `CertificateRequest`), the challenge answered by the Sites process, the certificate in
      a folder the host's scheduled task binds from, renewal and removal; a mock ACME server for the
      tests; `install.ps1`'s part (the task, and ACME's path sent on from the host's catch-all http
      site).

**Acceptance criteria**

- A file in a row's file cell is readable by every member who can read the row and is never cleaned
  up while a row holds it; a site's and a share link's file check answer by the index.
- A publish, change or unpublish from any device reaches an open share dialog and Settings without
  a reload; an older build ignores it.
- An address past its limit is answered 429 on every host of the Sites process while other
  addresses read on, and nothing it asks past the limit reaches the database.
- A site attached to a proven domain reads there with no account and with script off, over https by
  a certificate made for it, in English and in Arabic; its slug's address leads there; a name not
  proven, or proven by another workspace, never serves a site; an unpublish holds at the domain
  within a minute too.

**Performance benchmarks**

- A published page of 2,000 blocks at its domain, first byte p95 ≤ 200 ms from the cache (Phase 9's),
  the limiter and the host's lookup included.
- A site's file check in a database of 50,000 rows holding 100,000 files, p95 ≤ 20 ms (0.13.0's scan
  measured beside it).

**Risks**

- A catch-all binding takes another site's requests on the host: the spike reads every binding
  first; an administrator's step per domain if it cannot be done safely. (Found: the store's
  catch-all is refused by IIS; names are bound one by one by a task that touches no other site's.)
- A domain taken over: a token per workspace in `TXT`, read again before every renewal; a name
  removed stops serving at once and its certificate is deleted.
- Let's Encrypt's limits (certificates per registered domain a week, orders per account): staging in
  every test, renewals spread, a failed order retried with backoff.
- The index out of step with the values: written in the same statements; a check compares them.

**Definition of done**

- Acceptance criteria and benchmarks proven; a site at a host name of yours on the deployed host
  once you have installed it.
- `DATA_MODEL.md`, `ARCHITECTURE.md`, `INTEGRATIONS.md` and `OPERATIONS.md` updated.
- Tags `phase-14` and `v0.14.0`; a card for Phase 15.

---

## Phase 15: Automations

**Goals**

A database that acts on its own changes: rules of a trigger, conditions and actions in order, run on
the server whoever made the change and from whichever device; buttons in rows that start them;
webhooks out; every run recorded where the people who own the rule can read it; nothing reaching the
ERP.

**Dependencies**

Phase 4's database rules and their C# port, Phase 6's inbox, Phase 8's mail, Phase 11's groups.
No other repo.

Sized on 2026-11-24, against 0.14.0 (nothing run):

- **Where a change is seen.** Every person's edit to a row goes through `OpsService.ApplyOneAsync`
  and ends in `DatabaseOps.FlushAsync`, which already holds a row's old values, its new ones and the
  properties that changed (`WriteValuesAsync`'s `row.Changed`); nothing keeps them after. Other paths
  write rows without it: a type change (`ConvertRowsAsync`), recomputed formulas and rollups
  (`RecomputeAllAsync`, also the worker's `RecomputeJob`), a CSV import (`DatabaseService`), the
  tree's trash, restore and move (`DatabaseTree`) and the purge. The change feed carries an id and a
  version only; no audit or history holds a row's values.
- **Where a rule runs.** The worker's `JobLoop` runs `IJob`s that each poll their own columns (no
  queue table; `JobStates` is health only); `MailSendJob`'s attempts and backoff and
  `SiteCertificateJob`'s due times are the pattern for a run that fails or waits. Row values are JSON
  (`DatabaseRow.Values`) queried in memory by the C# port (`RowCache.cs`, `Query.cs`); there is no
  typed value table, so a date trigger reads a database's rows in the worker as a view's query does.
- **Who acts.** Every check needs a member (`Access`, `PageGate`); there is no bot principal, and the
  worker today skips access and writes with no actor (`RecomputeJob`). Audit already writes
  `Actor.System`, and a `CreatedBy` of `Guid.Empty` reads as nobody (`RowStore.ToData`).
- **What an action can make.** The server never makes a page; `cgw-ydoc` merges, diffs, compacts and
  reads a document but cannot build or copy one; a row template's body is copied by the client
  (`session.copyBody`, `withNewIds`). Notifications have three kinds, each with a page and an actor
  that cannot be null; older clients drop a kind they do not know (`inbox.ts`'s `KINDS`), and the mail
  job mails only its own kinds.
- **Calls out.** `SafeFetcher` (`Previews/LinkPreviews.cs`) resolves a name and connects only to the
  public address it checked (private, CGNAT, link-local, metadata, multicast, reserved, NAT64, 6to4
  and Teredo refused; DNS rebinding closed), on 80 and 443, GET only, redirects followed by hand and
  checked again; single sign-on reuses its `Public()` check. `PluginHosts` checks a name's shape only.
  Secrets in SQL are Data Protection's output by purpose (`Cgw.Ai.Key.v1` and others), which the
  worker can open.
- **Property types.** A client keeps a type it does not know, reads it as empty and does not edit it
  (`cellOf`, `editKind`); the server refuses a `db.create` or `db.update` naming a type outside
  `PropertyTypes.All`, and there is no count of property types like `viewTypes`. Every type so far
  came in Phase 4. Production's server has been deployed after its web app, so a client must not
  offer a type its server would refuse.
- **The budget.** The initial JavaScript is 349.6 kB of 350 (0.14.0): the rules' screens load with a
  database's view or with Settings, their words in sections (`i18n/sections.ts`).

**Questions for you (one batch)**

- Where rules live (default: on a database, edited from its views' toolbar, "Automations", by whoever
  has full access to the database; a workspace's list in Settings → Automations for owners and
  admins, with a switch for each rule and one for all).
- What starts a rule (default: a row added; properties changed, to or from a value; a date
  property's day or time reached, with an offset; a schedule, daily, weekly or monthly at a time; a
  button pressed. Only people's edits through the operations and buttons: a CSV import, a type change
  and recomputed formulas start nothing in 0.15.0).
- Who a rule acts as (default: its author, whose access is checked again at every run; a run its
  author could no longer make stops, says why in the run log and tells the author in the inbox; a
  row's editor shows "Automation" with the author's name).
- What it does (default, in order, each step under conditions over the row: set properties; add a
  row to a database the author can edit, with a template's values, icon and cover; notify people,
  groups or a person property's people, in the inbox and by their mail setting; call a webhook.
  Nothing reaches the ERP: the server holds no ERP session or key).
- A new row's body from a template (default: copied by the worker through a new `cgw-ydoc` call that
  writes a new page's first update, its block ids made once by the server, held to S1's rules by
  tests; never into an existing page. The other choice: values only, the body on "Later").
- Webhooks (default: added by owners and admins only; https to a public address, checked by
  `SafeFetcher`'s rules at every connect, POST only, no redirect followed; JSON of the properties the
  rule names, never a person's email; signed by HMAC-SHA256 with a secret per webhook under Data
  Protection; 10 s, retried after 1 m, 5 m, 30 m and 2 h, then given up and logged).
- Limits (default: a change a rule made starts other rules up to 3 deep; a rule at most 100 runs a
  minute and a workspace 1,000; 50 rules a database; runs kept 30 days).

Proposed defaults, logged with the answers: rules are records synced as views are
(`automation.upsert`, `automation.delete`, the feed's `automation` change, ignored by older builds);
a run's changes are ordinary operations with ids of their own, so devices merge them by Phase 4's
per-property rules and a replay changes nothing (`AppliedOps`); date and schedule triggers keep the
workspace's time zone (an IANA name owners set in Settings, first the creating person's); the button
is the twenty-first property type, with a `propertyTypes` count beside `viewTypes` so the server
keeps a type an older client did not send, offered by a client only once its server says it knows it
(`/version`).

**Tasks**

*M15.1 Rules and their events*

- [ ] Rules as records (a trigger, conditions in `queryRows`' filter language, steps in order) in
      `@cgw/workspace`'s `db/automations.ts` beside `db/plan.ts`, with vectors the C# port reads;
      their operations checked on the server; their sync and the feed's change; the old-build spec's
      cases.
- [ ] Row events written in `FlushAsync`'s transaction (the row, the properties changed, old and new
      values) only while the database has a rule switched on; a test of every path that writes rows
      and the events it makes or does not.

*M15.2 The runner*

- [ ] A worker job that takes events, due dates and schedules, runs each rule's conditions and steps
      as its author through `DatabaseOps`' checks, and records the run, its steps and its result; the
      depth and rate limits; the workspace's time zone.
- [ ] Steps: set properties; add a row (its body as answered); notify (an inbox kind `automation`
      and its mail); call a webhook (`SafeFetcher` taken to POST, signed, retried).

*M15.3 Screens and buttons*

- [ ] The rule editor (the trigger, conditions by `CgFilterBuilder`, steps by `CgSortableList`), the
      run log for a rule and for a row (its properties' "Runs"), Settings → Automations and the time
      zone, in English and Arabic, under Axe.
- [ ] The button property: its cell and the rule it starts; pressed offline, a notice that it runs
      once the device is online, never a queued press run twice.

**Acceptance criteria**

- A rule started by a change from any device, online or synced later, runs once; changes made offline
  run their rules in order when they reach the server.
- A rule does only what its author may: one whose author lost access stops, recorded; nothing a rule
  does is shown to anyone who could not read the row.
- Rules that start each other stop at the depth limit, recorded, the rows as the last allowed run
  left them.
- A webhook never reaches a private, loopback or link-local address, by its name or a redirect, and
  its receiver can check its signature.
- An older build keeps a database's rules and button properties while editing its rows.
- No step reads or writes the ERP.

**Performance benchmarks**

- A rule's first step after the change that starts it, shown in an open tab, p95 ≤ 2 s.
- The server's processor time per push to a database with 10 rules within 10 % of the same push with
  none (`bench/phase8-server.mjs`).
- A paste of 1,000 cells that starts a rule in each row: every run done ≤ 60 s, typing on another
  page within Phase 6's keystroke budget.
- Date triggers over a database of 50,000 rows found ≤ 500 ms of the worker's time a pass.

**Risks**

- Rules that start each other without end: the depth and rate limits, each run recorded with what
  started it.
- A rule as a way round permissions: it acts as its author, checked at every run; webhooks by owners
  and admins only.
- A webhook as a way into the host's network: the address checked at connect, no redirect for POST.
- A run applied twice after a worker restarts: keyed by its event, its operations by their ids.
- A web app newer than its server offers what the server refuses: offered once the server knows it.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `DATA_MODEL.md`, `ARCHITECTURE.md`, `SYNC_DESIGN.md` and `OPERATIONS.md` updated.
- Tags `phase-15` and `v0.15.0`; a card for Phase 16.

---

## Phase 16: Forms

**Goals**

Rows collected by a form: a database's form view, its properties as questions, answered by members
in the app (offline too) and by anyone with a form link a member made, with script off, in English
and Arabic; the link showing nothing of the database but its questions; an answer starting Phase 15's
rules.

**Dependencies**

Phase 15 (the trigger and the notice), Phase 9's Sites process, Phase 14's rate limit. No other repo.

Sized on 2026-11-24, against 0.14.0 (nothing run):

- **Views.** Seven types; one an older build does not know is drawn as a table (`viewRecord`,
  `registry.ts`'s `viewType()`, the import), and the server keeps a type and its settings an older
  build did not send (`DatabaseOps.cs`'s `ViewTypeOrder`, `ConfigKeysByTypes`). `SharedDatabases.cs`,
  `ChartViews.cs` and `SiteDatabaseHtml.cs` name view types too. A form is the eighth.
- **A link that writes.** A share link (`ShareLink`: a page and its subtree, `Levels.View` forced,
  rows refused) only reads: its one POST is a view's query, and comments need a session. No route
  takes a row or an upload without a member; `RateLimits.Anonymous` gives an address 120 requests a
  minute.
- **Where a link's page is drawn.** The Sites process draws pages with no script and no cookies and
  reads SQL and Blob only (its identity denied the key ring). A plain HTML form works with script off
  and can post to the API, which writes, so the Sites process stays a reader. The app's share view
  (`#/s/{token}`, `SharedView.tsx`) has a read-only `DatabaseHost`.
- **Who made the row.** No principal stands for a form; a `CreatedBy` of `Guid.Empty` reads as
  nobody.
- **The library.** `CgFormLayout`, `CgSortableList` and `CgStepper` exist; no form builder is
  needed beyond them.

**Questions for you (one batch, when the phase starts)**

- Who may answer (default: members in the app, offline too, as a row they add; and anyone with a form
  link, made by whoever has full access to the database, with its own switch, an optional closing
  date and number of answers; the link shows the form's questions and nothing else).
- Where a link's page is drawn (default: by the Sites process, under a path no slug can take on the
  sites' host, as HTML with no script, in the form's language; posting to the API's
  `POST /api/v1/forms/{token}`, which adds the row and sends the browser to the form's thank-you
  page).
- Questions (default: a form's questions are its properties in an order, each with a label, help
  text and whether it is required: text, number, select, multi-select, status, date, checkbox, URL,
  email and phone; files, people and relations for members only, as nothing takes an upload or shows
  a person without a session; pages of questions, a page shown or skipped by earlier answers, decided
  on the server between pages for a link).
- Abuse (default: an address 10 answers a minute a form and 100 a day; a hidden field a person never
  fills; an answer at most 64 KB; no CAPTCHA, which would be a third-party script on a page with
  none, on "Later").
- What an answer starts (default: Phase 15's trigger "a form answered", with the answer's values; the
  row's creator shown as the form; an optional notice to chosen people by Phase 15's notify step).

Proposed defaults, logged with the answers: `form` is the eighth view type, `viewTypes` 8, with
`ViewConfig.form` (questions, pages, conditions, the thank-you text, the language); a form link is a
`FormLinks` record of its own, its token kept as a hash as a share link's is, never a share link's
scope; the answer route stands outside antiforgery (it has no session) and checks every value by the
C# port's coercion; an answer's address is in its audit entry, never with the row; the Sites
process's CSP names the API in `form-action`.

**Tasks**

*M16.1 The form view*

- [x] The type, its settings (questions, order, labels, help, required, pages, conditions) and its
      view for members, an answer added as `page.create` and `row.update`, offline too; the old-build
      spec's cases.

*M16.2 Form links*

- [x] `FormLinks` and their routes (make, switch, close, delete) with audit; the API's answer route
      (no session, its own rate limit, values checked, the row added through `DatabaseOps` with no
      member).
- [x] The Sites process's form page, its pages of questions and its thank-you page, in English and
      Arabic, script off, under Axe; a link switched off, closed, full or unknown answered by a page
      saying so.

*M16.3 Answers and rules*

- [x] The "a form answered" trigger; the notice; the count of answers in the view; the abuse checks.

**Acceptance criteria**

- A member answers a form offline and the row reaches the database once online; an older build shows
  the form view as a table and keeps its settings.
- Anyone with a form link answers it with script off, in English and Arabic, and reads nothing of the
  database: no row, no option a question does not show, no person.
- A link switched off, closed, full or deleted stops taking answers within a minute.
- An address past its limit is answered 429 while others answer on; a guessed token adds nothing.
- An answer starts the rules for "a form answered", once.

**Performance benchmarks**

- A form link's page, first byte p95 ≤ 200 ms from the cache (Phase 9's).
- An answer to its row in an open tab of the database ≤ 2 s; 50 answers a second across links for a
  minute, the answer route's p95 ≤ 300 ms, typing in the app within Phase 6's budget.

**Risks**

- A form link as a way to read the database: answers are written only, the page shows its questions
  only; a test reads every route a link opens.
- Spam fills a database: limits per address and form, the hidden field, the number of answers, the
  switch.
- The Sites process starts writing: the API writes; the Sites process's identity keeps its reads
  only.
- A value no property can hold: coerced by the shared conversion table, or refused naming the
  question.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `DATA_MODEL.md`, `ARCHITECTURE.md`, `SYNC_DESIGN.md` and `OPERATIONS.md` updated.
- Tags `phase-16` and `v0.16.0`; a card for Phase 17.

---

## Phase 17: Workflows and tasks

**Goals**

Rules that wait and decide: steps that wait for a time or a change, branches, approvals asked of
people in their inbox. Tasks that repeat, remind and nest: recurring rows, reminders on dates,
sub-items, dependencies drawn on the timeline, a unique id for each row.

**Dependencies**

Phase 15's runner, Phase 9's timeline and Phase 12's tree grid. Track U20 (links between bars) for
M17.4 and U21 (recurrence) for M17.2.

Sized on 2026-11-24, against 0.14.0 (nothing run):

- **A run that waits.** Phase 15's runs end in one pass; a wait keeps a run's place in SQL and the
  worker goes on from it, as the certificate job's due times do.
- **Dates.** A date is `{ start, end? }`, a day or a UTC instant, with `includeTime` on the property
  and no time zone; nothing holds a reminder. The library's recurrence and reminder code is inside
  `CgScheduler` (`schedulerRecurrence.ts`, `SchedulerRecurrenceFields.tsx`) and not exported.
- **Sub-items.** Two-way relations to the same database exist (`relations.ts`, `RelationSetup.tsx`).
  The table's tree grid has two levels, a group and its rows (`table/items.ts`'s `ariaLayout`); no
  row holds rows.
- **Dependencies.** `CgTimeline` (pinned at `9f5a208`) draws items, lanes, moves and resizes, and no
  links between bars.
- **A unique id.** Rows are made on devices, offline too, with UUIDv7 ids; a number in order can
  only be given by the server, when it first stores a row (`DatabaseOps.CreateRowAsync`).

**Questions for you (one batch, when the phase starts)**

- Steps (default: a rule's steps may also wait (a time, until a date property, or until the row
  matches conditions; at most 90 days), branch (if, else if, else over the row) and ask for an
  approval; a run keeps its place in SQL and goes on when its wait ends; a rule changed while runs
  wait lets them finish on the version they started with).
- Approvals (default: asked of people, a group (any one, or all of it) or a person property's people;
  an inbox item with Approve, Reject and a comment, and a mail; a deadline after which the run takes
  its "no answer" branch; the answer kept in the run log and, if chosen, in a property).
- Recurring rows (default: a database's template with a rule (daily, weekly on chosen days, monthly
  on a day or a weekday, yearly); the next row added by the worker when the last is done or on its
  date, in the workspace's time zone, its dates moved by the step).
- Reminders (default: on a date property for a person property's people, or by a person on a row for
  themselves; at the time, or 15 minutes, an hour, a day or a week before; in the inbox and by mail;
  a day with no time at 09:00 in the workspace's time zone).
- Sub-items (default: a database's switch that picks or makes a two-way relation to itself as
  "Parent" and "Sub-items"; the table nests sub-items under their parent up to five levels; a board
  and a list show a parent's count; a filter keeps a match's parents shown).
- Dependencies (default: a two-way relation to the same database as "Blocked by" and "Blocking"; the
  timeline draws arrows between bars (Track U20); moving a bar moves the rows it blocks by the same
  days when the database says so; a loop refused).
- A unique id (default: a property type, a prefix and a number the server gives when it first stores
  a row, never reused, never edited; "—" on a device until then).

Proposed defaults, logged with the answers: the unique id is the twenty-second property type, behind
Phase 15's `propertyTypes` count; reminders and approvals are inbox kinds an older build drops; a
waiting run holds no lock and reads its row and its author's access again when it goes on; recurrence
is held to vectors the client and the C# port both read (the 31st, 29 February, a time-zone change).

**Tasks**

*M17.1 Waits, branches, approvals*

- [x] A run's place in SQL and the worker going on from it; waits, branches and approvals in the rule
      editor; the approval's inbox item and mail; deadlines.

*M17.2 Recurring rows and reminders*

- [x] Recurrence (Track U21) on a database's template, its vectors, the worker's next row; reminders
      on date properties and on a row, delivered by the worker to the inbox and by mail.

*M17.3 Sub-items*

- [x] The switch and its relation; the table's tree to five levels (`ariaLayout`'s levels, places and
      sizes), in both directions; a board's and a list's counts; filters that keep parents.

*M17.4 Dependencies*

- [x] The relation; the timeline's arrows (Track U20) and dependents moved with their blocker; a loop
      refused by the planner and by the C# port.

*M17.5 A unique id*

- [x] The property type, its numbers given in the row's first write on the server, shown, sorted and
      filtered; the old-build spec's cases.

**Acceptance criteria**

- A run waits a day and goes on once after the worker restarts; a branch takes the path its
  conditions name; an approval goes on by the first answer (or all of the group's), or by "no answer"
  after its deadline.
- A recurring row appears once and on time in the workspace's time zone, never twice from a restart.
- A reminder reaches the inbox within a minute of its time and the mail by the person's setting,
  never for a row the person can no longer read.
- Sub-items nest in the table to five levels, in both directions, read well by a screen reader; an
  older build sees the relation as it is.
- The timeline draws dependencies in both directions; a loop is refused; moving a blocker moves its
  dependents when the database says so.
- A row made offline gets its number once it reaches the server; no two rows share one.

**Performance benchmarks**

- The table with sub-items, 50,000 rows of which 10,000 parents: first rows within Phase 4's budget.
- A timeline of 50,000 rows with 10,000 dependencies: first bars and a drag within Phase 9's budgets.
- With 10,000 runs waiting, a pass of the worker finds those due ≤ 200 ms.
- 10,000 reminders due in one minute, every one in the inbox ≤ 60 s.

**Risks**

- A run that waited acts on a row that changed: it reads the row and its author's access again
  first.
- Recurrence at a month's end or a time-zone change: shared vectors, the zone by its IANA name.
- A unique number given twice: given by the server alone, in the row's insert's transaction.
- Deep nesting slows the table: five levels at most, the tree made with the query.

**Definition of done**

- Acceptance criteria and benchmarks proven.
- `DATA_MODEL.md`, `ARCHITECTURE.md`, `SYNC_DESIGN.md` and `OPERATIONS.md` updated.
- Tags `phase-17` and `v0.17.0`; a card for Phase 18.

---

## Phase 18: AI, further

**Goals**

AI's completions with no text leaving the host; Cash Gear's subscription paid for.

**Dependencies**

Phase 13. A spike before M18.1: open-weight instruction models on the host's processor, measured for
speed and for the app's own actions' answers in English and in Arabic. An account of Cash Gear's at
the payment provider you choose, its sandbox keys for the live test, and its prices, which are yours.

Sized on 2026-11-22, against 0.13.0 (nothing run): every completion goes through `AiService` and an
`IAiProvider` with what `AiRequestBuilder` built, streamed as `AiChunk`s; three actions answer strict
JSON by a schema. The largest requests are `ask` (8 sources of 8,000 characters) and `summarise`
(100,000 characters); a processor reads a prompt at a few hundred tokens a second at best, so a local
model needs smaller limits of its own per action. `Cgw.LocalModel` runs ONNX Runtime 1.31.1 one run
at a time a process, loaded on first use; a generative runtime (ONNX Runtime GenAI, MIT) brings its
own runtime version, which must agree with it. The subscription's allowances are the environment's
(`Ai__Subscription__*`, per workspace by id); nothing records a plan, a customer or a payment.

**Questions for you (one batch, when the phase starts)**

- Where the model runs (default: on the server, as the embedding model, for the web and the desktop
  alike, the request still built in one place; a model on the desktop stays on "Later").
- The model (default, after the spike: Apache-2.0 or MIT, about 4 billion parameters at 4 bits:
  Qwen3-4B-Instruct-2507 or Phi-4-mini-instruct, by the spike's speed and its Arabic).
- What it does (default: every action, each with smaller limits the spike sets; JSON answers held to
  the action's schema while they are made; one answer at a time a process, the rest waiting).
- The payment provider: yours (for example Paddle as merchant of record, Stripe, or invoices outside
  the app).
- What is charged: yours (for example plans of a monthly allowance a workspace, tokens metered with a
  cap, or a price a member).
- The spike's downloads, each into a folder of its own under `target/`, as Phase 13's were.

**Tasks**

*M18.1 Completions on a local model*

- [x] The spike; then the provider `local` behind `IAiProvider`: its package made once by a script
      with its hashes pinned, `install.ps1`'s part, Settings → AI's "On this server" for completions,
      the queue, each action's limits, JSON answers held to the schema.

*M18.2 Billing*

- [x] Plans and their allowances; the provider's own checkout and portal, opened from Settings → AI
      by owners; its webhooks verified and applied once; the allowance read from the plan (the
      environment's overrides still win); a daily reconcile; audit; a mock provider for the tests and
      a live test in its sandbox by your keys.

**Acceptance criteria**

- With the local model, an action's answer streams in English and in Arabic, a JSON action's answer
  holds to its schema, and no text leaves the host.
- An owner subscribes in the provider's checkout and the workspace's allowance follows within a
  minute; a cancelled or failed payment ends it as the plan says; a webhook replayed or forged
  changes nothing; no card or payment detail ever reaches the app.

**Performance benchmarks**

- Set by the spike: a rewrite of 2,000 characters on the host, first text and the whole answer.
- A webhook to the allowance shown ≤ 60 s.

**Risks**

- A local model too slow or too weak in Arabic: the spike decides, with the app's own prompts.
- Two ONNX Runtime versions in one process: the spike builds both models in one host first.
- The plan and the allowance disagree: webhooks verified and applied once, and reconciled daily.

**Definition of done**

- Acceptance criteria and benchmarks proven; the live test in the provider's sandbox.
- `INTEGRATIONS.md`, `DATA_MODEL.md`, `ARCHITECTURE.md` and `OPERATIONS.md` updated.
- Tags `phase-18` and `v0.18.0`; "Later" reviewed with you.

---

## Later

Not planned in any phase; listed so they are not lost. Reviewed on 2026-11-15: what was chosen
went to Phases 8 to 10, and the earlier phases' deferrals that were not chosen are listed here.
Reviewed again on 2026-11-18, after 0.10.0: sign-in and permissions, ERP at scale, AI and plugins,
and the database items were chosen, and went to Phases 11 to 13 on 2026-11-19 (`DECISIONS.md`).
Reviewed again on 2026-11-22, after 0.13.0: publishing (Phase 9's four items) and AI further (AI
completions on a local model, billing for the subscription) were chosen, and went to Phases 14 and
15 the same day; the rest stays (`DECISIONS.md`). Reviewed again on 2026-11-22, after Phase 14:
nothing moves (Phase 15 is next); Phase 14's two deferrals are added. On 2026-11-24 three themes
that were not on it (automations, forms, workflows and tasks) became Phases 15 to 17, and AI,
further, Phase 18.

- Embedded presentations, once that app exists.
- Comments offline (online only from 0.6.0).
- SAML and SCIM for single sign-on (OpenID Connect only is proposed for 0.11.0).
- Linux desktop build; a mobile app.
- A shared `@cashgear/app-kit` for the platform split, theme and shortcuts (D1: once a third app
  needs it).
- SQLite on OPFS in the browser (D11: it needs COOP/COEP, which blocks embeds).
- Yjs 14, when its binding is stable.
- A SignalR backplane or Azure SignalR Service, past about 5,000 to 10,000 connections on a node
  (Q17).
- An end-to-end test of access lost without a feed change (the hub's 60 s re-check).
- Left by Phase 8: a Notion export's people columns as members (text in 0.8.0) and its relations
  to pages outside the export; an attachment's bytes fetched before it is first opened, so a
  second device has them offline.
- Not while the hard limit stands: snapshotting an ERP view into a database, which would store ERP
  data in a Workspace table.
- Left by Phase 14: more than one host name a site (one in 0.14.0, its slug's address leading
  there); names proven for a certificate by DNS-01 (a wildcard, or a name whose port 80 cannot reach
  the host), where 0.14.0 uses HTTP-01 alone.
- Left by Phase 18: a model on the desktop, on the device itself (the server's only in 0.18.0); AI
  charged otherwise than by plans of a monthly allowance (tokens metered with a cap, a price a
  member), and payment other than Paddle's (invoices outside the app); a larger model, or one on a
  graphics card, should the host gain one.

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
| Text reported saved is lost in a browser | 8 | M8.1: the cause found, "Saved" waits for what lasts, kill tests at size |
| A pasted or imported value lands as the wrong type | 8 | The conversion table, shared vectors, a report of what was skipped |
| A mail reaches someone who lost access | 8 | Access checked again when sending; the inbox's excerpt rules |
| A published page shows more than the publisher meant | 9 | A share link's scope rules, an origin of its own, unpublish at once |
| An older build rewrites a timeline view | 9 | The old-build spec; the server keeps what an older client does not send |
| Embeddings leak content across permissions | 10 | Filtered at query time; the permission matrix |
| A third-party plugin reaches the document or the session | 10 | A sandboxed iframe on its own origin, a message contract, no network |
| A path decides access without a group's row, or an older build drops one | 11 | One rule held by an oracle over every path; rows an older build did not send kept |
| An account taken over through a workspace's own provider | 11 | Domains proven by DNS, the email checked against them, the id token checked in full |
| An older build turns a chart view into a table | 12 | `viewTypes` read as the types that build knew; the old-build spec |
| The ERP's paged queries answer differently from 0.10.0's | 12 | The suite compares both on the same records (Track E10) |
| A plugin with a network sends away what it is shown | 13 | Hosts approved by an admin, rows and network approved together |
| A catch-all binding takes another site's requests, or a site's domain is taken over | 14 | The spike reads every binding first; a token per workspace in DNS, read again before each renewal |
| A row's file is cleaned up while a row holds it | 14 | An index of rows' files, written with the values, counted by the clean-up |
| Rules start each other without end, or act past their author's rights | 15 | Depth and rate limits; a rule acts as its author, checked at every run |
| A webhook reaches the host's own network | 15 | Public addresses only, checked at connect; no redirect for POST |
| A form link reads more than its questions, or floods a database | 16 | Answers written only; limits per address and form; the link's switch |
| A waiting run or a recurring row acts twice | 17 | Keyed by its event and due time, its operations by their ids |
| The plan paid for and the allowance disagree | 18 | Webhooks verified and applied once, reconciled daily |

## Verification

Before any phase is called done:

1. The standing checks pass on `main` in CI.
2. Every acceptance criterion has evidence in `PROGRESS.md`.
3. The benchmarks are within budget, or the miss is recorded with your decision.
4. The documents match the code: any design that changed is updated in the same phase.
5. The app is run, in the browser and on the desktop, in English and in Arabic, in light and in
   dark, and the phase's features are used by hand once.
