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

Transport: after the iframe posts `ready`, the parent sends `init` with one end of a
`MessageChannel`. Everything after that travels on the port. Both sides check `event.origin`
against an allow-list before the handshake and ignore everything else.

Parent to embed:

| Message | Fields | Meaning |
| --- | --- | --- |
| `init` | `contract: "sheet-embed.1"`, `source`, `view`, `theme` (`light` or `dark`), `direction`, `locale` | Load and draw |
| `setView` | `view` | Show another sheet, range or chart |
| `setTheme` | `theme`, `direction`, `locale` | Follow the page |
| `refresh` | `source` | The workbook has a newer version |
| `requestPreview` | `maxWidth`, `maxHeight`, `scale` | Ask for a picture of the current view |

Embed to parent:

| Message | Fields | Meaning |
| --- | --- | --- |
| `ready` | `contracts: string[]` | The versions this embed speaks |
| `loaded` | `sheets: {name, direction}[]`, `size: {width, height}`, `charts: {id, title}[]` | Drawn |
| `resize` | `size` | The content's natural size changed |
| `preview` | `bytes` (PNG, transferred), `viewHash` | Answer to `requestPreview` |
| `openRequested` | none | The user chose "Open in Cash Gear Sheet" inside the frame |
| `error` | `code`, `message` | `source.unavailable`, `source.forbidden`, `view.notFound`, `workbook.tooLarge`, `contract.unsupported` |

Types:

```ts
type Source =
  | { kind: 'url'; url: string; etag: string }          // a short-lived signed URL to the xlsx bytes
  | { kind: 'bytes'; bytes: ArrayBuffer; etag: string }; // transferred, for desktop and offline

type View =
  | { kind: 'range'; sheet: string; range: string | null } // null: the used range, capped
  | { kind: 'chart'; chartId: string };
```

Rules:

