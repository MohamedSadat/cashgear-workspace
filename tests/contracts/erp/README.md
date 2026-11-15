# The erp-connect.1 contract suite

Proves a server speaks `erp-connect.1` (`docs/INTEGRATIONS.md`, "Contract `erp-connect.1`"): the
link and connect tickets, sessions, connectors, schemas and queries, the error body and codes,
CORS, rate limits, and that `@cgw/erp`'s guards catch an answer that breaks the contract. From
Phase 7 (`commit.test.ts`) also `Commit` and `CommitStatus`: each user's editing as the
contract's table says, dry runs that write nothing, a commit written once and its retry by
`commitId`, `commit.reused`, the checks in order, every field and record error at once, conflicts,
AdvEdit fields, and no commit for a user without Edit by any request. It speaks raw HTTP, so it
tests the wire; one group in each file drives `@cgw/erp`'s client (and a draft) against the server
too. It is Track E7: Track E runs it against UnifiedAPI on LocalDB.

```bash
pnpm contract:erp                      # starts the mock in tests/mocks/erp (also in pnpm test)
ERP_BASE_URL=http://localhost:5000 ERP_TEST_KEY_FULL=… pnpm contract:erp   # another server
```

Against the mock every case runs, in a few seconds. Against another server the cases that need
the mock's clock (ticket and session expiry), its fault injection (malformed answers, dropped
connections), its switch for Workspace per company or its seeded users' exact values skip, and so
does any case whose key is missing.

## Running it against a real ERP

Never against the live database: LocalDB, or a test tenant. The suite makes links (for the
workspace `ERP_TEST_WORKSPACE_ID` and for fresh workspace ids of its own) and revokes every one it
made when it ends. The commit cases change Vendors' addresses and mobiles of the first records in
account order, and put each value back with another commit before the case ends (a case that
fails half-way may leave one changed). Run its files one after another (`pnpm contract:erp`, or
`--no-file-parallelism`): both link `ERP_TEST_WORKSPACE_ID` to the same company, the ERP answers
both with the one live link, and a file that ends first revokes it under the other (Track E7
found it; on the mock each file has its own server).

| Variable                 | Meaning                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERP_BASE_URL`           | The ERP API, without a trailing slash. Unset, the suite starts the mock                                                                                                                   |
| `ERP_TEST_KEY_FULL`      | An API key of a user who may view every connector in `ERP_TEST_CONNECTORS` (the mock's alice). Needed by nearly every case                                                                |
| `ERP_TEST_KEY_LIMITED`   | A user of the same company with Vendors and Customers but not Items on hand, whose Customers a record rule restricts, so they see fewer than `FULL` (bob)                                 |
| `ERP_TEST_KEY_NONE`      | A user of the same company with no connector (carol)                                                                                                                                      |
| `ERP_TEST_KEY_ADMIN`     | An ERP admin of that company, who may link and revoke (dan). Every session needs a link, so nearly every case needs this key too                                                          |
| `ERP_TEST_KEY_OTHER`     | An ERP admin of another company in the same database who may view Vendors (erin, of Dot): the tenant and cross-company cases                                                              |
| `ERP_TEST_KEY_EDIT`      | Phase 7: a user of the `ADMIN`'s company with Vendors' View and Edit, not AdvEdit (gina): the commit cases                                                                                |
| `ERP_TEST_KEY_ADVEDIT`   | Phase 7: a user of that company with Vendors' View, Edit and AdvEdit (faris): the AdvEdit cases                                                                                           |
| `ERP_TEST_CONNECTORS`    | The connectors the server has, comma-separated; `vendors,customers,itemsOnHand` by default. Track E4 builds them in that order. The query cases use the first                             |
| `ERP_TEST_ORIGIN`        | The Origin sent, `http://127.0.0.1:5273` by default; it must be on the ERP's list of Workspace's origins                                                                                  |
| `ERP_TEST_WORKSPACE_ID`  | The workspace id the suite links, `01930000-0000-7000-8000-00000000c0de` by default                                                                                                       |
| `ERP_TEST_RATE_LIMITS=1` | Runs the rate-limit cases: they send until the server answers 429, so this machine's tickets and renewals wait out a window afterwards. On the mock they always run, with limits they set |
| `ERP_ALLOW_WRITES=1`     | Needed when the server is not on this machine, since the suite makes and revokes links                                                                                                    |
| `ERP_BASE_IS_MOCK=1`     | The server at `ERP_BASE_URL` is the mock started by hand (`node tests/mocks/erp/server.mjs`), so its control cases run too                                                                |

