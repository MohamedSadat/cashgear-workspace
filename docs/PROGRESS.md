# Progress

What is done, with evidence. A box is ticked only when its proof is linked beside it: a CI run, a
test name, a measurement, or a commit. The tasks behind each milestone are in
`IMPLEMENTATION_PLAN.md`.

## Status

| Work | Status | Tag |
| --- | --- | --- |
| Planning documents | Done, 2026-11-11 | |
| Phase 0: Scaffold and spikes | Not started | |
| Phase 1: Core block editor (MVP) | Not started | |
| Phase 2: Cloud document platform | Not started | |
| Phase 3: Offline | Not started | |
| Phase 4: Workspace databases | Not started | |
| Phase 5: Cash Gear ecosystem | Not started | |
| Phase 6: Collaboration | Not started | |
| Phase 7: Editable ERP blocks, plugins, AI | Not started | |
| Track U: `CashGear.React.UI` components | Not started | |
| Track S: Cash Gear Sheet embed and cloud workbooks | Not started | |
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

Milestones

- [ ] M0.1 Scaffold: workspaces, configs, web app, desktop shell, CI, licence gate
- [ ] M0.2 Spike S1: block schema and block ids under collaboration
- [ ] M0.3 Spike S2: old client meets a newer document
- [ ] M0.4 Spikes S3 and S4: Yjs on the server
- [ ] M0.5 Spike S5: RTL and Arabic input
- [ ] M0.6 Spike S6: performance
- [ ] M0.7 Spikes S7, S8, S9: hostile updates, sequence under load, Sheet in an iframe
- [ ] M0.8 Close: results recorded, spike code removed

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| CI green on `main` with all standing checks | | |
| S1: no duplicate ids, ids stable on move, no caret jump | | |
| S2: old build read-only, server bytes unchanged | | |
| S3: `cgw-ydoc` matches Yjs on 1,000 fuzzed documents; no crash; 1 MB compacts in under 200 ms | | |
| S4: YDotNet suite and soak (only if S3 fails) | | |
| S5: RTL and IME checklist | | |
| S6: budgets met at 2,000 blocks; 5,000 usable | | |
| S7: hostile corpus inert | | |
| S8: no missed update with 50 writers | | |
| S9: Sheet draws a range inside an iframe | | |
| Q1 to Q4 answered in `DECISIONS.md` | | |
| Final content expressions in `DATA_MODEL.md` | | |

## Phase 1: Core block editor (MVP)

Milestones

- [ ] M1.1 Shell, themes, languages
- [ ] M1.2 Document model and basic blocks
- [ ] M1.3 Slash menu, Markdown shortcuts, bubble toolbar
- [ ] M1.4 Nesting, selection, drag
- [ ] M1.5 The remaining MVP blocks
- [ ] M1.6 Pages and the sidebar
- [ ] M1.7 Local persistence
- [ ] M1.8 Search
- [ ] M1.9 Desktop packaging and polish

Exit criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Create a workspace | | |
| 2 | Create and organise pages | | |
| 3 | Edit block-based documents | | |
| 4 | Slash commands | | |
| 5 | Format text | | |
| 6 | Drag and reorder blocks, ids unchanged | | |
| 7 | Insert images and tables | | |
| 8 | Autosave (kill test) | | |
| 9 | Open saved documents | | |
| 10 | Search pages, Arabic and English | | |
| 11 | Dark and light themes | | |
| 12 | Arabic and English, RTL | | |
| 13 | Runs in a browser | | |
| 14 | Runs in a Tauri desktop app | | |
| | `LocalStore` conformance on both stores | | |
| | Benchmarks within budget | | |
| | Axe, keyboard-only and screen-reader passes | | |
| | No stand-in component left unlisted | | |

Stand-ins waiting on Track U

| Component | Stand-in in | Replaced |
| --- | --- | --- |
| | | |

## Phase 2: Cloud document platform

Milestones

- [ ] M2.1 Server scaffold
- [ ] M2.2 Identity
- [ ] M2.3 Workspaces and metadata sync
- [ ] M2.4 Documents in the cloud
- [ ] M2.5 Assets
- [ ] M2.6 Permissions and sharing
- [ ] M2.7 Search and history
- [ ] M2.8 Operations

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Sign-up to a second device seeing an edit within 5 s | | |
| A local-only workspace uploads intact | | |
| Authorisation matrix: role × level × endpoint | | |
| Tenant isolation: every entity filtered; cross-workspace requests fail | | |
| Assets unreachable without a fresh signed URL | | |
| Search returns only readable pages, Arabic and English | | |
| View and restore a version; restore undoable | | |
| Two clients converge; outbox replay; 50 writers | | |
| Hostile updates against the real push path | | |
| Compaction killed at each step | | |
| Restore drill from backup | | |
| Security table checked row by row | | |
| Benchmarks and load test within budget | | |
| Deployed | | |

## Phase 3: Offline

Milestones

- [ ] M3.1 Offline availability
- [ ] M3.2 Robust sync loop
- [ ] M3.3 Conflicts
- [ ] M3.4 Versions and migrations
- [ ] M3.5 Crash and recovery
- [ ] M3.6 macOS

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Start, open, edit and create offline; sync on reconnect with no action | | |
| Every conflict row scripted, with its notice | | |
| Old build against a migrated document: read-only, nothing pushed | | |
| 1,000 kills during sync lose nothing reported saved | | |
| Three-client convergence simulator in CI | | |
| Access granted and revoked while offline | | |
| Store and document migrations from every earlier version | | |
| macOS app installs, signs in, edits offline, syncs | | |
| Benchmarks within budget | | |

## Phase 4: Workspace databases

Milestones

- [ ] M4.1 Model and sync
- [ ] M4.2 Table view and property editing
- [ ] M4.3 Filter, sort, group
- [ ] M4.4 Board and list views
- [ ] M4.5 Calendar and gallery views
- [ ] M4.6 Formula, relation, rollup
- [ ] M4.7 Templates and import

Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Every first-release property type in all five views, both languages | | |
| Offline edits on two devices follow the per-property rule | | |
| Client and server give the same rows for the same filter and sort | | |
| 50,000-row database within budget | | |
| Deleting a property or option never corrupts rows | | |

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

- [ ] S1 Cloud platform: open by ticket, save with `If-Match`
- [ ] S2 `/cloud` launch route
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
