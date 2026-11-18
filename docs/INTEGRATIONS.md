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
| `/api/v1/workbooks/{id}/content` | GET | Read | 200 `{readUrl, etag, size, versionId, expiresAt}` (null with no version) |
| `/api/v1/workbooks/{id}/previews/{viewHash}` | GET | Read | 200 `{url, versionId, etag, madeAt, width, height, expiresAt}`: the view's newest picture, of whichever version (`etag` says which), or 404 |
| `/api/v1/workbooks/{id}/previews/{viewHash}` | PUT | Edit; body the PNG; `X-Workbook-Version` | 204 |
| `/api/v1/workbooks/{id}/launch` | POST | Read; `{}` or `{target: "web"}`: Sheet's web app; `{target: "desktop"}`: `cashgear-sheet://workspace/launch#ticket=…` (Phase 9) | 200 `{url, expiresAt}` |
| `/api/v1/workbooks/{id}/versions` | GET | Read | 200 `{versions: [{id, size, sha256, savedAt, savedBy, current}]}`, newest first, the kept 10 (Phase 9) |
| `/api/v1/workbooks/{id}/versions` | POST | Edit; the xlsx, `If-None-Match: *` or `If-Match`, as Sheet's save | 201 `{versionId, etag}` (an import's version 1; Phase 9) |
| `/api/v1/workbooks/{id}/versions/{versionId}/content` | GET | Read | 200 `{readUrl, etag, size, versionId, expiresAt}` (Phase 9) |
| `/api/v1/workbooks/{id}/versions/{versionId}/restore` | POST | Edit; optional `If-Match` on the current content | 201 `{versionId, etag}`: the old bytes as a new newest version, saved by the restorer now; audited `workbook.restore` (Phase 9) |
| `/api/v1/workbooks/{id}/sheets` | GET | Read | 200 `{sheets: [{name, usedRange, hidden}]}` (empty with no version) |
| `/api/v1/workbooks/{id}/range?sheet=&range=` | GET | Read | 200 `{sheet, range, csv}`: the range as CSV in canonical text (dates `YYYY-MM-DD`, numbers as JavaScript's `String(n)`, `true`/`false`); the app's CSV import makes the rows, in a new database or an existing one |
| `/api/v1/databases/{id}/workbooks` | POST | Read the database, not a guest; `{viewId?, name}` | 201 `Workbook` (version 1, written by the server with `DocumentFormat.OpenXml`: the view's rows in its order, its shown properties, typed cells; it takes the database's access) |

`Workbook` is `{id, workspaceId, name, version, versionId, etag, size, savedAt, savedBy,
createdBy, createdAt, trashedAt, access}`: `version` is the record's (`ETag` of `GET`, `If-Match`
of `PATCH` and of the permissions' `PUT`, 409 `version.conflict` when stale), `etag` the content's
(`"<versionId>"`, null with no version), `savedBy` `{id, name}`, `access` the caller's level. As
built in Phase 5 (`server/src/Cgw.Core/Workbooks`; operation ids in `server/openapi/v1.json`).

A workbook's history (Phase 9) is shown from the workbook list and from a block's menu: each
kept version with when and by whom, one opened read-only in the embed by its own signed URL, and,
for `edit` and above, an older one restored as the newest. A trashed workbook's history routes
answer 410 `workbook.gone`; a version that is not the workbook's, or was pruned, 404.

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

All three were built in Phase 5 (`packages/shell/src/sheet`, the blocks' lazy frame in
`@cgw/editor`). Range import and view export run on Workspace's server (decisions, 2026-11-14), so
they need no Track S4; S4's pictures and charts are what 5c's live charts draw.

### Track S: work in the Sheet repo

| # | Work | Why |
| --- | --- | --- |
| S1 | A cloud `SheetPlatform`: open by launch ticket, read by signed URL, save a new version with `If-Match` | Workbooks need a cloud identity before they can be embedded |
| S2 | The `/cloud` launch route, mirroring the existing `/erp` route and `launch.ts` | "Open the full editor" |
| S3 | The `/embed` route: read-only load, one range, the `sheet-embed.1` handshake, `resize`, `error`, `frame-ancestors` for Workspace's origins | Live preview |
| S4 | `requestPreview` (PNG of the current view) and chart views | Offline picture, live charts |
| S5 | A contract test suite both repos run against a mock: `sheet-embed.1`'s vectors and handshake against Sheet's embed and Workspace's mock embed; Sheet's `sheet-session.1` suite against Workspace's real API | Either side can change without breaking the other |

| S6 | Sheet's desktop app takes a Workspace launch by its deep link (below) | "Open in Cash Gear Sheet" on the desktop opens the installed app (Phase 9) |

S1 and S2 were built during Phase 4; S3 to S5 in their own session during Phase 5 (decisions,
2026-11-14); S6 in its own session during Phase 9 (decisions, 2026-11-17).

### Opening Sheet's desktop app (Track S6, Phase 9)

On the desktop, "Open in Cash Gear Sheet" opens Sheet's desktop app when it is installed, else
Sheet's web app in the system browser, as before. It adds a link form and two origins to
`sheet-session.1`; Sheet's redeem request and everything after it are unchanged.

1. Workspace's desktop app asks the system, on every click, whether anything handles the
   `cashgear-sheet` scheme: on Windows the scheme's open command through `AssocQueryStringW`
   (`ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN`, which reads `HKCU\Software\Classes`,
   `HKLM\Software\Classes` and the person's choice), on macOS `LSCopyDefaultApplicationURLForURL`
   (`crates/cgw-native/src/sheet.rs`). It reads only that, and never starts a program to ask.
2. If something does, it calls `POST /api/v1/workbooks/{id}/launch` with `{target: "desktop"}`
   and gets `{url: "cashgear-sheet://workspace/launch#ticket=<ticket>", expiresAt}`. The ticket is
   the web's (256 random bits in base64url, 120 seconds, one use, kept as its SHA-256, bound to the
   person, the workbook and the access) and records its target. `{}` or `{target: "web"}` is the
   web link as before.
3. Workspace hands the link to the system (`ShellExecuteW`; LaunchServices' `LSOpenCFURLRef` on
   macOS) after reading it again as exactly `cashgear-sheet://workspace/launch#ticket=<43
   base64url>` (any other link is refused); it never logs or keeps it, and never opens it in a
   browser. A server that answers a desktop request with its web link has that opened as before.
   In tests `CGW_SHEET_APP=installed|missing` answers the question and `CGW_OPEN_URL_FILE` takes
   the link instead of the system.
4. Sheet's desktop app, one instance, takes the link cold or while running, checks its shape (the
   path `workspace/launch`, exactly one `ticket` of 43 base64url characters in the fragment,
   nothing else), and redeems `{ticket}` at `POST /api/v1/sheet-sessions/redeem` from its
   WebView's origin (`http://tauri.localhost` on Windows, `tauri://localhost` on macOS), at the
   Workspace API its build names (`VITE_WORKSPACE_API_URL`), never one from the link. From there
   the file session is the web's: read by signed URL, save with `If-Match`, copy, renew, end.

