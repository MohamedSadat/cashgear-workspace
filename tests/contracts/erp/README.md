# The erp-connect.1 contract suite

Proves a server speaks `erp-connect.1` (`docs/INTEGRATIONS.md`, "Contract `erp-connect.1`"): the
link and connect tickets, sessions, connectors, schemas and queries, the error body and codes,
CORS, rate limits, and that `@cgw/erp`'s guards catch an answer that breaks the contract. From
Phase 7 (`commit.test.ts`) also `Commit` and `CommitStatus`: each user's editing as the
contract's table says, dry runs that write nothing, a commit written once and its retry by
`commitId`, `commit.reused`, the checks in order, every field and record error at once, conflicts,
AdvEdit fields, and no commit for a user without Edit by any request. From Phase 10 also Customers'
and Items on hand's commits (`docs/INTEGRATIONS.md`, "Customers and Items on hand editable"): the
privilege matrix per field, every rule's code, a conflict from a change in the ERP, idempotency, the
audit naming the page, an item's shared name (`scope: 'key'`) applied to every row and two values
refused, the customer list's ownership rule, and nothing of stock written. From Phase 12 also
`scale.test.ts` (Track E10, `docs/INTEGRATIONS.md`, "Queries paged in the ERP's database"): queries
of 100,000 records a connector, the large seed's (below), checked page by page against what the
suite's own reading of 0.10.0's rules (`rules.ts`) makes of the same records; and `reports.test.ts`
(Track E11, "Reports"): the three report connectors. It speaks raw HTTP, so it tests the wire; one
group in each file drives `@cgw/erp`'s client (and a draft) against the server too. It is Track E7
(and E9 for Phase 10, E10 and E11 for Phase 12): Track E runs it against UnifiedAPI on LocalDB.

```bash
pnpm contract:erp                      # starts the mock in tests/mocks/erp (also in pnpm test)
ERP_BASE_URL=http://localhost:5000 ERP_TEST_KEY_FULL=… pnpm contract:erp   # another server
```

Against the mock every case runs, in a few seconds (`scale.test.ts` in about a minute: it resets
its own mock to the large seed). Against another server the cases that need
the mock's clock (ticket and session expiry), its fault injection (malformed answers, dropped
connections), its switch for Workspace per company or its seeded users' exact values skip, and so
does any case whose key is missing.

## Running it against a real ERP

Never against the live database: LocalDB, or a test tenant. The suite makes links (for the
workspace `ERP_TEST_WORKSPACE_ID` and for fresh workspace ids of its own) and revokes every one it
made when it ends. The commit cases change Vendors' addresses and mobiles of the first records in
account order, Customers' mobiles and addresses, and the name of the first item stored in two
places, and put each value back with another commit before the case ends (a case that fails
half-way may leave one changed). Run its files one after another (`pnpm contract:erp`, or
`--no-file-parallelism`): both link `ERP_TEST_WORKSPACE_ID` to the same company, the ERP answers
both with the one live link, and a file that ends first revokes it under the other (Track E7
found it; on the mock each file has its own server).

