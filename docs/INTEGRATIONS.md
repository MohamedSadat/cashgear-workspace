# Integrations

The interfaces between Cash Gear Workspace and Cash Gear Sheet, Cash Gear ERP, plugin blocks and
AI providers. Each is a versioned contract with a mock, so Workspace can be built and tested
without the other system running.

What was read and what was not:

| System | Read | Not read, so assumed |
| --- | --- | --- |
| Cash Gear Sheet (`D:\CashGear\Projects\cashgear-sheet`) | Layout, `packages/ui/src/platform.ts`, `packages/erp-connector`, `docs/erp-contract.md`, Tauri config, build scripts | Whether the engine needs cross-origin isolation at run time (spike S9) |
| Shared UI (`D:\CashGear\Projects\CashGear.React.UI`) | Component list, tokens, RTL, build | Nothing material |
| Cash Gear ERP (`D:\CashGear\Projects\CashGear`) | UnifiedAPI authentication, tenancy, Sheet session code, representative controllers, blob usage | Production hosting, live workflow configuration, how full the secrets in settings files are, where SignalR hubs are mapped |

Every proposal that touches another repo is a **track**: work to be agreed and done in that repo,
never from this one.

## Three kinds of tabular data

A workspace database is not a workbook, and neither is an ERP record.

| | Workspace database | Sheet workbook | ERP record |
| --- | --- | --- | --- |
| What it is | Rows with typed properties; each row is a page | Free cells, formulas, formats, charts | A business entity with rules, workflow and audit |
| Source of truth | Workspace's SQL database | Its own xlsx document | The ERP tenant database |
| Identity | A page id per database and per row | A workbook id | The ERP's own key, within a company |
| Who may write | The Workspace API, per property | The Sheet engine only | The ERP's `Commit` route only, explicitly |
| Offline | Yes | Yes, in Sheet | No |
| Shown in a page as | A database view block | A sheet embed block | An ERP view block |
| Permissions | Workspace's | The workbook's own | The ERP's, per user, per company, per field |

Bridges are explicit, one-way, and each run is an action a person takes:

| Bridge | Direction | Result | Phase |
| --- | --- | --- | --- |
| Import a range | Workbook → database | New rows; a one-time copy | 5 |
| Export a view | Database → new workbook | A new xlsx; a one-time copy | 5 |
| ERP view | ERP → page | A live read, never stored | 5 |
| Snapshot an ERP view | ERP → database | New rows marked with their ERP key and the time; a one-time copy, clearly labelled as not live | 7 |

The models are never merged: a database property is never "bound" to a cell or to an ERP field.

### Reusing Sheet's formula logic

Database formula properties (Phase 4) may reuse Formualizer, the MIT/Apache engine Sheet uses
through `crates/cgs-calc`.

- What exists: the engine evaluates a formula in Rust against a workbook context
  (`FormualizerEngine::evaluate_at`). There is no JS or WASM export that evaluates a standalone
  expression.
- What is safe to reuse: the function library and the parser, against a row's properties as named
  values. What is not: cell references, ranges, volatile functions, anything that assumes a grid.
- Proposal: a small crate in this repo that depends on the same Formualizer fork at the same
  pinned revision, exposes "evaluate expression with named values", and builds for WASM (client)
  and natively (server worker), so both give the same answer. `cgs-calc` is not depended on: it
  is private to Sheet and shaped around workbooks.
- Decided by a spike in Phase 4 (Q14). The fallback is a small expression language of our own
  with a fixed function list.

## Cash Gear Sheet

### What Sheet offers today

- No embeddable component: `@cgs/ui` exports `AppShell`, `ThemeController` and the platform
  types. `AppShell` creates its own engine client and takes only `platform`, `theme`, `version`.
- No iframe, `postMessage` or embed mode; no read-only or preview mode; no range-to-image API.
- No cloud storage, cloud document identity or login. Files are local.
- Pieces that make an embed route practical: `SheetCanvas` on `GridController` (needs an engine
  client and a loaded workbook), `viewBlock` and the tile renderer, the recording-to-SVG path
  used for print, and `chart_json` drawn by `CgChart`.
- One server integration, the ERP launch ticket, whose pattern is reused below.

### Approach: a sandboxed iframe and a message contract

Chosen over shared packages and over an in-process component (D21). The embed is a new route in
the Sheet web app that loads a workbook read-only and draws one range or one chart.

```
Workspace page                         Sheet embed (iframe, Sheet's origin)
───────────────                        ───────────────────────────────────
<iframe sandbox src=…/embed>  ───────▶  loads, posts "ready"
init (port, view, theme, source) ────▶  loads the workbook read-only
                              ◀───────  "loaded" (sheets, size)
setView / setTheme / refresh  ───────▶
                              ◀───────  "resize", "error", "openRequested"
requestPreview                ───────▶
                              ◀───────  "preview" (PNG bytes)
```

### Contract `sheet-embed.1`

Written in full on 2026-11-14 (Phase 5, M5.1), before either side ships it. The types and their
validators are `packages/editor/src/sheet/contract.ts`; the vectors both sides run (Track S5) are
`packages/editor/vectors/sheet-embed-vectors.json`; the mock embed is `tests/mocks/sheet`.

