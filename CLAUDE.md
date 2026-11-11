# Cash Gear Workspace

A Notion-style workspace for the Cash Gear ecosystem: block documents, a page tree, databases,
embedded sheets and ERP data, in the browser and as a Tauri desktop app.

Status: Phase 0 (scaffold and spikes) is in progress.

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
| `apps/web` (`@cgw/web`) | Vite + React app: one `@cashgear/ui` control in light, dark, English and Arabic |
| `apps/desktop` (`@cgw/desktop`, crate `cgw-desktop`) | Tauri 2 shell showing the same page; CSP in `src-tauri/tauri.conf.json` |
| `scripts/` | Standing-check runner, licence gate, third-party notices, desktop smoke test, WebView2 setup |
| `tests/e2e` | Playwright specs (Chrome and Edge) |
| `tests/license-gate` | GPL fixtures the licence self-test must reject |
| `bench/` | Spikes (`bench/spikes/`, Phase 0 only) and benchmark harnesses; results in `bench/results/` (not committed) |
| `.github/workflows/ci.yml` | Licence gates on Ubuntu; build, test and desktop smoke on Windows |
| `docs/` | Plan, design, decisions, progress |

## Commands

| Command | What |
| --- | --- |
| `pnpm check` | Every standing check below, in CI's order; stops at the first failure (`--no-rust` skips Rust) |
| `pnpm format:check` / `pnpm format` | Prettier |
| `pnpm lint` | ESLint, zero warnings |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest unit tests |
| `pnpm rust:fmt` / `pnpm rust:clippy` / `pnpm rust:test` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` over the workspace |
| `pnpm deny` | `cargo deny check licenses sources` |
| `pnpm licenses:check` / `pnpm licenses:selftest` | npm licence gate, and proof that both gates reject a GPL dependency |
| `pnpm build` | Web build and third-party notices |
| `pnpm test:e2e` | Playwright against `pnpm preview` (port 4273) |
| `pnpm desktop:build` / `pnpm desktop:smoke` | Release desktop build (`target/release/cgw-desktop.exe`), then WebView2 smoke over CDP |
| `pnpm dev:web` / `pnpm dev:desktop` | Vite dev server on port 5273; Tauri dev window on it |

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