| Variable                   | Meaning                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERP_BASE_URL`             | The ERP API, without a trailing slash. Unset, the suite starts the mock                                                                                                                                   |
| `ERP_TEST_KEY_FULL`        | An API key of a user who may view every connector in `ERP_TEST_CONNECTORS` (the mock's alice). Needed by nearly every case                                                                                |
| `ERP_TEST_KEY_LIMITED`     | A user of the same company with Vendors and Customers but not Items on hand, whose Customers a record rule restricts, so they see fewer than `FULL` (bob)                                                 |
| `ERP_TEST_KEY_NONE`        | A user of the same company with no connector (carol)                                                                                                                                                      |
| `ERP_TEST_KEY_ADMIN`       | An ERP admin of that company, who may link and revoke (dan). Every session needs a link, so nearly every case needs this key too                                                                          |
| `ERP_TEST_KEY_OTHER`       | An ERP admin of another company in the same database who may view Vendors (erin, of Dot): the tenant and cross-company cases                                                                              |
| `ERP_TEST_KEY_EDIT`        | Phase 7: a user of the `ADMIN`'s company with Vendors' View and Edit, not AdvEdit (gina): the commit cases. Phase 10: also Customers' Edit (3004), not AdvEdit, and no Items on hand                      |
| `ERP_TEST_KEY_ADVEDIT`     | Phase 7: a user of that company with Vendors' View, Edit and AdvEdit (faris): the AdvEdit cases. Phase 10: also Customers' Edit and AdvEdit, every customer, and Items' Edit (4001)                       |
| `ERP_TEST_CONNECTORS`      | The connectors the server has, comma-separated; `vendors,customers,itemsOnHand` by default. Track E4 builds them in that order. The query cases use the first                                             |
| `ERP_TEST_ORIGIN`          | The Origin sent, `http://127.0.0.1:5273` by default; it must be on the ERP's list of Workspace's origins                                                                                                  |
| `ERP_TEST_WORKSPACE_ID`    | The workspace id the suite links, `01930000-0000-7000-8000-00000000c0de` by default                                                                                                                       |
| `ERP_TEST_RATE_LIMITS=1`   | Runs the rate-limit cases: they send until the server answers 429, so this machine's tickets and renewals wait out a window afterwards. On the mock they always run, with limits they set                 |
| `ERP_ALLOW_WRITES=1`       | Needed when the server is not on this machine, since the suite makes and revokes links                                                                                                                    |
| `ERP_BASE_IS_MOCK=1`       | The server at `ERP_BASE_URL` is the mock started by hand (`node tests/mocks/erp/server.mjs`), so its control cases run too                                                                                |
| `ERP_TEST_KEY_SCALE`       | Phase 12: a user of a company holding only the large seed's records (below), who views Vendors, Customers and Items on hand with every field (the national ID too) and no record rule (alice on the mock) |
| `ERP_TEST_KEY_SCALE_ADMIN` | Phase 12: an ERP admin of that company, who links it (dan on the mock). Without both keys `scale.test.ts` skips                                                                                           |

On a real server the suite waits out a 429 as `Retry-After` asks, up to three times a request,
since the server's limits count every ticket and session it makes; the read-only cases share one
session per user to spend fewer.

What a real server must have for the cases to mean something: the `FULL` user sees at least
two pages of the first connector at a page size of a quarter of its records; that connector has a
sortable decimal, integer, date or date-time field, a filterable lookup or boolean field and a
field that is not filterable; the `LIMITED` user's customers are a strict subset of `FULL`'s. Phase
10: the `ADVEDIT` user sees an item stored in two places at least, and three customers; the
ownership case means something when the `EDIT` user sees fewer customers than `FULL` (it checks the
rule only then; on the mock it always does). Phase 12, the reports' roles (the ERP pages' own,
`docs/INTEGRATIONS.md`, "Reports"): `FULL` views all three reports and stock balance's cost (an
accounts manager with Exec or AdvView on unit 4006); `LIMITED` views stock balance without its cost
(a warehouse role, no Exec, no AdvView on 4006) and neither AP aging nor the trial balance; `EDIT`
views AP aging only (payables); `ADVEDIT` views stock balance (a warehouse manager) and not the other
two; `NONE` no report; `OTHER` all three for its own company. The FULL user's company has at least
one vendor with an open AP position, one stock place and one account with lines this year.

## The large seed (Phase 12, Track E10)

`scale.test.ts` runs against a company that holds exactly these records, 100,000 a connector, and
nothing else (on the mock: Kit after `POST /__mock/reset {large: true}`, or `server.mjs --large`;
Dot keeps its usual records). The rule is `tests/mocks/erp/large.mjs`, plain JavaScript with whole
arithmetic and fixed lists: port it as it is. The suite builds the same records from it and knows
what every answer must hold, so the values must be exactly these. In words, for each record number
`n` from 1 to 100,000 (`pad(x, w)` is `x` in `w` digits with leading zeros, `div` whole division,
`%` the remainder, lists indexed from 0):

- `NAMES` (28): `Qorvath`, `qorvath`, `QORVATH`, `Velmorra`, `velmorra`, `Zarkonite`, `Ombrevique`,
  `Brinmoor`, `Calderune`, `Ystrelle`, `Thessaly Quay`, `Lumivar`, `Ébrel`, `ébrel`, then Arabic in
  pairs that differ by one letter form: `أحمد`, `احمد` (alef with hamza, bare alef), `إسراء` (hamza
  below), `آمنة` (madda), `فاطمة`, `فاطمه` (taa marbuta, haa), `مصطفى`, `مصطفي` (alef maqsura, yaa),
  `مُحمّد`, `محمد` (damma and shadda, none), `مؤسسة الشاطئ`, `مؤسسه الشاطي` (hamza on waw and on yaa,
  none), `عبـدالله`, `عبدالله` (tatweel, none). Every character is in the Basic Multilingual Plane.