**The frame.** Workspace draws `<iframe src="{sheet}/embed">` with
`sandbox="allow-scripts allow-same-origin"` (Sheet needs its own origin for workers and WASM; it is
a different origin from Workspace, so it gains nothing over the page), `referrerpolicy="no-referrer"`,
`allow=""`, a `title` for screen readers, and no `name`. `{sheet}` is the one Sheet origin of
Workspace's build. The address carries nothing: no workbook, no token, no query.

**Sheet's side of the frame (S3).** `/embed` is served with `frame-ancestors` listing Workspace's
origins and nothing else, where the rest of Sheet keeps `frame-ancestors 'none'`: live
`https://workspace.cashgearerp.com`, the desktop's `tauri://localhost` and `http://tauri.localhost`;
in development and tests also `http://127.0.0.1:5273`, `http://127.0.0.1:4273`, `http://localhost:5273`
and `http://localhost:4273`. The embed accepts `init` only from that same list.

**Handshake.**

1. When its script has run, the embed posts `{type: "ready", contracts: ["sheet-embed.1"]}` to
   `window.parent` with target origin `"*"`. It holds nothing private, and the embed cannot know
   the parent's origin before `init` (no referrer is sent).
2. The parent takes a `ready` only when `event.source` is its frame's window and `event.origin` is
   its Sheet origin, and only once per frame load. It makes a `MessageChannel` and posts `init`
   to the frame with target origin `{sheet}`, transferring `port2` (and the bytes, for a `bytes`
   source).
3. The embed takes `init` only when `event.source` is `window.parent`, `event.origin` is on its
   list, a port came with it, and no `init` came before. It ignores every later window message.
   An `init` whose `contract` it does not speak is answered on the port with `error`
   `contract.unsupported`, and nothing else happens.
4. Everything after that, in both directions, is on the port. A message that fails validation is
   dropped, and neither side logs its content.

Parent to embed (on the port, except `init`):

| Message | Fields | Answer |
| --- | --- | --- |
| `init` | `contract: "sheet-embed.1"`, `source`, `view`, `theme`, `direction`, `locale` | `loaded`, or `error` |
| `setView` | `view` | `loaded`, or `error` |
| `setTheme` | `theme`, `direction`, `locale` | none; drawn again |
| `refresh` | `source` | `loaded`, or `error`; a `source` with the ETag already drawn draws nothing new and answers `loaded` |
| `requestPreview` | `id`, `maxWidth`, `maxHeight`, `scale` | `preview` with the same `id`, or `error` with it |

Embed to parent:

| Message | Fields | Meaning |
| --- | --- | --- |
| `ready` | `contracts: string[]` | The versions this embed speaks (on the window) |
| `loaded` | `etag`, `view` (as drawn: the sheet and range resolved), `sheets: {name, direction}[]`, `charts: {id, title, sheet}[]`, `size`, `capped` | Drawn. `capped` is true when a null range was cut to the cell limit |
| `resize` | `size` | The content's natural size changed |
| `preview` | `id`, `bytes` (PNG, transferred), `width`, `height`, `etag`, `view` | The picture of the view as drawn |
| `openRequested` | none | The user chose "Open in Cash Gear Sheet" inside the frame (optional for the embed to offer) |
| `error` | `code`, `message`, `id` (only in answer to `requestPreview`) | One of the codes below |

Types:

```ts
type Source =
  | { kind: 'url'; url: string; etag: string }          // a signed URL to exactly one version's xlsx, about 5 minutes
  | { kind: 'bytes'; bytes: ArrayBuffer; etag: string }; // transferred; for a desktop with the bytes, not used by 0.5.0

type View =
  | { kind: 'range'; sheet: string | null; range: string | null } // null sheet: the first visible; null range: the used range, capped
  | { kind: 'chart'; sheet: string | null; chartId: string };

type Theme = 'light' | 'dark';
type Direction = 'ltr' | 'rtl';                       // the page's; each sheet keeps its own in `sheets`
type Locale = 'en' | 'ar';
interface Size { width: number; height: number }      // CSS pixels, positive integers, at most 100,000
```

Fields, as the validators check them:

| Field | Rule |
| --- | --- |
| `type` | One of the message names above; a message is a plain object |
| `url` | `https:`, or `http:` on `127.0.0.1` or `localhost`; at most 4,096 characters |
| `etag` | A quoted entity tag (`"…"`), 3 to 256 characters, as the Workspace API sends it |
| `sheet` | 1 to 31 characters, no `[ ] : * ? / \`, or null |
| `range` | A1 notation without a sheet or `$`: `A1` or `A1:D20`, columns `A` to `XFD`, rows 1 to 1,048,576, or null |
| `chartId` | 1 to 128 characters |
| `id` | 1 to 64 characters of `[A-Za-z0-9_-]` |
| `maxWidth`, `maxHeight` | Integers 16 to 4,096 |
| `scale` | 1, 1.5, 2 or 3 |
| `bytes` | An `ArrayBuffer`; a preview's starts with the PNG signature and is at most 2 MB |
| `message` | At most 500 characters, for the log only; Workspace shows its own text by `code` |

Error codes:

| Code | When | Workspace shows |
| --- | --- | --- |
| `source.unavailable` | The bytes could not be read (network, 404, 5xx), or are not a workbook Sheet reads | The picture, and "Couldn't load the live view" |
| `source.forbidden` | Blob Storage refused the URL (403: it expired) | Asks the API for a new URL once and sends `refresh`; then as `source.unavailable` |
| `view.notFound` | The sheet or chart is not in the workbook | "This sheet or chart is no longer in the workbook", and the view picker |
| `workbook.tooLarge` | Over 20 MB | The picture and "Open in Cash Gear Sheet" |
| `range.tooLarge` | A named range over 5,000 cells | The picture and the view picker |
| `contract.unsupported` | No contract both sides speak | The picture and "Open in Cash Gear Sheet" |

Rules:

- The embed is read-only. It never saves and exposes no editing command.
- The embed receives no Workspace credential. The parent fetches a signed URL from the Workspace
  API (after the workbook's own permission check) and passes it in `source`. The embed reads it
  with `fetch` in `cors` mode, `credentials: 'omit'`, `redirect: 'error'`, no referrer (Blob
  Storage's CORS rule already allows Sheet's origins for Track S1).
- A workbook with no version yet is never sent to the embed: Workspace shows "Empty workbook" and
  "Open in Cash Gear Sheet".
- The embed sizes itself to the view; Workspace makes the frame that tall, up to the block's
  `height`, and the embed scrolls inside past it.
- Limits: 20 MB a workbook, 5,000 cells a range (decisions, 2026-11-14).
- Track S's readings of the open points, agreed on 2026-11-14: a preview shows the view cut from
  its top-left (top-right on a right-to-left sheet) to `maxWidth` x `maxHeight` CSS pixels, not
  scaled; `width` and `height` are the CSS pixels shown; its density falls (2, 1.5, 1, less)
  until the PNG is under 2 MB; it is drawn in the file's own light colours whatever `setTheme`
  says. `sheets` lists visible worksheets in tab order; sheet names match without case and
  `loaded.view.sheet` gives the file's spelling. A chart's `id` is its name in the file
  (`Chart 1`, then ` (2)` for a repeat on a sheet). A null range over 5,000 cells keeps the
  top-left corner (every column up to 50, else `max(50, floor(5000 / rows))`, then the rows that
  fit); an empty sheet is `A1`; `loaded.view.range` is written top-left first. An `init` that fails
  validation does not count as the one `init`; one with another `contract` and a port does.
  `requestPreview` after an `error` answers that `error`. The full readings are Sheet's.
- A contract version is never changed once shipped. A new one is added, and `ready` lists all the
  embed speaks.

### Workbooks as their own documents

A workbook embedded in a page keeps its own identity, storage and permissions (`Workbooks`,
`WorkbookVersions`, `WorkbookPermissions` in `DATA_MODEL.md`).

- A page stores `workbookId` and a view. Deleting the page does not delete the workbook; deleting
  the workbook leaves a placeholder in the page.
- A reader who can see the page but not the workbook sees "You don't have access to this
  workbook", never a preview.
- "Insert an existing cloud workbook" lists workbooks the user can read in this workspace.
- "Create a new workbook" creates the record with no version; Sheet opens it blank (right to left
  for an Arabic session) and the user's first Save makes version 1 with `If-None-Match: *`.
- "Refresh linked data" re-reads the workbook's current version and redraws.
- A workbook's access list follows the pages' rules (decisions, 2026-11-14): owners and admins
  `full`, members `edit`, guests nothing unless named; entries by person or for the whole
  workspace. It is never shared outside its workspace: a page's share link shows the block as
  "You don't have access to this workbook".

Workspace's own routes (Phase 5), on the Workspace session:

| Route | Method | Access | Success |
| --- | --- | --- | --- |
| `/api/v1/workspaces/{id}/workbooks` | GET | Member; lists those the caller can read (`?trashed=true`: the trash; `?q=`: by name) | 200 `{workbooks: Workbook[]}` |
| `/api/v1/workspaces/{id}/workbooks` | POST | Member who is not a guest; `{id?, name}` | 201 `Workbook` (no version) |
| `/api/v1/workbooks/{id}` | GET | Read | 200 `Workbook`, `ETag` |
| `/api/v1/workbooks/{id}` | PATCH | Edit; `If-Match`; `{name?, trashed?}` | 200 `Workbook` |
| `/api/v1/workbooks/{id}` | DELETE | Full; to the trash | 204 |
| `/api/v1/workbooks/{id}/permissions` | GET, PUT | Read (entries shown to `full` only), `full` to change; `If-Match` | 200 |
| `/api/v1/workbooks/{id}/content` | GET | Read | 200 `{readUrl, etag, size, versionId}` (null with no version) |
| `/api/v1/workbooks/{id}/previews/{viewHash}` | GET | Read | 200 `{url, versionId, etag, madeAt, width, height}`, or 404 |
| `/api/v1/workbooks/{id}/previews/{viewHash}` | PUT | Edit; body the PNG; `X-Workbook-Version` | 204 |
| `/api/v1/workbooks/{id}/launch` | POST | Read; `{}` | 200 `{url}` |
| `/api/v1/workbooks/{id}/import` | POST | Read the workbook and edit the database; `{databaseId?, sheet, range, header}` | 200 `{databaseId, rows}` |
| `/api/v1/databases/{id}/workbooks` | POST | Read the database, create workbooks; `{viewId, name}` | 201 `Workbook` (version 1, written by the server) |

`Workbook` is `{id, workspaceId, name, versionId, etag, size, savedAt, savedBy, createdBy,
createdAt, trashedAt, access}`, where `access` is the caller's level.

### Opening the full editor

Sheet has no cloud open or save today. Track S adds a third `SheetPlatform` implementation beside
`web.ts` and `desktop.ts`, using the same ticket pattern the ERP uses to launch Sheet:

1. In Workspace, the user chooses "Open in Cash Gear Sheet". Workspace's API issues a one-time
   ticket bound to the user, the workbook and the access level: 256 random bits, 120 seconds,
   stored as a hash.
2. Workspace opens `https://sheet.cashgearerp.com/cloud#launch=<ticket>` in a new tab (desktop:
   the Sheet desktop app by deep link when installed, the web app otherwise).
