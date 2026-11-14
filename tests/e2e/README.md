# End-to-end specs

`pnpm test:e2e` runs every spec in Chrome and Edge; `pnpm test:e2e:desktop` (after
`pnpm desktop:build`) runs them on the built desktop app. Playwright starts what they need, or
reuses it locally when it already answers: `pnpm preview` (4273), the server stack
(`scripts/server-stack.mjs --e2e`, 5280), and from Phase 5 the mock Sheet (`tests/mocks/sheet`, 4283) and the mock ERP (`tests/mocks/erp`, API 4282, client 4284). Run Workspace's suite and
Sheet's one at a time: Sheet's suite also takes port 4273.

## Phase 5 against the real Sheet and the real ERP

The Sheet and ERP specs (`sheet.spec.ts`, `erp.spec.ts`, `integrations-origins.spec.ts`) run
against the mocks by default. Two switches point them at the real systems instead; the parts that
need a mock's controls (its faults, its clock, revoking its link, its record of what its embed
did) skip, and `a11y.spec.ts`'s Phase 5 test skips (it draws error states with the mocks'
faults). Nobody else's data is touched: the real systems run locally, on LocalDB and Azurite.

### The real Sheet (`CGW_E2E_REAL_SHEET`)

1. Sheet's preview, as Sheet's Track S3 to S5 hand-over says, in `cashgear-sheet`:
   `VITE_WORKSPACE_API_URL=http://127.0.0.1:5280 pnpm build`, then
   `VITE_WORKSPACE_API_URL=http://127.0.0.1:5280 VITE_WORKSPACE_BLOB_URL=http://127.0.0.1:10000 pnpm preview`
   (`http://127.0.0.1:4173`; its `/embed` may be framed from `127.0.0.1:4273`).
2. Workspace's server stack with launch links to it:
   `Sheet__Origin=http://127.0.0.1:4173 node scripts/server-stack.mjs --e2e` (its Redeem allow-list
   already holds 4173 and the mock's 4283, from which the specs save versions as Sheet does).
3. A web build that frames it: `VITE_CGW_SHEET=http://127.0.0.1:4173 pnpm build`.
4. `CGW_E2E_REAL_SHEET=1 VITE_CGW_SHEET=http://127.0.0.1:4173 pnpm exec playwright test tests/e2e/sheet.spec.ts tests/e2e/integrations-origins.spec.ts`
   (`CGW_E2E_SHEET_ORIGIN` names another address). `VITE_CGW_SHEET` is needed here too: the
   preview Playwright starts sends the CSP, whose `frame-src` it names. Name the files to
   `playwright test` itself: `pnpm test:e2e -- <files>` passes the `--` on and runs every spec. The launch link opens Sheet's own `/cloud`;
   Sheet's editor and its save are Sheet's suite's, so the specs save through sheet-session.1 as
   Sheet does, and check what the block shows; the frame's cells are not read (Sheet draws them
   its own way).
5. The embed's budget: `VITE_CGW_SHEET=http://127.0.0.1:4173 node bench/phase5.mjs --real-sheet`
   (it starts its own preview; `CGW_BENCH_SHEET` for another address; web only: the desktop build frames only the live Sheet origins and the mock).

### The real ERP (`CGW_E2E_REAL_ERP`)

1. UnifiedAPI on LocalDB, as the ERP's Track E1 to E5 hand-over says, in `D:\CashGear\Projects\CashGear`:
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\CashGear.UnifiedAPI.Tests\ContractHost.ps1 -MakeDatabases`
   (`http://localhost:5299`, Workspace's development origins allowed, the seeded keys).
2. The ERP client's dev server, in `ERPClient_React`, with a `.env.development.local` holding
   `VITE_API_BASE_URL=http://localhost:5299`: `npx vite --port 4285 --strictPort`.
3. Workspace's server stack linked to it:
   `Erp__ApiBase=http://localhost:5299 node scripts/server-stack.mjs --e2e`.
4. A web build that calls it:
   `VITE_CGW_ERP_API=http://localhost:5299 VITE_CGW_ERP_CLIENT=http://localhost:4285 pnpm build`.
5. `CGW_E2E_REAL_ERP=1 VITE_CGW_ERP_API=http://localhost:5299 VITE_CGW_ERP_CLIENT=http://localhost:4285 CGW_E2E_ERP_MARKERS="<value>,<value>,…" pnpm exec playwright test tests/e2e/erp.spec.ts tests/e2e/integrations-origins.spec.ts`
   (the two `VITE_` variables again, for the preview's CSP, whose `connect-src` names the ERP).
   - `CGW_E2E_ERP_MARKERS`: distinctive values the seeded Kit tenant holds (vendor and customer
     names) for the "nothing stored" test to look for; required.
   - The users by role, `alice` (every connector), `bob` (fewer customers), `carol` (no
     privilege) and `dan` (ERP admin), default to the seeded keys `ws-test-kit-viewer`,
     `ws-test-kit-limited`, `ws-test-kit-none` and `ws-test-kit-admin`; `CGW_E2E_ERP_KEYS` (JSON,
     `{"alice": "…"}`) overrides them.
   - Links are made as the link screen makes them (a link ticket from
     `WorkspaceLink/CreateTicket` with the admin's key, redeemed from Workspace's origin, recorded
     through Workspace's API); the link page's own walk-through is the mock's (the real client's
     link page is behind its own sign-in).
   - The connect pop-up opens the real client's `/workspace-connect`; its sign-in is the client's
     own, so the ticket is made with the user's key (`WorkspaceConnect/CreateTicket`) and posted
     from inside that page to its opener, as the page posts it.
   - Counts the mock fixes (150 vendors, 240 and 48 customers) are not checked; that the two
     users see different customers is.

PowerShell sets the variables with `$env:NAME = 'value'` before each command.