On a real server the suite waits out a 429 as `Retry-After` asks, up to three times a request,
since the server's limits count every ticket and session it makes; the read-only cases share one
session per user to spend fewer.

What a real server must have for the cases to mean something: the `FULL` user sees at least
two pages of the first connector at a page size of a quarter of its records; that connector has a
sortable decimal, integer, date or date-time field, a filterable lookup or boolean field and a
field that is not filterable; the `LIMITED` user's customers are a strict subset of `FULL`'s.

## The mock

`node tests/mocks/erp/server.mjs` starts its API on `http://127.0.0.1:4282` and its client on
`http://127.0.0.1:4284` (`--port`, `--client-port`, `CGW_MOCK_ERP_PORT`,
`CGW_MOCK_ERP_CLIENT_PORT`; `--workspace-url` is where its link page sends the admin, by default
`http://127.0.0.1:5273`). The suite starts its own on free ports.

- **Companies:** `Kit` (Kit Trading) and `Dot` (Dot Foods), sharing one database.
- **Users** (API key `mock-<name>`): `alice` (Kit, every connector), `bob` (Kit, Vendors and
  Customers; only salesperson `S-BOB`'s customers, without their `creditLimit`), `carol` (Kit, no
  connector), `dan` (Kit, ERP admin: links), `erin` (Dot, ERP admin and every connector); Phase 7:
  `gina` (Kit, Vendors and Customers, Vendors' Edit), `faris` (Kit, every connector, Vendors' Edit
  and AdvEdit).
- **Connectors**: `vendors` (`vendors.1`'s fields, editable as the contract's table says for a user
  with Edit or AdvEdit, `access: edit` for them; 150 for Kit, 12 for Dot; Kit's `V-1005` is locked),
  read-only for everyone else; `customers` (`customers.1`: account, name, city, credit limit,
  salesperson, group, blocked, last invoice, modified; 240 and 10), `itemsOnHand`
  (`itemsOnHand.1`: item, name, warehouse, quantity at scale 3, unit, reorder level, last
  movement; no id field; 90 and 8). Every record's name holds one of `MARKERS`, made-up words found
  nowhere else, so a test can search a store or a document for ERP data.
- **Client pages:** `/workspace-connect?workspace=&link=&state=&return=web|desktop` (a user and
  language picker and Connect: it posts `{type: "cgw-erp-connect", ticket, state}` to
  `window.opener` for each Workspace origin on its list, or opens
  `cashgear-workspace://erp#ticket=…&state=…`), `/link?workspace=<origin>` (an admin links a
  workspace, and revokes links), `/`.
- **Controls** on the API: `POST /__mock/reset`; `/__mock/clock {advanceMs | set}`;
  `/__mock/fault {match, status?, code?, body?, retryAfter?, drop?, times?}` (`match` is a
  regular expression over the path, ignoring case: anchor it, `Connectors$`; `body` is sent as the
  answer; `{clear: true}` forgets every fault); `/__mock/connect-ticket {user, workspaceId,
linkId, language?}` (a ticket without the pop-up); `/__mock/link-ticket {user}`;
  `/__mock/revoke-link {linkId}`; `/__mock/workspace {company, enabled}`;
  `/__mock/limits {ticketsPerMinute?, sessionPerMinute?}` (off until set); `GET /__mock/state`
  (`{now, records, markers, sessions, links, tickets, workspaceOff, limits}`, never a token).
  Phase 7: `/__mock/edit-record {connector, company, key, values, by?}` (another ERP user changes
  a record: a new version and stamps); `GET /__mock/audit` (`{audit, commits}`: one row per
  changed field with its `source`, and how many commits are stored); a fault's `drop: 'after'`
  runs the route and loses its answer (a commit that went through). Reset puts the records back
  too.