3. Sheet removes the ticket from the address bar and redeems it at Workspace's API for a file
   session: an opaque token, 30 minutes idle and 10 hours at most, scoped to that one workbook
   (or to the copy it saves).
4. Sheet reads the bytes by signed URL and saves a new version with `If-Match` on the ETag. A
   stale ETag gets 412 `version.conflict`, whose body names the current version (`current`:
   `versionId`, `etag`, `sha256`, `savedBy`, `savedAt`), and Sheet offers "save a copy" (a new
   workbook beside it, by `…/copies`, to which the session moves; the device if Workspace
   refuses) or "reload".

The contract is `sheet-session.1`, built by Track S1 and S2 against a mock in Sheet's repo
(Sheet's `docs/workspace-contract.md` is the reference; its suite is Track S5's to run here).
Workspace routes for this (Phase 5):

| Route | Method | Caller | Authentication | Success |
| --- | --- | --- | --- | --- |
| `/api/v1/workbooks/{id}/launch` | POST | Workspace app | Workspace session, read access | 200 `{url}` (`https://sheet.cashgearerp.com/cloud#launch=<ticket>`) |
| `/api/v1/sheet-sessions/redeem` | POST | Sheet | Anonymous, allow-listed `Origin` (checked before the ticket), rate-limited per IP | 200 `{token, expiresAt, maxExpiresAt, workbook: {id, name}, access, user: {id, name}, language}` |
| `/api/v1/sheet-sessions/renew` | POST | Sheet | `X-Workspace-File-Session` | 200 `{expiresAt}` |
| `/api/v1/sheet-sessions/end` | POST | Sheet | `X-Workspace-File-Session` | 204 |
| `/api/v1/sheet-sessions/workbook` | GET | Sheet | `X-Workspace-File-Session`, read access now | 200 `{readUrl, etag, name, size}` (null `readUrl`, `etag`, `size` with no version yet), `ETag` |
| `/api/v1/sheet-sessions/workbook/versions` | POST | Sheet | `X-Workspace-File-Session` of an `edit` session and edit access now; `If-Match` (or `If-None-Match: *` for the first version); body the xlsx | 201 `{versionId, etag}`, `ETag`, `Location`; 412 `version.conflict` with `current` |
| `/api/v1/sheet-sessions/workbook/copies` | POST | Sheet | `X-Workspace-File-Session`, read access now and the right to create workbooks; body the xlsx | 201 `{workbook: {id, name}, access, versionId, etag}`; the session moves to the copy |

- The ticket is 256 random bits in base64url without padding (43 characters), 120 seconds, one
  use, stored as SHA-256, bound to the user, the workbook and the access (`full` and `edit` give
  `edit`; `comment` and `view` give `view`).
- A copy is named "`<name>` (copy)", in Arabic "`<name>` (نسخة)". A save's body is checked to be a
  zip, under 100 MB (413 `limit.size` with `limit`), with the xlsx content type.
- Errors are ProblemDetails with `code`: `request.invalid`, `ticket.invalid`, `session.expired`,
  `origin.denied`, `access.denied`, `workbook.gone`, `version.conflict`, `version.required`,
  `limit.size`, `limit.rate`, `server.error`.