- **Vendors** (`vendors.1`), in record id order, the order with no sort: `RecId` 1000000 + `n`;
  `vendorAccount` `VA-` + `pad(n, 6)`; `vendorName` `NAMES[n % 28]` + space +
  `[Trading, Supplies, Logistics, للتجارة, للتوريدات, Foods][div(n, 28) % 6]`; `vendorGroup`
  `[LOCAL, IMPORT, SERVICES][n % 3]`; `mobile` null when `n % 10 = 0`, else `010` +
  `pad((n × 7919) % 100000000, 8)`; `currency` null when `n % 17 = 0`, else
  `[EGP, USD, EUR][div(n, 3) % 3]`; `payMethod` `[CASH, NET30, NET60][div(n, 9) % 3]`; `address`
  null when `n % 4 = 0`, else `(n % 200) + 1` + ` Main St`; `taxFile` `pad(n, 9)` when `n % 5 = 0`,
  else null; `blocked` when `n % 13 = 0`; `bankAccount` null; `debitLimit` `0.00` when `n % 11 = 0`
  (the ERP's column is not nullable), else `((n × 37) % 2000) × 5050` cents, written at 2 places; `modifiedBy` `seed`; `modifiedDate`
  2026, month `1 + n % 12`, day `1 + div(n, 12) % 28`, at 12 o'clock and `div(n, 336) % 60` minutes,
  the ERP host's local time (the mock writes `+02:00`; the suite compares the local time only);
  `phone` (searched, never sent) `022` + `pad(n, 7)` when `n % 7 = 0`, else null.
- **Customers** (`customers.1`), in account order (`CA-` and six digits order alike by any
  collation and by ordinal): `RecId` 2000000 + `n`; `customerAccount` `CA-` + `pad(n, 6)`;
  `customerName` `NAMES[(n × 5) % 28]` + space + `[Bakeries, Pharmacy, Markets, صيدليات, أسواق,
Hotels][div(n, 28) % 6]`; `searchName` (searched, never sent) `alias ` + `pad(n, 6)` when
  `n % 6 = 0`, else null; `customerGroup` `[RETAIL, WHOLESALE, EXPORT][n % 3]`; `mobile` null when
  `n % 10 = 0`, else `011` + `pad((n × 104729) % 100000000, 8)`; `mobile2` `012` + `pad(n, 8)` when
  `n % 5 = 0`, else null; `nationalId` `2` + `pad(n × 1013, 13)` when `n % 2 = 0`, else null;
  `currency` null when `n % 19 = 0`, else `[EGP, USD, EUR][div(n, 3) % 3]`; `payMethod` null when
  `n % 23 = 0`, else `[CASH, NET30, NET60][div(n, 9) % 3]`; `priceList` `[null, Retail, retail,
Wholesale 2026][n % 4]`; governorate and city `[(Cairo, Nasr City), (Giza, Dokki), (Alexandria,
Smouha), (القاهرة, مصر الجديدة), (الإسكندرية, سيدي جابر), (الاسكندرية, سيدى جابر)][n % 6]`, the city
  null when `n % 9 = 0`; `address` null when `n % 4 = 0`, else `(n % 200) + 1` + ` Main St`;
  `taxFile` `pad(n × 3, 9)` when `n % 7 = 0`, else null; `creditLimit` null when `n % 10 = 0`, else
  `((n × 53) % 3000) × 3333` cents; `blocked` when `n % 20 = 0`; `createdBy` `[u102, u105, u106,
u101, u199][n % 5]`; `createdDate` 2025, month `1 + n % 12`, day `1 + div(n, 12) % 28`;
  `modifiedBy` `[seed, Seed, u101][n % 3]`; `modifiedDate` 2026, month `1 + div(n, 7) % 12`, day
  `1 + n % 28`, at 12 o'clock and `div(n, 97) % 60` minutes.
- **Items on hand** (`itemsOnHand.1`), record `n` is item `i = div(n - 1, 4) + 1` (25,000 items) at
  storage place `(n - 1) % 4` of `[(S-MAIN, WH-ASW, null), (S-MAIN, WH-CAI, A-01), (S-MAIN, WH-CAI,
A-02), (S-PORT, WH-ALX, B-01)]` (site, warehouse, location), so `n`'s order is the connector's own
  (item, site, warehouse, location, ordinal): `itemId` `IT-` + `pad(i, 6)`; `itemName`
  `NAMES[(i × 3) % 28]` + space + `[olive oil 1 L, steel bolts M8, paper A4, أرز 5 كجم, شاي 250 جم,
cables 2 m][div(i, 28) % 6]` and `itemGroup` `[FOOD, HARDWARE, PAPER][i % 3]` (the item's, on its
  four rows); `unit` `[LTR, PCS, BOX, KG][i % 4]`; the quantity in thousandths `m = s × (((n × 7) %

2000. - 1. × 250`with`s`−1 when`n % 31 = 0`, else 1, written at 3 places as `onHandQty`;
  `onHandValue` `m × (50 + i % 50) / 10`cents when`m > 0`, else 0, at 2 places (no record has both
  at 0); `searchName`(searched, never sent)`alias `+`pad(i, 6)`when`i % 5 = 0`, else null.
  Each record's id is `item|site|warehouse|location`, an empty location as nothing.

The mock's own lists (lookups) hold the codes these use. Its sort, search and `equals` follow
0.10.0's `ConnectorQuery` (`tests/mocks/erp/rules.mjs`; the suite's own reading is `rules.ts`).

