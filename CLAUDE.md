# Cash Gear Workspace

A Notion-style workspace for the Cash Gear ecosystem: block documents, a page tree, databases,
embedded sheets and ERP data, in the browser and as a Tauri desktop app.

Status: planning is done; no code exists yet. The next step is Phase 0.

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

Proposed; Phase 0 creates it and replaces this section with what exists.

| Path | What |
| --- | --- |
| `apps/web` | Vite + React app and PWA |
| `apps/desktop` | Tauri 2 shell |
| `packages/doc` | Document schema, block ids, Yjs seam, migrations |
| `packages/editor` | The block editor |
| `packages/workspace` | Page tree, operations, outbox, sync engine, `LocalStore` |
| `packages/store-web` | `LocalStore` on IndexedDB |
| `packages/shell` | App frame, sidebar, search, settings, theme, i18n, platform |
| `packages/api` | Generated API client (Phase 2) |
| `crates/cgw-store` | `LocalStore` on SQLite |
| `crates/cgw-native` | Desktop helpers |
| `crates/cgw-ydoc` | Yjs functions over `yrs` for the server worker |
| `server/` | ASP.NET Core API and worker (Phase 2) |
| `docs/` | Plan, design, decisions, progress |

## Commands

None yet. Phase 0 adds one command per standing check and one that runs them all, and lists them
here.

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