- Every answer has `Cache-Control: no-store` and `X-Correlation-Id`. CORS for
  `/api/v1/sheet-sessions/*` allows Sheet's origins only and no credentials, apart from the web
  app's cookie policy: methods `GET, POST`; headers `Content-Type, X-Workspace-File-Session,
  If-Match, If-None-Match`; exposed `X-Correlation-Id, ETag, Retry-After, Location`. The routes
  never redirect.
- Sheet's Arabic texts call the button «فتح في Cash Gear Sheet», as Workspace's catalogue does.

### Offline and desktop

- The block keeps a picture of its view (`WorkbookPreviews`), made with `requestPreview` whenever
  the live embed draws. Offline, or before the iframe loads, the block shows that picture with
  its date.
- On the desktop, the embed loads from Sheet's web origin when online. The Tauri CSP adds that
  origin to `frame-src` and nothing else.
- Blob Storage's CORS rule allows `GET` from Sheet's origins (the embed and the cloud platform
  read signed URLs with `fetch`), and Sheet's CSP must be given the storage account's exact origin
  once it exists (`docs/OPERATIONS.md`).
- Spike S9 checks the embed inside an iframe in Chrome and in WebView2, with Sheet's COOP, COEP
  and CORP headers in place. Workspace itself does not send COEP.

### Stages

| Stage | What the block does | Needs |
| --- | --- | --- |
| 5a | Stored picture, name and "Open in Cash Gear Sheet" | Cloud workbooks and the launch flow (Track S1, S2) |
| 5b | Live read-only range in the iframe; refresh | The embed route (Track S3) |
| 5c | Live chart; import a range into a database; export a view to a workbook | Track S4 |

### Track S: work in the Sheet repo

| # | Work | Why |
| --- | --- | --- |
| S1 | A cloud `SheetPlatform`: open by launch ticket, read by signed URL, save a new version with `If-Match` | Workbooks need a cloud identity before they can be embedded |
| S2 | The `/cloud` launch route, mirroring the existing `/erp` route and `launch.ts` | "Open the full editor" |
| S3 | The `/embed` route: read-only load, one range, the `sheet-embed.1` handshake, `resize`, `error`, `frame-ancestors` for Workspace's origins | Live preview |
| S4 | `requestPreview` (PNG of the current view) and chart views | Offline picture, live charts |
| S5 | A contract test suite both repos run against a mock: `sheet-embed.1`'s vectors and handshake against Sheet's embed and Workspace's mock embed; Sheet's `sheet-session.1` suite against Workspace's real API | Either side can change without breaking the other |

S1 and S2 were built during Phase 4; S3 to S5 in their own session during Phase 5 (decisions,
2026-11-14).

## Cash Gear ERP

### What the ERP offers today

- UnifiedAPI authenticates with long-lived API keys in `X-API-Key`. The React client keeps the key
  in `localStorage`.
- For Sheet it added a second scheme: a one-time ticket made by the ERP client, redeemed by Sheet
  for an opaque session sent in `X-Sheet-Session`; an origin allow-list; per-entity `Schema`,
  `Query`, `Commit` and `CommitStatus` routes; a field allow-list with per-field edit rules;
  `RowVersion` checks under lock answering 409; `commitId` idempotency; one `SheetChangeAudit` row
  per changed field. One entity exists: Vendors (`vendors.1`).
- Tenancy: the company in the session selects the database and filters by the `Company` column.
- Permissions: role policies per module, and per-user, per-unit flags (`ViewRec`, `EditRec`,
  `AdvEditRec` and others) checked by `SheetPrivileges`.
- Missing: rate limiting on UnifiedAPI, signed URLs, a generic field-permission mechanism.
- Since Sheet's Phases 15 to 19 (its Track E1 to E4, 2026-11-09 to 11): `api/sheet/Session/Redeem`,
  `Renew`, `End`, Vendors' `Schema`, `Query`, `Commit`, `CommitStatus`, per-IP rate limits on the
  sheet's routes (`rate.limited`), and CORS for Sheet's origin only on them. Nothing for Workspace.

### Principles

1. **The ERP enforces; Workspace asks.** Every permission, validation and audit rule runs in the
   ERP. Workspace's interface hides what the schema says is not allowed, as a courtesy, and no
   permission is granted because of UI state.
2. **Workspace never holds an ERP API key**, in the browser, on the desktop or on its server.
3. **No ERP data at rest in Workspace.** A page stores which connector and which filter. Results
   live in memory and are gone when the page closes.
4. **Nothing is written without an explicit commit** that a person reviews.
5. **A workspace page is not a second way to post transactions.** Level 2 covers selected fields
   of master data the ERP exposes for it. Posting, approving and workflow steps stay in the ERP.

### Where the ERP is

Workspace's build names two ERP origins and reads no other from anywhere (decisions,
2026-11-14): the ERP's API (`VITE_CGW_ERP_API`, live `https://api.cashgearerp.com`) and the ERP
client, whose connect page it opens (`VITE_CGW_ERP_CLIENT`, live `https://erp.cashgearerp.com`; the same build also answers at
`https://app.cashgearerp.com`).
Builds for a local API use the mock ERP (`tests/mocks/erp`): its API on `http://127.0.0.1:4282`
and its client on `http://127.0.0.1:4284`. The ERP's API origin is in `connect-src`, on the web
and on the desktop. The Workspace API's `Erp__ApiBase` is the only base a link may name.

### Linking a workspace to a company

A one-time step by someone who is both a Workspace owner or admin and an ERP admin for that
company.

1. In the ERP client, the admin chooses "Link Cash Gear Workspace". The ERP makes a link ticket
   (256 random bits, base64url, 43 characters; one use, 120 seconds, stored hashed, bound to the
   company and the admin) and opens `https://workspace.cashgearerp.com/#/erp-link/<ticket>`. The
   ticket is in the hash, so it reaches no server's log.
2. Workspace removes the ticket from the address bar at once (`history.replaceState`), keeps it
   in memory, and, signed in, asks which workspace to link (those the person owns or administers).
   On confirm, the browser redeems the ticket at the ERP with the workspace's id and name.
3. The ERP records the link (its own link id, company, workspace id, who, when) and answers
   `{linkId, company, companyName}`. Workspace's API records `ErpLinks` (its base, company, the
   ERP's link id, who, when) and writes an audit entry. Neither stores a secret.
4. Either side can revoke. Workspace's unlink stops it offering the link; the ERP's revoke, in the
   ERP client, stops every session for it. The ERP checks its link on every session.

Workspace's routes for links (owners and admins change them; members read them):

| Route | Method | Success |
| --- | --- | --- |
| `/api/v1/workspaces/{id}/erp-links` | GET | 200 `{links: ErpLink[]}` (not revoked) |
| `/api/v1/workspaces/{id}/erp-links` | POST | `{erpLinkId, erpBaseUrl, company, companyName}`; 201 `ErpLink`; 400 `request.invalid` for a base not `Erp__ApiBase`; 409 `conflict` when the company is linked already |
| `/api/v1/workspaces/{id}/erp-links/{linkId}` | DELETE | 204; sets `RevokedAt` |