What Workspace's API checks:

- A desktop ticket is redeemed only from an origin on `Sheet__DesktopOrigins` (default
  `http://tauri.localhost` and `tauri://localhost`), a web ticket only from one on `Sheet__Origins`.
  The origin is checked before the ticket, as before; a ticket of the other target is used up and
  answered 401 `ticket.invalid`, as an unknown one is.
- CORS for `/api/v1/sheet-sessions/*` allows the desktop origins too. Blob Storage needs nothing
  new: the rule for Workspace's own desktop already allows `GET` and `HEAD` from both.
- No PKCE, unlike Sheet's ERP launch (Sheet's `docs/desktop-deep-link.md`): a program running as
  the person that registers `cashgear-sheet` under `HKCU` receives the ticket, but such a program
  can already read Workspace's own sign-in from the person's keychain, so the ticket gives it
  nothing more. The ticket stays one use and 120 seconds, in the fragment, written down by neither
  side.

What Sheet builds (S6, in `cashgear-sheet`, to its own rules): the `cashgear-sheet` scheme
(`tauri-plugin-deep-link` and `tauri-plugin-single-instance`; the installer registers it under
`HKCU\Software\Classes` and the uninstaller removes exactly that key; `CFBundleURLTypes` on a Mac
build); the link taken cold and while running; the cloud platform in the desktop app, as `/cloud`
does on the web, with `connect-src` for Workspace's API and the storage account; the ticket and the
token never on disk, in a log or in the registry; tests of the link's parser, a desktop run against
a mock of Workspace's routes, and the installer test checking the scheme registered and removed.

### Clipboard (Phase 8)

Workspace's table reads Sheet's clipboard text: tab-separated, a field in quotes when it holds a
tab, a quote or a line break, rows ending CRLF. When only HTML is there, it reads Sheet's table
(`x:num` for a number cell). Workspace writes the same shapes, so a rectangle copied from a table
pastes into Sheet, and into Excel, as shown. Sheet needs no change for this.

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

### `Commit` and `CommitStatus` (Phase 7)

Written in full on 2026-11-15 (Phase 7, M7.1), before either side ships it, from `vendors.1`'s
commit (`cashgear-sheet/docs/erp-contract.md`), which the ERP already runs for Sheet. Track E6
builds the ERP's side; `tests/mocks/erp` and the suite in `tests/contracts/erp` hold Workspace to
it. Only Vendors is editable in 0.7.0 (decisions, 2026-11-15); Customers and Items on hand stay
read-only until Phase 10 (below).

**An editable connector's schema.** `ConnectorSummary.access` is `edit` when the session's user
holds the connector's Edit privilege (Vendors: the Vendors unit's `EditRec`, as Sheet's), else
`view`. Each field's `editable` and `editReason` are resolved for that user:

| Vendors field | Editable with | Otherwise |
| --- | --- | --- |
| `vendorName`, `vendorGroup`, `mobile`, `payMethod`, `address`, `taxFile` | Edit | `needsEdit` |
| `currency`, `blocked` | AdvEdit | `needsAdvEdit` (or `needsEdit` without Edit) |
| `vendorAccount`, `bankAccount`, `debitLimit`, `modifiedBy`, `modifiedDate` | Never | `notEditable` |

`maxCommitRecords` is 500 for Vendors and 0 for a connector that is not editable.

```ts
interface CommitRequest {
  commitId: string;              // a UUID v4 in lower case: one per commit attempt, the same on every retry
  schemaVersion: string;         // the schema's; else 400 schema.changed
  dryRun: boolean;               // true: every check runs, versions included, and nothing is written
  source: {                      // where in Workspace the change was made, for the ERP's audit
    workspaceId: string;         // the session's workspace; else 400 request.invalid
    pageId: string;              // a UUID
    blockId: string | null;      // 12 characters of base 62, or null
  };
  records: {
    id: string; key: string;
    version: string;             // as the record was read
    changes: Record<string, { from: WireValue; to: WireValue }>;  // changed fields only
  }[];
}

interface CommitResponse {       // 200
  commitId: string;
  dryRun: boolean;
  committedAt: string | null;    // ISO 8601 with an offset; null for a dry run
  records: ErpRecord[];          // each changed record as saved (a dry run: as it would be, versions unchanged), every field the user may see
}

interface ConflictBody {         // 409: nothing written
  message: string; correlationId: string;
  conflicts: {
    id: string; key: string;
    version: string;             // the record's version now
    values: Record<string, WireValue>;   // its values now, every field the user may see
    fields: string[];            // the commit's fields whose value now differs from their `from`; may be empty
    modifiedBy: string | null; modifiedAt: string | null;
  }[];
}

type CommitStatusResponse =      // GET …/CommitStatus/{commitId}, View
  | { status: 'unknown' }        // nothing was written under that id for the session's company
  | ({ status: 'committed' } & CommitResponse);   // the stored 200 body
```

Checks, in order. The first that fails answers, and nothing is written:

| # | Check | Answer |
| --- | --- | --- |
| 1 | A live session; a live link | 401 `session.expired`; 403 `link.revoked` |
| 2 | The connector exists and the user may view it | 404 `connector.notFound`; 403 `privilege.denied` |
| 3 | The connector's Edit privilege, dry runs included | 403 `privilege.denied` |
| 4 | The request's shape: a UUID `commitId`; `source` as above; at least one record; ids not repeated; every record with a change; every change with a `to` | 400 `request.invalid` |
| 5 | At most `maxCommitRecords` records | 413 `batch.tooLarge` |
| 6 | Not a dry run, and the company's `commitId` already stored | The stored 200 body when the payload's hash matches, else 400 `commit.reused` |
| 7 | `schemaVersion` is current | 400 `schema.changed` |
| 8 | Each record and field: `record.notFound`, `version.missing`, `record.locked`; `field.readOnly` (also for a field the schema does not list for this user), `privilege.denied` (an AdvEdit field without AdvEdit), `required`, `maxLength`, `type`, `range`, `scale`, `lookup.notFound` (an unknown or inactive code). Only changed fields are checked | 400 listing **every** error, each with `id`, `key` and `field` |
| 9 | Each record's `version` is its version now, read under lock | 409 `ConflictBody` listing **every** conflicting record |
| 10 | Every record written in one transaction, with the modified stamps, the audit rows and the stored commit | 200 `CommitResponse` |