## Reports (Phase 12, Track E11)

`reports.test.ts` checks the three report connectors as `docs/INTEGRATIONS.md`'s "Reports" gives
them: listed only when `Connectors?kinds=` names reports, each schema's fields and parameters as its
tables, every parameter's checks (each error `field: "parameters.<name>"`: `request.invalid` for a
name the schema does not list, `type`, `range` for a date before 1900-01-01 or a `dateTo` before
`dateFrom`, `lookup.notFound` for an unknown or inactive code), defaults (`{}` and every parameter
`null` answer as the defaults written out, the company's today being one of the three days around
the suite's), totals over every match on every page, AP aging's labels by `ageBy`, stock balance's
cost rule, each role's access, a query without `parameters` refused, `Commit` refused and
`CommitStatus` `unknown`. Where the contract leaves a choice the mock reads it so, and the suite's
mock-only cases check its exact answers:

- `null` for a parameter is the same as leaving it out (its default); `""` for a lookup is null.
- `totals` holds each `total: 'sum'` field among those the answer's records hold (the request's
  `fields`, else every field the user may see).
- The cursor of a report is bound to its parameters as resolved, so another day's is refused.
- Order with no sort, and ties' order: AP aging by `balance` descending, then `vendorName` ignoring
  case (then ordinal), then the account; stock balance by item, site, warehouse and location;
  the trial balance by `balance` descending, then the account.