`ErpLink` is `{id, erpLinkId, erpBaseUrl, company, companyName, linkedBy, linkedAt}`.

### A user's session

Each person uses their own ERP identity. There is no shared service account.

1. A page with an ERP block shows "Connect to Cash Gear ERP" until the user has a session.
2. Workspace opens the ERP client's connect page in a pop-up (desktop: the system browser):
   `{erpClient}/workspace-connect?workspace=<id>&link=<erpLinkId>&state=<state>&return=web|desktop`,
   where `state` is 128 random bits in base64url (22 characters), kept in memory, one use.
3. The ERP client, where the user is already signed in, asks UnifiedAPI for a ticket for the
   linked workspace and hands it back. In the browser: `window.opener.postMessage({type:
   "cgw-erp-connect", ticket, state}, <Workspace origin from the ERP client's own list>)`;
   Workspace takes it only from its ERP client's origin, from the pop-up's window, with the
   `state` it sent, once. On the desktop: by deep link `cashgear-workspace://erp#ticket=…&state=…`,
   which the app reads and never puts in a route or history.
4. Workspace redeems the ticket at the ERP for a session: an opaque token, 30 minutes idle and
   10 hours at most, bound to the user, the company, the link and the workspace.
5. The token is kept in memory only. It is not written to any store, log, URL or error. Workspace
   renews it at most every 5 minutes while the person works in the tab, ends it with a `keepalive`
   request on `pagehide`, and forgets it when the app closes.

This is the Sheet flow with the direction of the first step reversed, so the user starts from
Workspace.

### Contract `erp-connect.1` (Track E)

Modelled on `vendors.1` in `cashgear-sheet/docs/erp-contract.md`, generalised from one entity
route to a list of connectors. Written in full on 2026-11-14 (Phase 5, M5.1); Track E builds the
ERP's side to it and may propose changes here. The types and validators are
`packages/erp/src/contract.ts`; the mock is `tests/mocks/erp`; the suite is `tests/contracts/erp`
(`pnpm contract:erp`, against the mock or `ERP_BASE_URL`).

| Route | Method | Caller | Authentication | Success |
| --- | --- | --- | --- | --- |
| `api/system/WorkspaceLink/CreateTicket` | POST | ERP client | `X-API-Key`, an ERP admin of the company | 200 `{url}` |
| `api/system/WorkspaceLink/Redeem` | POST | Workspace (browser) | Anonymous, allow-listed `Origin` (checked before the ticket), rate-limited per IP; `{ticket, workspaceId, workspaceName}` | 200 `{linkId, company, companyName}` |
| `api/system/WorkspaceLink/Revoke` | POST | ERP client | `X-API-Key`, an ERP admin; `{linkId}` | 204 |
| `api/system/WorkspaceLink/Status` | GET | ERP client | `X-API-Key` | 200 `{enabled, links: [{linkId, workspaceId, workspaceName, linkedBy, linkedAt}]}` (shows or hides "Link Cash Gear Workspace"; Workspace never calls it) |
| `api/system/WorkspaceConnect/CreateTicket` | POST | ERP client | `X-API-Key`; `{workspaceId, linkId, language?}` (the ERP client's language, `en` by default); the link is live | 200 `{ticket}` |
| `api/connect/Session/Redeem` | POST | Workspace | Anonymous, allow-listed `Origin` (before the ticket), rate-limited; `{ticket, workspaceId}` | 200 `ConnectSession` |
| `api/connect/Session/Renew` | POST | Workspace | `X-Connect-Session` | 200 `{expiresAt}` |
| `api/connect/Session/End` | POST | Workspace | `X-Connect-Session` | 204 |
| `api/connect/Connectors` | GET | Workspace | `X-Connect-Session` | 200 `{connectors: ConnectorSummary[]}` (only those the user may view) |
| `api/connect/Connectors/{id}/Schema` | GET | Workspace | `X-Connect-Session`, View | 200 `ConnectorSchema` |
| `api/connect/Connectors/{id}/Query` | POST | Workspace | `X-Connect-Session`, View | 200 `QueryResponse` |
| `api/connect/Connectors/{id}/Commit` | POST | Workspace | `X-Connect-Session`, Edit | 200 `CommitResponse` (Phase 7) |
| `api/connect/Connectors/{id}/CommitStatus/{commitId}` | GET | Workspace | `X-Connect-Session`, View | 200 (Phase 7) |

```ts
interface ConnectSession {
  token: string;                    // opaque; only ever sent back as X-Connect-Session
  expiresAt: string;                // ISO 8601: idle expiry, never past maxExpiresAt
  maxExpiresAt: string;             // ISO 8601: 10 hours after Redeem
  linkId: string;                   // the ERP's link id
  company: string; companyName: string;
  user: { id: string; displayName: string };
  language: 'en' | 'ar';
}

interface ConnectorSummary {
  id: string;                       // 'vendors', 'customers', 'itemsOnHand'
  kind: 'entity' | 'report';
  label: { en: string; ar: string };
  schemaVersion: string;            // 'vendors.1'
  access: 'view' | 'edit';          // already resolved for this user
}

interface ConnectorSchema {
  id: string;
  schemaVersion: string;
  keyField: string; idField: string | null;
  maxPageSize: number; maxRecords: number; maxCommitRecords: number;
  fields: {
    name: string; label: { en: string; ar: string };
    type: 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'dateTime' | 'lookup';
    editable: boolean; editReason?: 'notEditable' | 'needsEdit' | 'needsAdvEdit';
    required?: boolean; maxLength?: number; min?: number; max?: number; scale?: number; lookup?: string;
    filterable: boolean; sortable: boolean;
  }[];
  lookups: Record<string, { code: string; label: string; active?: boolean }[]>;
  parameters?: { name: string; label: { en: string; ar: string }; type: string; required: boolean }[]; // reports
}

interface QueryRequest {
  filter: { search?: string; equals?: Record<string, string | number | boolean | null> };
  parameters?: Record<string, unknown>;   // reports
  fields?: string[];                      // a subset; the ERP still decides what the user may see
  sort?: { field: string; direction: 'asc' | 'desc' }[];   // at most 3, sortable fields only
  cursor: string | null;                  // opaque, from the last answer; null for the first page
  pageSize: number;                       // 1 to maxPageSize
}

interface QueryResponse {
  records: { id: string; key: string; version: string; values: Record<string, unknown> }[];
  nextCursor: string | null;              // null on the last page
  total: number;                          // every match, whatever the cursor
}

interface CommitRequest {                 // Phase 7
  commitId: string;
  schemaVersion: string;
  dryRun: boolean;
  records: { id: string; key: string; version: string; changes: Record<string, { from: unknown; to: unknown }> }[];
}
```

Rules:

- `search` matches what the ERP's own list of that entity searches; `equals` names filterable
  fields only, else 400 `request.invalid`. `fields` names schema fields only; the answer's
  `values` holds those (every schema field when `fields` is absent) and nothing else.
- Agreed with Track E on 2026-11-14: `link.revoked` at `WorkspaceConnect/CreateTicket` and
  `Session/Redeem` when the link is revoked, unknown or another company's, or Workspace is off for
  the company; `Session/Redeem` with a `workspaceId` other than the ticket's is 401
  `ticket.invalid` and uses the ticket up; a link `Redeem` for a company and workspace already
  linked answers the same `linkId`; `Revoke` of an unknown link is 400 `request.invalid`, and twice
  is 204; until Phase 7 every connector's `access` is `view` and every field `editable: false`
  with `editReason: notEditable`; the cursor is offset-based and bound to its query's filter,
  sort and fields, so another query's cursor is 400 `request.invalid`.
- Values on the wire are `vendors.1`'s (decimals as strings, dates `YYYY-MM-DD`, date-times with
  an offset, empty as `null`, versions as base64).