Rules, as `vendors.1`'s:

- **All or nothing**, up to 500 records in one transaction.
- **Strict versions.** Any write since the record was read is a conflict, even to other fields;
  `from` is for the audit and for `fields` only.
- **Idempotency.** The stored commit is keyed by company and `commitId`, with a SHA-256 of the
  payload: `schemaVersion`, `source` and the records sorted by id, as JSON with sorted keys. A
  retry gets the stored body; the same id with another payload is `commit.reused`. A dry run stores
  nothing, so the real commit may reuse its id. A retry racing its first attempt waits for it.
- **Audit.** One row per changed field in the commit's transaction: the company, the connector, the
  record's id and key, the field, the value before (as stored, not the request's `from`) and after,
  the session's user, the time, the `commitId`, the audience `workspace`, and `source`'s workspace,
  page and block, so the ERP's audit names the page a change came from. A summary row in the ERP's
  system log names the page too. Workspace's own audit is below.
- **Values** on the wire as for Query (decimals as strings, dates `YYYY-MM-DD`, empty as `null`);
  `""` and `null` are equal for text and lookups.

What Workspace does with it (the client, `@cgw/erp`):

- One `commitId` per attempt (`crypto.randomUUID()`), kept in memory with its exact payload until
  the outcome is known. A commit with no answer, a 429, a 503 or a 500 asks `CommitStatus` first;
  `committed` ends it, `unknown` sends the same request again with the same id (at most three
  times, waiting as `Retry-After` asks), then offers "Try again" with the same id. A 401 asks
  `CommitStatus` after the person connects again. The payload is never changed while its outcome
  is unknown.
- "Review changes" is the same request with `dryRun: true`; Commit sends it with `dryRun: false`
  and a new `commitId` only if the reviewed changes were edited since.
- Workspace's API records every real commit attempt, without values (`POST
  /api/v1/pages/{id}/erp-commits`, below). The ERP's audit is the authority; Workspace's says who
  tried what from which page and how it ended.

Workspace's route for it (Phase 7), on the Workspace session:

| Route | Method | Access | Success |
| --- | --- | --- | --- |
| `/api/v1/pages/{id}/erp-commits` | POST | Read the page; `{linkId, connectorId, commitId, blockId, outcome, records, fields}`, `outcome` one of `committed`, `conflict`, `refused`, `unknown`, `failed`; the link is the page's workspace's and not revoked | 204; an `AuditLog` row `erp.commit` on the page with that detail, never a value |

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

As built in Phase 7 (`packages/erp`: `drafts.ts`, `view/editing.tsx`, `view/aiPrepare.ts`;
`packages/shell/src/erp/leave.tsx`; decisions, 2026-11-15):

- "Edit data" shows when the connector's `access` is `edit`, its schema has editable fields and
  `maxCommitRecords` is above 0, whoever may or may not edit the page: the ERP decides. It opens
  the editable fields' cells, each with an editor for its type that refuses what the field's
  rules refuse; the ERP checks again.
- The pending changes are one draft per block, held by the tab's ERP services (`pageId#blockId`),
  in memory only: they outlive the block's frame unmounting far from the viewport and a
  reconnect, and are gone when the page is left (after the warning), another person signs in or
  the app closes. While they wait, the block's connector cannot be changed.
- "Review changes" is the dry run of exactly what Commit sends. Commit reuses the review's
  `commitId` when nothing changed since. After a lost answer `CommitStatus` comes first, then the
  same request, at most three times, then "Try again". A 401 waits for the person to connect
  again, then asks `CommitStatus` by itself.
- A 409's screen shows, for each field the ERP changed, the person's value beside the ERP's; the
  person picks one, the rest keep their value on the record's new version, and they review again.
- Each real attempt's end is reported to `erp-commits` (`committed`, `conflict`, `refused`,
  `failed`, `unknown`), best effort; dry runs are not.
- Leaving with changes asks first: the router holds an in-app move with the page still on screen,
  the browser asks on `beforeunload`, and the desktop asks before its window closes.
- "Prepare changes with AI" sends the records on screen (at most 500) and the editable fields
  with their active codes; each proposal is checked as a typed value, marked "Prepared by AI",
  and goes to the review screen like any change.

### Customers and Items on hand editable (Phase 10, Track E8)

Written in full on 2026-11-18 (Phase 10, M10.1), before either side ships it (decisions,
2026-11-18). `Commit` and `CommitStatus` above apply unchanged: the checks in their order, all or
nothing up to `maxCommitRecords`, strict versions, idempotency, the audit naming the page, the
codes. What follows is what is new.

**A field shared by a key.** `ConnectorSchema.fields[]` gains one optional attribute:

```ts
scope?: 'record' | 'key';   // absent: 'record'. A 'key' field's value belongs to every record
                            // with the same `key` (Items on hand: the item, across its rows)
```

- A client that does not know `scope` reads every field as `record`; `erp-connect.1` stays the
  contract's name.
- Workspace applies an edit of a `key` field to every record of that key the block holds (each
  marked changed), and the review lists each.
- Check 4 gains: the records of one key in a commit carry the same `to` for each `key` field they
  change, else 400 `request.invalid` (with `id`, `key` and `field` of each). The ERP writes such a
  field once a key, with one audit row a key and field (the first such record's id).
- Every record sent is version-checked (check 9). A record whose own values moved meanwhile (Items
  on hand: its quantity) is a conflict whose `fields` may be empty.
- `CommitResponse.records` and `CommitStatus`'s stored body hold every record of each changed key
  the user may see, as saved, not only those sent.

**Versions without a rowversion.** Neither `CustTable` nor `InvTable` nor `InvSum` has one. A
record's `version` is the read's own (a hash of the values the user sees,
`ConnectorRules.ContentVersion`), computed again inside the commit's transaction from the rows
read under an update lock; any difference is a conflict (409), as for Vendors.

**Customers (`customers.1`).** `access` is `edit` with the Customers unit's (3004) `EditRec` in the
session's company, besides what it takes to view them (the Sales or Receivable policy and 3004's
View). The customer list's ownership rule holds for commits too: a user who sees only the
customers they created can commit only those (`record.notFound` for any other).