- The embed is read-only. It never saves and exposes no editing command.
- The embed receives no Workspace credential. The parent fetches a signed URL from the Workspace
  API (after the workbook's own permission check) and passes it in `source`.
- iframe attributes: `sandbox="allow-scripts allow-same-origin"` (Sheet needs its own origin for
  workers and WASM; it is a different origin from Workspace, so it gains nothing over the page),
  `referrerpolicy="no-referrer"`, `loading="lazy"`, a title for screen readers.
- The embed sizes itself to the view up to the block's height, then scrolls inside.
- Limits: the embed refuses workbooks over a size both sides agree (default 20 MB) and ranges
  over 5,000 cells, and says so with `error`.
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
- "Create a new workbook" creates the record with a blank xlsx made by Sheet (`blank_workbook`)
  on first open.
- "Refresh linked data" re-reads the workbook's current version and redraws.

### Opening the full editor

Sheet has no cloud open or save today. Track S adds a third `SheetPlatform` implementation beside
`web.ts` and `desktop.ts`, using the same ticket pattern the ERP uses to launch Sheet:

1. In Workspace, the user chooses "Open in Cash Gear Sheet". Workspace's API issues a one-time
   ticket bound to the user, the workbook and the access level: 256 random bits, 120 seconds,
   stored as a hash.
2. Workspace opens `https://sheet.cashgearerp.com/cloud#launch=<ticket>` in a new tab (desktop:
   the Sheet desktop app by deep link when installed, the web app otherwise).
3. Sheet removes the ticket from the address bar and redeems it at Workspace's API for a file
   session: an opaque token, 30 minutes idle and 10 hours at most, scoped to that one workbook.
4. Sheet reads the bytes by signed URL and saves a new version with `If-Match` on the ETag. A
   stale ETag gets 412 and Sheet offers "save a copy" or "reload".

Workspace routes for this (Phase 5):

| Route | Method | Caller | Authentication | Success |
| --- | --- | --- | --- | --- |
| `/api/v1/workbooks/{id}/launch` | POST | Workspace app | Workspace session | 200 `{url}` |
| `/api/v1/sheet-sessions/redeem` | POST | Sheet | Anonymous, allow-listed `Origin`, rate-limited | 200 `{token, expiresAt, workbook, access}` |
| `/api/v1/sheet-sessions/renew` | POST | Sheet | `X-Workspace-File-Session` | 200 |
| `/api/v1/sheet-sessions/end` | POST | Sheet | `X-Workspace-File-Session` | 204 |
| `/api/v1/sheet-sessions/workbook` | GET | Sheet | `X-Workspace-File-Session` | 200 `{readUrl, etag, name}` |
| `/api/v1/sheet-sessions/workbook/versions` | POST | Sheet | `X-Workspace-File-Session`, `If-Match` | 201 `{versionId, etag}`; 412 on a stale ETag |

### Offline and desktop

- The block keeps a picture of its view (`WorkbookPreviews`), made with `requestPreview` whenever
  the live embed draws. Offline, or before the iframe loads, the block shows that picture with
  its date.
- On the desktop, the embed loads from Sheet's web origin when online. The Tauri CSP adds that
  origin to `frame-src` and nothing else.
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
| S3 | The `/embed` route: read-only load, one range, the `sheet-embed.1` handshake, `resize`, `error` | Live preview |
| S4 | `requestPreview` (PNG of the current view) and chart views | Offline picture, live charts |
| S5 | A contract test suite both repos run against a mock | Either side can change without breaking the other |

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

### Linking a workspace to a company

A one-time step by someone who is both a Workspace admin and an ERP admin for that company.

1. In the ERP client, the admin chooses "Link Cash Gear Workspace". The ERP makes a link ticket
   (one use, 120 seconds, bound to the company and the admin) and opens
   `https://workspace.cashgearerp.com/erp-link#ticket=<ticket>`.
2. Workspace, signed in as a workspace admin, shows which company and asks to confirm, then
   redeems the ticket at the ERP with the workspace's id and name.
3. The ERP records the link (company, workspace id, who, when). Workspace records `ErpLinks`
   (ERP base URL, company, who, when). Neither stores a secret.
4. Either side can revoke. The ERP checks the link on every session.

### A user's session

Each person uses their own ERP identity. There is no shared service account.

1. A page with an ERP block shows "Connect to Cash Gear ERP" until the user has a session.
2. Workspace opens the ERP client's connect page in a pop-up (desktop: the system browser), with
   the workspace id and a one-time `state` value.
3. The ERP client, where the user is already signed in, asks UnifiedAPI for a ticket for the
   linked workspace and hands it back: in the browser by `postMessage` to the opener, checked by
   origin and `state`; on the desktop by deep link `cashgear-workspace://erp#ticket=…&state=…`.
4. Workspace redeems the ticket at the ERP for a session: an opaque token, 30 minutes idle and
   10 hours at most, bound to the user, the company and the workspace.
5. The token is kept in memory only. It is not written to any store. Closing the app ends it.

This is the Sheet flow with the direction of the first step reversed, so the user starts from
Workspace.

### Contract `erp-connect.1` (proposed; Track E)

Modelled on `vendors.1` in `cashgear-sheet/docs/erp-contract.md`, generalised from one entity
route to a list of connectors.

| Route | Method | Caller | Authentication | Success |
| --- | --- | --- | --- | --- |
| `api/system/WorkspaceLink/CreateTicket` | POST | ERP client | `X-API-Key`, admin | 200 `{url}` |
| `api/system/WorkspaceLink/Redeem` | POST | Workspace | Anonymous, allow-listed `Origin`, rate-limited | 200 `{company, companyName}` |
| `api/system/WorkspaceConnect/CreateTicket` | POST | ERP client | `X-API-Key`; the company is linked | 200 `{ticket}` |
| `api/connect/Session/Redeem` | POST | Workspace | Anonymous, allow-listed `Origin`, rate-limited | 200 `ConnectSession` |
| `api/connect/Session/Renew` | POST | Workspace | `X-Connect-Session` | 200 |
| `api/connect/Session/End` | POST | Workspace | `X-Connect-Session` | 204 |
| `api/connect/Connectors` | GET | Workspace | `X-Connect-Session` | 200 `ConnectorSummary[]` |
| `api/connect/Connectors/{id}/Schema` | GET | Workspace | `X-Connect-Session`, View | 200 `ConnectorSchema` |
| `api/connect/Connectors/{id}/Query` | POST | Workspace | `X-Connect-Session`, View | 200 `QueryResponse` |
| `api/connect/Connectors/{id}/Commit` | POST | Workspace | `X-Connect-Session`, Edit | 200 `CommitResponse` |
| `api/connect/Connectors/{id}/CommitStatus/{commitId}` | GET | Workspace | `X-Connect-Session`, View | 200 |

```ts
interface ConnectSession {
  token: string; expiresAt: string; maxExpiresAt: string;
  company: string; companyName: string;
  user: { id: string; displayName: string };
  language: 'en' | 'ar';
}

interface ConnectorSummary {
  id: string;                       // 'vendors', 'customers', 'itemsOnHand', 'salesByMonth'
  kind: 'entity' | 'report';
  label: { en: string; ar: string };
  schemaVersion: string;            // 'vendors.1'
  access: 'view' | 'edit';          // already resolved for this user
}

interface ConnectorSchema {
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
  filter: Record<string, unknown>;  // 'search' plus equality on filterable fields
  parameters?: Record<string, unknown>;
  fields?: string[];                // a subset; the ERP still decides what the user may see
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  afterId: string | null; pageSize: number;
}

interface QueryResponse {
  records: { id: string; key: string; version: string; values: Record<string, unknown> }[];
  nextAfterId: string | null; total: number;
}

interface CommitRequest {
  commitId: string;                 // idempotency
  schemaVersion: string;
  dryRun: boolean;                  // true is Validate
  records: { id: string; key: string; version: string; changes: Record<string, { from: unknown; to: unknown }> }[];
}
```

Carried over unchanged from `vendors.1`: keyset paging, `Cache-Control: no-store`,
`X-Correlation-Id` on every response, the same error body and codes (`session.expired`,
`privilege.denied`, `schema.changed`, `record.conflict`, `record.locked`, `lookup.notFound`,
`request.invalid`), checks in a fixed order with nothing written when one fails, 409 on a version
conflict, and one audit row per changed field naming the workspace page it came from.

Requirements this contract meets:

| Requirement | How |
| --- | --- |
| Tenant isolation | The session is bound to one company; the ERP selects the database and filters by `Company`; another company's records are never returned |
| Record-level permissions | The connector's query applies the ERP's own rules for that user |
| Field-level permissions | `Schema` lists only fields the user may see, with `editable` already resolved; `Query` returns only those; `Commit` rejects any other |
| Audit | Per-field audit rows in the ERP; an `AuditLog` entry in Workspace for each commit attempt, without the values |
| Conflict detection | Each record's `version`; 409 with the current values |
| Secure authentication | One-time tickets, opaque sessions stored hashed, origin allow-list, CORS without credentials |
| Explicit commit | `dryRun` to validate, a review screen listing every change, then commit with a `commitId` |

### Level 1: read-only ERP blocks (Phase 5)

- Inserting the block lists connectors from `Connectors`. The user picks one, then fields, a
  filter and a sort. The block stores `linkId`, `connectorId`, `filter`, `fields`, `sort`,
  `pageSize`.
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
| E3 | The connect flow in the ERP client: the pop-up page and the deep-link return | A user's session |
| E4 | Read-only connectors: Vendors (reusing `VendorSheetConnector`), then customers and items on hand, then one report | Level 1 |
| E5 | Rate limiting on the connect routes; CORS allow-list for Workspace's origins | UnifiedAPI has neither today |
| E6 | Editable connectors and the audit column naming the workspace page | Level 2 |
| E7 | The contract test suite against UnifiedAPI | As Sheet does |

Workspace builds against a mock ERP that behaves as this document says, as Sheet's
`tests/erp-mock` does, so Phase 5 can start before Track E lands.

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