- The session's company scopes every answer; another company's records are never returned, and
  the connector applies the ERP's own record rules for that user, so two users may see different
  rows and fields.
- Carried over unchanged from `vendors.1`: `Cache-Control: no-store`, `X-Correlation-Id` on every
  response, the error body `{message, correlationId, errors: [{id?, key?, field?, code,
  message}]}`, checks in a fixed order with nothing written when one fails, 409 on a version
  conflict, one audit row per changed field naming the workspace page it came from (Phase 7).
- Codes: `ticket.invalid` and `session.expired` (401); `origin.denied`, `privilege.denied` and
  `link.revoked` (403: the link is revoked or the company no longer has Workspace on);
  `connector.notFound` (404); `request.invalid`, `schema.changed` (400); `batch.tooLarge` (413);
  `rate.limited` (429, `Retry-After`); and Phase 7's commit codes.
- CORS for `api/connect/*` and `WorkspaceLink/Redeem`: Workspace's origins only (live
  `https://workspace.cashgearerp.com`, the desktop's `tauri://localhost` and
  `http://tauri.localhost`; development `http://127.0.0.1:5273`, `http://127.0.0.1:4273`,
  `http://localhost:5273`, `http://localhost:4273`), no credentials; methods `GET, POST`; headers
  `Content-Type, X-Connect-Session`; exposed `X-Correlation-Id, Retry-After`. Never a redirect.
- Rate limits per client address, as Track E4's: tickets and redeems together; the session's own
  Renew and End together.

Requirements this contract meets:

| Requirement | How |
| --- | --- |
| Tenant isolation | The session is bound to one company; the ERP selects the database and filters by `Company`; another company's records are never returned |
| Record-level permissions | The connector's query applies the ERP's own rules for that user |
| Field-level permissions | `Schema` lists only fields the user may see, with `editable` already resolved; `Query` returns only those; `Commit` rejects any other |
| Audit | Per-field audit rows in the ERP; an `AuditLog` entry in Workspace for each link change, and in Phase 7 each commit attempt, without the values |
| Conflict detection | Each record's `version`; 409 with the current values |
| Secure authentication | One-time tickets, opaque sessions stored hashed, origin allow-list, CORS without credentials |
| Explicit commit | `dryRun` to validate, a review screen listing every change, then commit with a `commitId` |

### Level 1: read-only ERP blocks (Phase 5)