| Customers field | Editable with | Rules (check 8) | Otherwise |
| --- | --- | --- | --- |
| `customerName` | Edit | required; at most 150 | `needsEdit` |
| `customerGroup` | Edit | required; an active `customerGroups` code | `needsEdit` |
| `mobile`, `mobile2` | Edit | at most 50 | `needsEdit` |
| `payMethod` | Edit | required; an active `paymentModes` code | `needsEdit` |
| `address` | Edit | at most 150 (the ERP's update rule; the schema's `maxLength` says so) | `needsEdit` |
| `taxFile` | Edit | at most 50 | `needsEdit` |
| `currency` | AdvEdit | required; an active `currencies` code | `needsAdvEdit` (or `needsEdit` without Edit) |
| `priceList` | AdvEdit | at most 50 | as `currency` |
| `creditLimit` | AdvEdit | a decimal, scale 2, 0 to 9,999,999,999,999.99 (a float column, exact to 15 digits) | as `currency` |
| `blocked` | AdvEdit | required | as `currency` |
| `customerAccount`, `nationalId`, `governorate`, `city`, `createdBy`, `createdDate`, `modifiedBy`, `modifiedDate` | Never | | `notEditable` |

A commit writes `CustTable` (with `ModifiedBy` and `ModifiedDate`, as the ERP's customer screen
does) and nothing of the address book: `governorate` and `city` stay the address book's.

**Items on hand (`itemsOnHand.1`).** One record per item and storage place, as read. `access` is
`edit` with the Items unit's (4001) `EditRec`, besides what it takes to view them (the Inv policy
and the stock screens' 4006 View).

| Items on hand field | Scope | Editable with | Rules (check 8) | Otherwise |
| --- | --- | --- | --- | --- |
| `itemName` | `key` | Edit | required; at most 150 | `needsEdit` |
| `itemGroup` | `key` | Edit | required; an active `itemGroups` code | `needsEdit` |
| `itemId`, `unit`, `siteId`, `warehouseId`, `locationId`, `onHandQty`, `onHandValue` | `record` | Never | | `notEditable` |

A commit writes the item's name and group in `InvTable`, as the ERP's item screen does. Stock is
never written: quantities and values move only by the ERP's own transactions.

`maxCommitRecords` is 500 for both.

**Tests.** The suite's commit cases for both (`tests/contracts/erp/commit.test.ts`) run against
the mock and against UnifiedAPI on LocalDB (Track E9): the privilege matrix (no Edit, Edit,
AdvEdit) per field, every check's code, a conflict from a change in the ERP, idempotency, the
audit naming workspace, page and block, a `key` field applied to every row of its item and two
different values refused, the ownership rule, and nothing of stock written.

As built in Phase 10 (`packages/erp`: `contract.ts`, `drafts.ts`, `view/editing.tsx`,
`view/aiPrepare.ts`; decisions, 2026-11-18): an edit of a `key` field is made on every record of
its key the block holds on screen and in its draft, and a record of that key read later while
editing takes the change; reverting it, or a conflict's choice for it, acts on every record of the
key ("theirs" drops it from rows not in conflict too), so a commit carries one value a key. The
review lists each record sent, then the records the dry run's answer adds for a changed key ("not
shown here"); rows of one key are told apart by their ids. A conflict whose `fields` is empty
needs no choice. AI's request marks such a field `scope: 'key'`.