- AP aging (the mock's ledger in `tests/mocks/erp/reports.mjs`): invoices and payments up to
  `asOf`; `oldestFirst` applies every payment to the open invoices oldest first, `openItems` a
  payment to the invoice it settles, the rest `unapplied`; an open invoice's age is `asOf` less its
  due date (bands: not due at 0 days or fewer, 1–30, 31–60, 61–90, over 90) or its invoice date
  (0–30, 31–60, 61–90, 91–120, over 120); `balance` the open items less `unapplied`; `overdue` the
  open items past their due date; `oldestDays` the oldest open item's age; a vendor is a row while
  anything is open or unapplied.
- Stock balance: a place is a row once it has a movement up to `asOf`; `includeZero` adds places
  whose quantity and cost are both 0; `unitCost` is cost over quantity at 4 places, half away from
  zero (null at quantity 0); `salesValue` the quantity at the item's price, 2 places; inactive items
  never show; the service's cap (200,000 places, `/__mock/report-limits`) sets `partial`.
- Trial balance: each account of the statement with lines in the period; `share` is 100 × its
  `balance` over the rows' total, at 2 places, null when the total is 0.

`ERP_TEST_*` users need the roles above. The ERP decides a report's access by its page's roles
alone, and every role that opens Vendors also opens AP aging or the trial balance, so against
UnifiedAPI the users `reports.test.ts` needs cannot be the other files' `LIMITED`, `ADVEDIT` and
`NONE`: run it on its own, with `ERP_TEST_KEY_*` set to report users of their own (the ERP seeds
`ws-test-kit-report-full`, `-limited`, `-edit`, `-advedit` and `-none` for it; its
`ContractEnv.ps1 -WorkspaceSuite -Reports`), and the other files without it
(`--exclude tests/contracts/erp/reports.test.ts`). The mock's users hold both. Where the contract
leaves a value's reading open the ERP may read it another way than the mock (stock balance's
`unitCost` at 2 places and `0` at a quantity of 0, for one: `docs/INTEGRATIONS.md`, "As built in
the ERP"), which is why exact values are checked on the mock only. The suite cannot call the ERP's
own services: comparing
each report with what `ApAgingQueryService`, `WarehouseBalanceService` and `GenFinStatmentAsync`
answer for the same parameters is Track E11's own test in the ERP.

## The mock

`node tests/mocks/erp/server.mjs` starts its API on `http://127.0.0.1:4282` and its client on
`http://127.0.0.1:4284` (`--port`, `--client-port`, `CGW_MOCK_ERP_PORT`,
`CGW_MOCK_ERP_CLIENT_PORT`; `--workspace-url` is where its link page sends the admin, by default
`http://127.0.0.1:5273`). The suite starts its own on free ports.

- **Companies:** `Kit` (Kit Trading) and `Dot` (Dot Foods), sharing one database.
- **Users** (API key `mock-<name>`; Phase 12's report roles in the README's table above: alice
  and erin accounts managers with cost, bob the warehouse without cost, gina payables, faris the
  warehouse manager with cost): `alice` (Kit, every connector), `bob` (Kit, Vendors and
  Customers; an employee who sees only the customers he created, `createdBy` `u102`, without their
  `nationalId`), `carol` (Kit, no connector), `dan` (Kit, ERP admin: links), `erin` (Dot, ERP
  admin and every connector); Phase 7: `gina` (Kit, Vendors and Customers, Vendors' Edit), `faris`
  (Kit, every connector, Vendors' Edit and AdvEdit); Phase 10: `gina` also Customers' Edit, and
  like bob only the customers she created (`u105`), `faris` also Customers' Edit and AdvEdit (every
  customer) and Items on hand's Edit.
- **Connectors**: `vendors` (`vendors.1`'s fields, editable as the contract's table says for a user
  with Edit or AdvEdit, `access: edit` for them; 150 for Kit, 12 for Dot; Kit's `V-1005` is locked),
  read-only for everyone else; `customers` (`customers.1`, the real connector's fields: account,
  name, group, mobiles, national ID, currency, payment method, price list, governorate, city,
  address, tax file, credit limit, blocked, created and modified stamps; editable by Phase 10's
  table; 240 and 10, versions made from the values a user sees), `itemsOnHand` (`itemsOnHand.1`:
  one record per item and storage place, its id `item|site|warehouse|location`, no id field; item
  ID, name and group (`scope: 'key'`, the item's), unit, site, warehouse, location, quantity at
  scale 3, value at scale 2; the name and group editable by Phase 10's table, stock never; 60
  items of Kit's in 1 to 3 places, `ITM-0001` in three, and 8 of Dot's). Every record's name holds
  one of `MARKERS`, made-up words found nowhere else, so a test can search a store or a document for
  ERP data.
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
  too. Phase 10: `edit-record` takes `id` in place of `key` (an item's row: a posting moves its
  `onHandQty`), and an item's `itemName` or `itemGroup` changes on every row of the item; `reset`
  takes `kitCustomers` (more of Kit's customers than 240, for `bench/phase10-erp.mjs`); a shared
  field's audit row is one a key, by the first record that changes it. Phase 12: `reset {large:
true}` (the large seed); `/__mock/cursor {cursor, read}` (a cursor of the mock's moved to `read`
  records, to send one past `maxRecords`); `/__mock/add-record {connector, company, values}` (a
  record written between two pages); `/__mock/report-limits {stockPlaces}` (stock balance's cap).
- **Reports** (Phase 12): `apAging`, `stockBalance`, `trialBalance` (`tests/mocks/erp/reports.mjs`),
  listed with `Connectors?kinds=entity,report`, from seeded ledgers: Kit's `V-1001` to `V-1007` and
  `ITM-0001` to `ITM-0003` written out (the mock-only cases' exact answers), the other vendors and
  places made by a generator; a chart of 11 accounts for Kit and one for Dot. Today and the month's
  first day are read in the company's time zone (Africa/Cairo) at the mock's clock.