- Inserting the block lists connectors from `Connectors`. The user picks one, then fields, a
  filter and a sort. The block stores `linkId` (Workspace's `ErpLinks` id), `connectorId`,
  `filter`, `fields`, `sort`, `pageSize`. A filter is what the person typed or picked (a search
  text, a lookup's code), never a record.
- Each reader's own session runs the query. Two people looking at the same block may see
  different rows and columns, and that is correct.
- The block shows a table with paging, the time it was loaded, and "Refresh".
- No session, no access, or a revoked link each show a specific message and no data.
- Nothing from the result is written to the document, the local store, the search index or
  version history. Copying cells out is a normal clipboard action by the user.
- Offline, the block says ERP data needs a connection.

### Level 2: editable ERP blocks (Phase 7)

- Only for connectors whose `access` is `edit`, and only fields the schema marks editable.
- Edits are held in the block's memory, marked as changed. Leaving the page with pending changes
  warns the user. Nothing is saved to the document.
- "Review changes" runs `Commit` with `dryRun: true` and lists every field's old and new value
  and any error from the ERP.
- "Commit" sends the same request with `dryRun: false`. A lost response is resolved with
  `CommitStatus`, never by sending a different commit.
- A 409 shows the ERP's current value beside the user's, per field, and the user chooses.
- AI can prepare changes in the block. It cannot press Commit.

### Track E: work in the ERP repo

| # | Work | Why |
| --- | --- | --- |
| E1 | Generalise the Sheet session into an app session with an audience (`sheet` or `workspace`) and a list of connectors, keeping `vendors.1` working | One session mechanism |
| E2 | Workspace link: tickets, redeem, the link table, revoke | Linking |
| E3 | The connect flow in the ERP client (`ERPClient_React`): the `workspace-connect` page, its `postMessage` to the opener and the deep-link return; "Link Cash Gear Workspace" and its revoke | A user's session |
| E4 | Read-only connectors: Vendors (reusing `VendorSheetConnector`), then Customers, then Items on hand (Q16, decisions 2026-11-14); a report later | Level 1 |
| E5 | Rate limiting on the connect routes; CORS allow-list for Workspace's origins | UnifiedAPI has neither today |
| E6 | Editable connectors and the audit column naming the workspace page | Level 2 |
| E7 | The contract test suite against UnifiedAPI | As Sheet does |

Workspace builds against a mock ERP that behaves as this document says, as Sheet's
`tests/erp-mock` does, so Phase 5 can start before Track E lands.

E1 to E5 are built in their own session in `CashGear` and `ERPClient_React` during Phase 5, to
those repositories' rules, tested on LocalDB only (decisions, 2026-11-14). The suite in
`tests/contracts/erp` is E7's starting point: Track E runs it against UnifiedAPI on LocalDB.

## Plugin blocks (Phase 7)

A plugin block is a block whose body is defined outside the core schema.

```ts
interface BlockDefinition<Props> {
  type: string;                         // 'cashgear.chart', 'vendor.kanban'
  version: number;
  props: PropSchema<Props>;             // validated on read; unknown props are kept, not dropped
  slash: { label: { en: string; ar: string }; icon: string; keywords: string[] };
  toPlainText(props: Props): string;    // for search and export
  render: BlockRenderer<Props>;
}
```

- In the document, every plugin block is one node type, `pluginBlock`, with `type`, `version` and
  `props` attributes. A client without the plugin draws a placeholder and keeps the node as it
  is, so the schema rule "never drop what you do not know" holds without a schema version change.
- First-party definitions are compiled into the app.
- Third-party plugins, if ever allowed, render only inside a sandboxed iframe with a message
  contract like `sheet-embed.1`, and get no access to the document, the session or other blocks.
- Charts, kanban, calendar, timeline and embedded presentations are planned as first-party
  definitions on this interface.

## Future applications

A new Cash Gear app (presentations, for example) integrates the way Sheet does:

1. Its documents are their own records with their own storage and permissions.
2. A page stores an id and a view.
3. An embed route speaks a versioned message contract inside a sandboxed iframe.
4. The full editor opens by launch ticket and saves with `If-Match`.
5. Offline shows a stored picture.

## AI (Phase 7)

AI is optional. The editor, sync and search work with it switched off, and no core package
depends on it.

```
Editor action ─▶ Workspace API ─▶ IAiProvider ─▶ a provider
                     │
                     └─ checks permission, strips nothing it was not asked to send,
                        meters use, writes an audit entry
```

```csharp
public interface IAiProvider
{
    string Id { get; }
    IAsyncEnumerable<AiChunk> CompleteAsync(AiRequest request, CancellationToken ct);
    Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, CancellationToken ct);  // optional
}
```

| Mode | Key lives | Notes |
| --- | --- | --- |
| Bring your own key | Server, encrypted per workspace; never returned to any client | The workspace admin chooses the provider and model |
| Cash Gear AI subscription | Server | Metered per workspace |
| Local model | The desktop app calls a local endpoint directly | Nothing leaves the device; desktop only |

Rules:

- Only content the acting user can read is sent, and only what the action needs.
- Output is a proposal shown beside the document. The user accepts it, and it then enters the
  document as an ordinary edit by that user, undoable and in history.
- Generated structured databases are created as proposals too: a schema and rows the user reviews.
- AI search over workspace content uses embeddings stored per page, filtered by the same
  permission check as ordinary search, at query time.
- AI and the ERP: AI can read ERP data only through the acting user's session, in memory, for
  the length of one request. It can fill a pending change list in an editable block. It cannot
  commit; a person reviews and commits through the same screen as always.
- Each workspace can switch AI off entirely.