As built in the ERP (Track E8, `CashGear` `f72bfd10` to `9f89743a`, 2026-11-18): one commit path
(`SheetCommitService` over a `CommitTarget` a connector, Sheet's Vendors SQL and answers unchanged).
Readings the contract leaves open, which the mock follows too: a record sent with a key other than
its own is `record.notFound` for Customers and Items on hand (they are read by key; Vendors by id);
text is trimmed, so spaces alone are empty and `maxLength` counts the trimmed text, while check 4
compares a shared field's values as sent; a version is made from what the user sees, so a change to
a field hidden from them is no conflict for them, and for someone who sees it a conflict with empty
`fields`; Customers' `ModifiedBy` is the user's id; Items on hand has no AdvEdit field. Each
workspace audit row, Vendors' too, now holds the record's id as sent (`SheetChangeAudit.RecordId`,
tenant script `Add_WorkspaceCommitRecordId.sql`, after `Add_WorkspaceCommitAudit.sql`): it must run
in a tenant's database before Workspace is turned on for that company.

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
| E8 | Customers and Items on hand editable (Phase 10): their `Commit` and `CommitStatus` through the one commit path Vendors uses, the `scope` attribute, the audit naming the page | Level 2 for both |
| E9 | The suite's Phase 10 commit cases against UnifiedAPI on LocalDB | As E7 |

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
  toPlainText(props: Props): string;    // for copy and export (search writes nothing for it)
  render: BlockRenderer<Props>;
}
```

- In the document, every plugin block is one node type, `pluginBlock`, with `type`, `version` and
  `props` attributes. A client without the plugin draws a placeholder and keeps the node as it
  is, so the schema rule "never drop what you do not know" holds without a schema version change.
  Adding `pluginBlock` itself raised the document schema to 6 (Phase 7); a build that knows only
  5 opens such a page read-only, by the gate (D7).
- First-party definitions are compiled into the app.

Rules for 0.7.0 (written 2026-11-15, Phase 7, M7.2; `packages/plugins`):

- `type` names the definition (`cashgear.chart`, `cashgear.kanban`); `version` is the version of
  the definition that last wrote `props`; `props` is JSON text. All three are optional with null
  defaults.
- A build that does not know `type` draws a placeholder ("This block needs a newer version of
  Cash Gear Workspace", with the type), and never changes the node. A build whose definition is
  older than the block's `version` draws it read-only and never writes its `props`.
- Reading `props` validates every known prop and keeps every unknown one: a write merges the
  definition's props over what was read, so a newer build's props survive an older build's edit.
- A definition never calls the network, never touches a store and never edits the document
  except through its context: `setProps` (an ordinary, undoable edit of the page) and the data
  host it is given (a database's rows through `@cgw/database`'s host, with the database's own
  access). Search, Markdown and plain text write nothing for a plugin block on the server; on the
  client the definition's `toPlainText` gives a line for copy and export when the build knows it.
- Chart (`cashgear.chart`, version 1): `{databaseId, viewId, chart: 'bar' | 'line' | 'pie' |
  'number', groupBy: propertyId | null, measure: {kind: 'count'} | {kind: 'sum' | 'average',
  propertyId}, title: string | null}`, drawn with `CgChart` from the view's rows (its filters
  and sort) as the reader may see them.
- Kanban (`cashgear.kanban`, version 1): `{databaseId, viewId, groupBy: propertyId, cardProperties:
  propertyId[], hidden: groupKey[]}` over a select or status property; moving a card writes that
  row's property as the board view does, with the database's own access.

As built in Phase 7 (`packages/plugins`, `@cgw/plugins`; the shell's `packages/shell/src/plugins`;
the editor's `nodeviews/plugin.ts`):

- `BlockDefinition<Props>` is `{type, version, props: {read(raw)}, slash: {label: {en, ar}, icon,
  keywords}, toPlainText(props, {language, pageTitle}), render}`, where `render` is a React
  component given `{props, editable, newer, setProps, data, blockId, language}` and loaded with the
  first block of its type on screen. `data` is `{databases: DatabaseHost | null, pickDatabase?}`:
  the open workspace's database host, null on a page shared by link (where a chart or a board says
  where it is shown, as a database block does). The registry (`FIRST_PARTY`) holds chart, then
  kanban; a type is a dotted lower-case name, a version a whole number from 1.
- `EditorHost.plugins` is `{has(type), mount(element, options)}`; the editor mounts the frame by
  the lazy frame's rules (near the viewport, mounted again only for a new type, block id or
  editability) and writes `setProps(text, version)` only for a JSON object and a whole version.
  The slash menu lists each definition by its label in the interface language; insertion writes
  the type and the definition's version with no props, and the block's own set-up asks for the
  database ("Choose a database", the linked-view picker).
- A chart counts from the query itself (a grouped query's counts, the ungrouped total), so a
  count is exact at any size; a sum or an average reads the rows, group by group, up to 5,000,
  and says "Based on the first 5,000 rows" past that. Groups are the query's, in its order, with
  the board's group labels. Bar, line and pie are `CgChart`; a number is drawn as text. A sum or
  average of a property that is gone counts instead.
- A kanban is `@cgw/database`'s own board, given a view that is never stored: the base view's
  filter and sorts, the block's column property (default the first status, else the first
  select), its hidden columns and its card properties. The board's own changes to that view (hide
  a column, change the column property) go to the block's props; nothing writes `view.upsert`.
- Copy and export write a definition's line (`Chart: Tasks`, `لوحة: Tasks`) through `@cgw/doc`'s
  `TextContext.pluginText`; the local search index, the server's derived text, search and Markdown
  write nothing.
- Third-party plugins render only inside a sandboxed iframe with a message contract like
  `sheet-embed.1`, and get no access to the document, the session or other blocks (Phase 10:
  `plugin-frame.1`, below).
- Charts, kanban, calendar, timeline and embedded presentations are planned as first-party
  definitions on this interface.

## Third-party plugins: `plugin-frame.1` (Phase 10)

Agreed on 2026-11-18 (decisions, Phase 10). A third-party plugin is a bundle a workspace's owner or
admin uploads; its code runs only in a sandboxed frame on an origin of its own, speaks to the page
only through this contract, and is given nothing it was not granted. The types and validators are
`packages/plugins/src/frame/` (`contract.ts`, `manifest.ts`); the vectors both sides can run are
`packages/plugins/vectors/plugin-frame-vectors.json`; a reference and a hostile plugin are
`tests/fixtures/plugins`.

**The bundle.** A zip of at most 5 MB: `manifest.json` at its root, the entry `.html` and its files.
At most 200 files, each at most 5 MB unpacked and 20 MB in all, none unpacking to over 100 times its
size (read from the central directory before anything unpacks, then counted while unpacking); names
of at most 200 characters with no `..`, absolute path, backslash, control character or repeat; only
`.html .htm .js .mjs .css .json .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2 .txt .map`, typed
by extension. The device reads the manifest first and shows it; the server reads the whole bundle
again as hostile and refuses with 400 `plugin.invalid` and `errors: [{code, path?}]`
(`manifest.missing`, `manifest.invalid`, `type.reserved`, `entry.missing`, `file.type`,
`file.name`, `bundle.tooLarge`, `bundle.zip`), or 413 over 5 MB.

```ts
interface PluginManifest {
  contract: 'plugin-frame.1';
  type: string;                 // dotted lower-case words, at most 64; never `cashgear.*`
  version: number;              // a whole number from 1
  name: { en: string; ar: string };          // 1 to 80 each
  description?: { en: string; ar: string };  // at most 300 each
  entry: string;                // an .html or .htm file in the bundle, default 'index.html'
  reads?: { rows?: boolean };   // asks for a database view's rows
  height?: number;              // the frame's first height, 48 to 1,200 CSS px, default 240
  keywords?: string[];          // slash menu words, at most 10 of 1 to 30 characters
}
```

**The routes** (owners and admins change; any member, guests included, reads and asks for frames):

| Route | Method | Success |
| --- | --- | --- |
| `/api/v1/workspaces/{id}/plugins` | GET | 200 `{plugins: WorkspacePlugin[]}` |
| `/api/v1/workspaces/{id}/plugins` | POST | The zip as `application/zip`: 201 a new type, 200 a new bundle of a type already there (same or higher version; lower 400 `plugin.older`); two adds of one type at once, the second 409 |
| `/api/v1/workspaces/{id}/plugins/{pluginId}` | PATCH | `{enabled}`: 200 `WorkspacePlugin` |
| `/api/v1/workspaces/{id}/plugins/{pluginId}` | DELETE | 204 |
| `/api/v1/workspaces/{id}/plugins/{pluginId}/frames` | POST | The plugin live and on: 200 `{url, expiresAt}`; else 404. Rate `frames`, 120 a minute |

`WorkspacePlugin` is `{id, type, version, name, description, reads, height, keywords, enabled,
sizeBytes, addedBy: {id, name}, addedAt, updatedAt}`. Audit `plugin.add`, `plugin.update`,
`plugin.enable`, `plugin.disable`, `plugin.remove` (type, version, bundle hash). Plugins are not in
the change feed: the client reads the list on start, after Settings' changes and when a frame's
ticket answers 404.

**The plugins origin.** `https://plugins.cashgearerp.com` (`Plugins__PublicUrl`; `http://localhost:5291`
in development and e2e), a second host name of the Sites process. A frame's `url` is
`{origin}/f/{ticket}/{entry}`: the ticket is 32 random bytes in base64url, kept only as its SHA-256
(`PluginFrameTickets`) with the workspace, the plugin and its bundle hash, for 10 minutes, not one
use (the bundle's own files load under it). The origin answers only `GET` and `HEAD
/f/{ticket}/{path}` of that bundle's files, while the plugin is live, on and of that bundle (its row
read at most 30 s before), with the file's type and:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src {origin};
  style-src {origin} 'unsafe-inline'; img-src {origin} data: blob:; font-src {origin};
  media-src {origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none';
  base-uri 'none'; frame-ancestors {Workspace's origins}
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, max-age=600
Access-Control-Allow-Origin: *
```

never `Set-Cookie`. Anything else on that origin, and `/f/` on the pages origin, is the 404 page.
The Sites process loads no Data Protection; its installed identity is denied the key ring's table.

**The frame.** Workspace draws `<iframe src={url}>` with `sandbox="allow-scripts"` and nothing else
(no same origin, pop-ups, top navigation, forms or modals), `referrerpolicy="no-referrer"`,
`allow=""`, a `title` naming the plugin and no `name`, only when the url's origin is the build's
plugins origin (`VITE_CGW_PLUGINS`). The web and desktop CSPs' `frame-src` name that origin beside
Sheet's. The frame is mounted near the viewport, as other frames.

**Handshake.** The plugin posts `{type: "ready", contracts: ["plugin-frame.1"]}` to `window.parent`
with target `"*"`. The host takes a `ready` only when `event.source` is its frame's window and
`event.origin` is `"null"` (a sandboxed frame's), once per load; it makes a `MessageChannel` and
posts `init` to the frame with target `"*"`, transferring `port2`. Everything after is on the
port. A second `load` of the frame (it navigated itself) ends it: the frame is removed and the
block says the plugin stopped, with Reload. A message that fails validation is dropped; nothing
logs a message's content.

Host to plugin (on the port but `init`):

| Message | Fields |
| --- | --- |
| `init` | `contract`, `plugin: {type, version}`, `block: {version, editable, newer}`, `props` (an object, without the host's `$` keys), `theme`, `direction`, `language`, `rows: Rows \| null` |
| `props` | `props`: changed elsewhere (Undo, a collaborator) |
| `theme` | `theme`, `direction`, `language` |
| `editable` | `editable`, `newer` |
| `rows` | `rows: Rows \| null` |
| `saved` | The answer to a `setProps` written |
| `refused` | `code`: `props.readOnly`, `props.invalid`, `props.tooLarge` |

Plugin to host: `ready` (on the window), `resize {height}` (the frame is made that tall within 48
to 1,200 CSS px and scrolls inside past it), `setProps {props}` (the plugin's whole props: an
object at most 16 KB as JSON and 32 levels deep, written as one undoable edit only when `editable`
and not `newer`, at most one write each 250 ms, merged so the host's `$` keys and any key not sent
are kept; keys starting with `$` are dropped), `error {code, message}` (it cannot draw; `message`
at most 500 characters, for the log only).

`Rows`, only when the manifest asks (`reads.rows`) and the block names a view: `$view` in the
block's props (`{databaseId, viewId}`), chosen by the person with the linked-view picker and written
by the host, never by the plugin. `{databaseId, viewId, properties: [{id, name, type, options?}],
rows: [{id, title, values}], total, complete}`: the view's own filter and sorts, its shown
properties only, never a person, created-by or edited-by value, at most 500 rows, read as the reader
may read them through the shell's `DatabaseHost`.

**Placeholders.** A block draws a placeholder naming the plugin (its type where the name is not
known), and the node is never changed, when the plugin is not installed in the workspace, turned
off, offline, signed out, on a share link or a published site, in a local workspace or on a page of
another workspace; a block written by a later version than the one installed is drawn read-only
(`newer`), and a reader who cannot edit the page gets `editable: false`. A build that does not know
third-party plugins (0.9.0 and earlier) draws its own "needs a newer version" placeholder and keeps
the block exactly.

**Trust.** A plugin shown rows could copy what it is shown into its own props, which every reader
of the page receives; the add dialog says so. It has no network, so nothing it is shown can leave
the page any other way. A contract version is never changed once shipped; a new one is added.

## Import formats (Phase 8)

What an import reads, on the device:

- **Notion's "Markdown & CSV" export.** An id of 32 hex characters after each page's, folder's
  and database's name (also URL-encoded in links); a large export as an archive of
  `…-Part-N.zip` archives; a database as `Name <id>.csv` and `Name <id>_all.csv` (every row) with
  its rows' pages in `Name <id>/`, each starting with its title and its properties as `Key: value`
  lines; callouts as `<aside>`; dates as `November 16, 2026 3:04 PM`; related pages as
  `Name (path.md)`. People columns hold names, not members, and stay text.
- **Markdown folders and zips.** A folder's page is `X.md` beside `X/`, `X/X.md` (this app's own
  export) or `X/index.md`; relative links between the files and to images and attachments.
- **Word `.docx`.** `word/document.xml` with `styles.xml`, `numbering.xml` and
  `_rels/document.xml.rels`, read by Workspace's own reader. What Word has that a page does not
  (comments, footnotes, text boxes, equations, charts, shapes, embedded objects, headers and
  footers) is counted in the report, never imported; tracked changes are read as accepted.

Zip names are read as UTF-8 when they are valid UTF-8, with or without the archive's UTF-8 flag;
otherwise as Latin-1, reported as possibly garbled.

## Mail (Phase 8)

Notification mail for mentions and replies goes through the SMTP account already set
(`Smtp__From`), under a daily cap (`Mail__DailyCap`, 1,500) below the account's own limit, with
`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and
`Auto-Submitted: auto-generated`. Account mails (sign-in, invitations) share the account and are
not counted in the cap.

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
}

public interface IEmbeddingProvider   // Phase 10: a provider of its own (Voyage AI)
{
    string Id { get; }
    Task<EmbeddingResult> EmbedAsync(EmbeddingCall call, CancellationToken ct);
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
  permission check as ordinary search, at query time, deleted when the workspace turns them off,
  and never leaving the server (Phase 10, below).
- AI and the ERP: AI can read ERP data only through the acting user's session, in memory, for
  the length of one request. It can fill a pending change list in an editable block. It cannot
  commit; a person reviews and commits through the same screen as always.
- Each workspace can switch AI off entirely.

### As agreed for 0.7.0 (2026-11-15, Phase 7, M7.3 and M7.4)

Bring your own key, Anthropic only, off by default (decisions, 2026-11-15). The server's `Ai`
module (`server/src/Cgw.Core/Ai`) is the only code that talks to a provider; the client talks
only to Workspace's API.

| Route | Method | Access | Success |
| --- | --- | --- | --- |
| `/api/v1/workspaces/{id}/ai-settings` | GET | Member | 200 `AiSettings` |
| `/api/v1/workspaces/{id}/ai-settings` | PUT | Owner or admin; `{enabled?, model?, apiKey?}` (`apiKey`: a string sets the key, `null` removes it; absent keeps it) | 200 `AiSettings`; 400 `ai.keyMissing` to turn on with no key; 400 `request.invalid` for a model not offered |
| `/api/v1/ai/complete` | POST | Member who can read `pageId` when one is named, not a guest; `AiCompleteRequest`; AI on for the workspace | 200, `application/x-ndjson`, streamed `AiEvent`s |

```ts
interface AiSettings {
  enabled: boolean;                  // on, and a key is set
  provider: 'anthropic';
  model: string;                     // 'claude-opus-5-5' (default), 'claude-sonnet-5-5', 'claude-haiku-5-5'
  models: string[];                  // what may be chosen
  // Owners and admins only (absent for others):
  hasKey?: boolean;
  keySetAt?: string | null; keySetBy?: { id: string; name: string } | null;
  usage?: { month: string; requests: number; inputTokens: number; outputTokens: number };
}

interface AiCompleteRequest {
  workspaceId: string;
  action: 'rewrite' | 'summarise' | 'actionItems' | 'generatePage' | 'generateDatabase' | 'ask' | 'erpChanges';
  pageId?: string;                   // the page the action is about (all but generateDatabase and ask)
  language: 'en' | 'ar';             // the interface language, for answers not tied to a text's own
  input: Record<string, unknown>;    // per action, below
}

type AiEvent =                       // one JSON object a line
  | { type: 'start'; requestId: string; model: string }
  | { type: 'text'; text: string }                      // the next piece of the answer
  | { type: 'sources'; pages: { pageId: string; title: string }[] }   // ask: the pages sent, in order
  | { type: 'done'; stopReason: 'end' | 'length'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: 'ai.refused' | 'ai.keyInvalid' | 'ai.provider' | 'ai.limit' };
```

| Action | `input` | What is sent to the model | Answer |
| --- | --- | --- | --- |
| `rewrite` | `{text, instruction: 'improve' \| 'shorter' \| 'longer' \| 'fixGrammar' \| 'translate' \| 'custom', target?: 'en' \| 'ar', prompt?}` | The selected text and the instruction | Markdown |
| `summarise` | `{text}`: the page's text as the client holds it | That text | Markdown |
| `actionItems` | `{text}` | That text | JSON `{items: {text: string}[]}` |
| `generatePage` | `{prompt}` | The prompt | Markdown, its first heading the title |
| `generateDatabase` | `{prompt}` | The prompt | JSON `{name, properties: {name, type, options}[], rows: {values}[]}`: `type` one of `text`, `number`, `select`, `multiSelect`, `date`, `checkbox`, `url`, `email`, `phone`, the first property each row's name; `options` always present (empty but for selects); each row's `values` an array in the properties' order (text, a number, `YYYY-MM-DD`, `true`/`false`, an option, a list of options, or `null`); at most 20 properties and 100 rows asked for |
| `ask` | `{question}` | The question and, numbered, the derived text of the server's top 8 search hits the person can read (at most 8,000 characters each) | Markdown citing `[n]`, then `sources` |
| `erpChanges` | `{instruction, connector: {id, schemaVersion}, fields: FieldSchema[] (editable ones), records: {id, key, values}[]}`: the block's records in memory, from the person's own session | Those, as given | JSON `{changes: {id, field, to}[]}` |

Rules:

- **One place builds the request** (`AiRequestBuilder`): the action's fixed instructions and the
  `input` fields the table names, nothing else. Text limits: 20,000 characters for `rewrite`,
  100,000 for `summarise` and `actionItems`, 4,000 for a prompt, 1,000 for a question, 2,000 for
  an instruction; `erpChanges` at most 500 records and 400 KB; a body at most 1 MB (413
  `limit.size`).
- **Only what the person can read.** A named page is checked before anything is sent (404, as
  every page route answers); `ask` reads pages through `SearchService` under the person's own
  permission filter and then each page's derived text; `erpChanges` carries only what the
  person's ERP session already gave this tab. The server never calls the ERP and has no route to
  it.
- **Off means off.** With AI off for the workspace (or no key), `complete` answers 403
  `ai.disabled` before building anything, and no request leaves for any provider.
- **The key** is encrypted with Data Protection (purpose `Cgw.Ai.Key.v1`, bound to the
  workspace), decrypted only in the provider call, and never returned, logged or put in an error.
  `GET` says only whether one is set, when and by whom.
- **Metering and audit.** One `AiUsage` row a completion (workspace, person, action, model, tokens
  in and out, time, outcome) and an `AuditLog` row `ai.complete` with the same and no content;
  `ai.settings` for every settings change, never the key. Rate bucket `ai`: 30 completions a
  minute a person.
- **The provider.** Anthropic's Messages API through the official C# SDK, streamed; adaptive
  thinking with effort `low` for `rewrite`, `summarise` and `actionItems`, `medium` for the rest;
  JSON answers by structured output; the server-side refusal fallback on. A refusal ends with
  `ai.refused`, a 401 from the provider with `ai.keyInvalid`. The base address is the SDK's own,
  overridden only outside Production (`Ai__AnthropicBaseUrl`, the mock in `tests/mocks/ai`).
- **Proposals.** Every answer is shown beside the document, never written into it: Accept makes it
  an ordinary edit by the person (replace the selection, insert after it or at the page's top, a
  new page, a new database with its rows, pending changes in an ERP block); Discard drops it.
- **No path to Commit.** AI code in the client (`packages/shell/src/ai`) imports nothing of
  `@cgw/erp` but `@cgw/erp/ai`, which holds types only: the block hands the AI its fields and
  records and gets proposals back, and the block's own code checks them and adds them to its
  pending list. A lint rule and a test that follows every import hold it. The person reviews and
  commits on the usual screen.

As built on the server (2026-11-15, Phase 7, stream D; `server/src/Cgw.Core/Ai`,
`Cgw.Api/Modules/AiEndpoints.cs`; tests `AiTests`, `AiRequestBuilderTests`):

- The provider interface is `IAsyncEnumerable<AiChunk> CompleteAsync(AiCall call, CancellationToken
  ct)`: `AiCall` is the built `AiRequest` (action, system text, user text, effort, token limit,
  JSON schema or none), the workspace's model and its key, and prints without the key. The first
  chunk is `AiStarted` once the provider accepted the call; then `AiText`, then `AiFinished`
  (`end`, `length`, `refused`, with the tokens). No `EmbedAsync` in 0.7.0.
- The order of checks: a member (404 otherwise), not a guest (403 `access.denied`), AI on (403
  `ai.disabled`), the action and language (400), a named page the person can read (404), the
  input (400 or 413), for `ask` the search, the key (502 `ai.keyInvalid` when it no longer opens).
- The stream starts only once the provider has accepted the call: a refused key is 502
  `ai.keyInvalid`, a provider that is busy 503 `ai.limit` (after the SDK's own two retries), one
  that failed or could not be reached 502 `ai.provider`. After the stream starts, the same codes
  and `ai.refused` come as an `error` line, after any text already sent.
- `sources` comes right after `start`, before any text, so citations can be drawn as they arrive.
  An `ask` that finds no page the person can read sends nothing to the provider: `start`, an empty
  `sources` and `done` with no tokens.
- `ask` searches the question's words together and then each word of three letters or more alone
  (at most six words), ranks the pages by the words they match, and sends the top eight.
- Anthropic's API version `2026-10-21`, as the SDK sends it, carries the key as `Authorization:
  Bearer`, not `x-api-key`; the SDK never looks for a key or profile of the host
  (`ShouldAutoResolveCredentials` is off). Claude Haiku 5.5 has no server-side fallback, so its
  calls go without `fallbacks` and the beta.
- `tests/mocks/ai` stands in for the provider in the server's tests, the e2e stack and the benches
  (`Ai__AnthropicBaseUrl`, ignored in Production): the same streamed events as the API, the key
  recorded only as a hash, scripted answers and faults.

### Embeddings and search by meaning (Phase 10)

Agreed on 2026-11-18 (decisions, Phase 10): Voyage AI with the workspace's own key, `voyage-4` at
1,024 dimensions as int8, off for every workspace until an owner or admin turns it on. Built in
`server/src/Cgw.Core/Ai/Embeddings.cs`, `Ai/EmbeddingsService.cs`, `Search/MeaningSearch.cs` and
the worker's `Jobs/EmbedJobs.cs`; the client's parts in `packages/shell/src/ai/AiSettings.tsx` and
`packages/shell/src/search/meaning.ts`.

**Settings.** `GET /workspaces/{id}/ai-settings` gains `embeddings`:

```ts
interface EmbeddingsSettings {
  enabled: boolean;                   // on, with a key, and AI on for this server
  provider: 'voyage';
  model: string;                      // 'voyage-4' (default), 'voyage-4-large', 'voyage-4-lite'
  models: string[];
  // Owners and admins only:
  hasKey?: boolean; keySetAt?: string | null; keySetBy?: { id: string; name: string } | null;
  usage?: { month: string; requests: number; tokens: number };
  progress?: { pages: number; embedded: number };   // while on: pages to embed, and embedded
}
```

`PUT` takes `embeddings?: {enabled?, model?, apiKey?}` (`apiKey` a string sets, `null` removes,
absent keeps). Turning on with no key is 400 `ai.keyMissing`, a model not offered 400
`request.invalid`; removing the key turns embeddings off. Off deletes every vector of the workspace
in the same request; on again, or a model change, embeds every page again. The key is the
workspace's own, encrypted with Data Protection (purpose `Cgw.Ai.EmbeddingsKey.v1`, bound to the
workspace) and never returned; its rules are Anthropic's key's. Embeddings may be on while AI
completions are off: search by meaning needs no Anthropic key. Audit `ai.settings` with an
`embeddings` detail, never the key.

**The provider.** `IEmbeddingProvider.EmbedAsync(EmbeddingCall, ct) → EmbeddingResult`: the texts (1
to 128, at most 100,000 characters together), their input type (`document` for the worker's chunks,
`query` for a question), the workspace's model and key (printed without either); the int8 vectors in
the inputs' order, Voyage's `total_tokens` and the time taken. `VoyageProvider` sends `POST
https://api.voyageai.com/v1/embeddings` with `{input, model, input_type, output_dimension: 1024,
output_dtype: "int8", truncation: true}` and `Authorization: Bearer <key>` over `HttpClient` (Voyage
has no C# SDK); the base is named, `Ai__VoyageBaseUrl` only outside Production. A 401 or 403 is
`ai.keyInvalid`; a 429, a 5xx, a failed connection or an attempt's 60 s is tried twice more, then
`ai.limit` (429) or `ai.provider`. One `AiUsage` row a call (`embed` from the worker with no person,
`search` for a question); completions' own `usage` no longer counts them.

**What is embedded.** The worker's `embed` job embeds each page and row of a workspace with
embeddings on, once its title or derived text has been unchanged for 30 s: the title, a blank line,
then the derived text, in chunks of about 2,000 characters cut at paragraph ends, then sentence ends,
then spaces, overlapping about 200, each starting with the title's line; at most 200 chunks a page.
A chunk whose text and model already have a vector keeps it, with no call. Trashed and deleted
pages' vectors are removed; a restored page is embedded again within 5 minutes. Never comments,
workbooks, database property values or ERP data (none is in a page). `PageEmbeddings` holds the
vectors; `EmbeddingChanges` names each page whose vectors changed, for a day (DATA_MODEL.md).

**Search by meaning.** `GET /api/v1/workspaces/{id}/search/meaning?q=&limit=`. Checks in order: a
member (404), not a guest (403 `access.denied`), embeddings on (403 `ai.disabled`), `q` 1 to 1,000
characters after trimming and `limit` 1 to 20 (400 `request.invalid`), the key (502 `ai.keyInvalid`);
the provider 502 `ai.provider` or 503 `ai.limit`. Rate bucket `meaning`, 30 a minute a person.
Answer `{hits: SearchHit[]}`, ordinary search's hit (`pageId, title, snippet, score, kind,
databaseId`), `score` the cosine similarity, `snippet` the start of the page's own best chunk. The
API keeps each searched workspace's vectors of its current model in memory (capped by
`Ai__EmbeddingsCacheMb`, the least recently used first), brought up to date from `EmbeddingChanges`
on each search, and scores every chunk exactly; pages under the similarity floor
(`Ai__EmbeddingsFloor`, 0.3) are left out; then ordinary search's permission check runs at query
time, by the current pages, so a page restricted or trashed stops counting at once. No route
returns a vector and no log holds one.

**`ask`.** With embeddings on too, `ask`'s retrieval fuses the word search's top 8 and the meaning
search's top 8 by reciprocal rank (k = 60) and sends the top 8 as before; a failure of the meaning
search leaves the words' pages. Off, exactly as 0.9.0. `erpChanges` sends a field's `scope`.

**The palette.** Online, with search by meaning on, it asks once the person pauses (500 ms, 3
characters at least) and shows the pages the words did not find under "Related by meaning", each
marked "Found by meaning" for screen readers; any failure shows nothing more.

**The mock.** `tests/mocks/ai` answers Voyage's `POST /v1/embeddings` from a concept lexicon in
English and Arabic (`embeddings.mjs`), so a question that shares no word with a page but shares its
concepts scores high, in either language and across the two; `/__mock/embeddings` records each call's
input count and type, the key only as a hash. One live test with a real key:
`A_real_embedding` (`VOYAGE_API_KEY`), which prints voyage-4's scores against the floor.
