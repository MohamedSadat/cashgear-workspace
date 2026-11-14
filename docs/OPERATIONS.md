# Operations

How the Workspace server is deployed, configured, backed up and restored. The design is in
`ARCHITECTURE.md` (The backend, Security, Autosave, version history, backup); the answers behind
the hosting choices are in `DECISIONS.md` (2026-11-12: Phase 2: Q5, Q6, Q8, Q11, deployment).

## What runs where

| Part | Where (Q5, Q6, Q11) | From |
| --- | --- | --- |
| Web app | Azure Static Web Apps at `https://workspace.cashgearerp.com` | `pnpm build` (`apps/web/dist`), built with `VITE_CGW_API=https://workspace-api.cashgearerp.com`; the build writes `staticwebapp.config.json`, whose headers (the Content Security Policy among them) name that API, so build with the variable set |
| API | IIS beside UnifiedAPI, its own site and app pool, at `https://workspace-api.cashgearerp.com` | The deploy package's `api` folder |
| Worker | A Windows service on the same host, `CashGearWorkspaceWorker` | The deploy package's `worker` folder (with `cgw_ydoc.dll`) |
| Database | SQL Server, a database of its own (never the ERP's), full-text search installed if available (Q7) | The migration bundle |
| Blob Storage | One Azure Storage account in the ERP storage account's region, one private container `workspace` | Created once (below) |
| Desktop app | The signed installer from a GitHub release | The release workflow, built with `VITE_CGW_API` and `CGW_API_BASES` |

The two hosts are siblings of one site, so the web session is a `SameSite=Lax` cookie on the
API's host and no token is in JavaScript (Q5).

## The deploy package

`node scripts/server-publish.mjs` writes `target/deploy/cgw-server-<version>.zip`:

| Folder | Holds |
| --- | --- |
| `api/` | The API, framework-dependent .NET 10 for `win-x64`, with `web.config` for the ASP.NET Core Module. It holds no Yjs library (checked when packing) |
| `worker/` | The worker and `cgw_ydoc.dll` |
| `migrate/efbundle.exe` | The EF Core migration bundle: `efbundle.exe --connection "<connection>"` |
| `migrate/migrations.sql` | The same migrations as an idempotent script, for a DBA who runs SQL by hand |
| `deploy/iis/install.ps1` | Installs or updates both on an IIS host (below) |
| `manifest.json` | Version, commit, runtime, build time |

## First installation

1. **Host prerequisites.** Windows Server with IIS, the ASP.NET Core Module and the .NET 10
   runtime (the Hosting Bundle). A group managed service account (gMSA), say
   `DOMAIN\cgw-workspace$`, for both the app pool and the worker.
2. **Database.** Create the database. Give the gMSA a login with `db_datareader`,
   `db_datawriter` and `db_ddladmin` (the bundle creates the tables; `db_ddladmin` can be removed
   after the first run if migrations are run by a DBA instead). Turn on
   `READ_COMMITTED_SNAPSHOT` if the DBA prefers it; both isolation modes were measured (S8).
   Install SQL Server Full-Text Search for server search to use it (Q7); without it search falls
   back to `LIKE` on the normalised text.
3. **Blob Storage.** In the ERP storage account's region (Q11): a storage account with public
   access disabled, a container `workspace` (private), soft delete for blobs and containers on
   (30 days or more), blob versioning on. CORS on the Blob service for the web app's origin and
   the desktop's on each system (`https://workspace.cashgearerp.com`, `http://tauri.localhost` on
   Windows, `tauri://localhost` on macOS): methods `GET`,
   `HEAD`, `PUT`, headers `*`, exposed headers `*`. Phase 5: a second rule for Cash Gear Sheet's
   origins (`https://sheet.cashgearerp.com`): methods `GET`, `HEAD`, `OPTIONS`, headers `*`, exposed
   headers `*` (Sheet's embed and its cloud route read workbooks by signed URL); and tell the Sheet
   repository the account's exact origin (`https://<account>.blob.core.windows.net`) for its CSP
   (Sheet's `apps/web/src/csp.ts` and `staticwebapp.config.json`). Give the host's identity (a managed identity
   on an Azure VM, or a service principal whose `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
   certificate are in the machine's environment) the roles **Storage Blob Data Contributor** and
   **Storage Blob Delegator** on the account: the API signs URLs with user-delegation keys, and
   never holds an account key (D17).
4. **Certificates** in `LocalMachine\My`, readable by the gMSA: the HTTPS certificate for
   `workspace-api.cashgearerp.com`, and two for OpenID Connect (signing and encryption; RSA 2048
   or more, self-signed is fine, they never leave the server). Note their thumbprints.
5. **Mail (Q8).** An SMTP account at the provider you choose: host, port (587 with STARTTLS, or
   465), user and password.
6. **DNS.** `workspace-api.cashgearerp.com` to the IIS host; `workspace.cashgearerp.com` to Static
   Web Apps (its custom-domain wizard).
7. **Install.** Unpack the package, then in an elevated PowerShell, with the SMTP password in the
   session's environment only:

   ```powershell
   $env:CGW_SMTP_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
   .\deploy\iis\install.ps1 -Root C:\CashGearWorkspace -HostName workspace-api.cashgearerp.com `
     -CertificateThumbprint <https> -SigningThumbprint <signing> -EncryptionThumbprint <encryption> `
     -SqlServer <server> -Database CashGearWorkspace `
     -BlobServiceUri https://<account>.blob.core.windows.net -WebOrigin https://workspace.cashgearerp.com `
     -SmtpHost <host> -SmtpUser <user> -ServiceAccount 'DOMAIN\cgw-workspace$'
   # Phase 5's three, shown with their defaults (the live Sheet and ERP):
   #   -SheetOrigin https://sheet.cashgearerp.com -SheetOrigins https://sheet.cashgearerp.com
   #   -ErpApiBase https://api.cashgearerp.com
   Remove-Item Env:\CGW_SMTP_PASSWORD
   ```

   It runs the migrations first (a failure stops it with the old version still serving), copies
   the files, configures the app pool (no managed code, the gMSA, always running) with the
   environment below, binds HTTPS, installs the worker service with the same environment in its
   own registry key, starts both, and prints `/health/ready`.
8. **Web app.** Deploy `apps/web/dist` to Static Web Apps (its GitHub Action with the deployment
   token as a repository secret, as Sheet does), built with
   `VITE_CGW_API=https://workspace-api.cashgearerp.com`, and from 0.5.0
   `VITE_CGW_SHEET=https://sheet.cashgearerp.com`, `VITE_CGW_ERP_API=https://api.cashgearerp.com`
   and `VITE_CGW_ERP_CLIENT=https://erp.cashgearerp.com` (each is written into the CSP the build
   ships: `frame-src` Sheet alone, `connect-src` the ERP's API).
9. **Check.** `/health/ready` shows `sql`, `blob` and `worker` healthy (the worker shows healthy
   once it has validated at least once; until a first push it reports "has not run"). Sign up on
   `https://workspace-api.cashgearerp.com/account/signup`, confirm, sign in from the web app,
   create a workspace, and open it on a second device.

## Configuration

Everything comes from the environment (`Section__Key`); nothing is read from a settings file in
production, and no setting holds a key to Blob Storage or a SQL password.

| Variable | What |
| --- | --- |
| `ConnectionStrings__Sql` | SQL Server, Windows authentication as the app's identity |
| `Blob__ServiceUri`, `Blob__Container` | The storage account's blob endpoint and the container (`workspace`). `Blob__ConnectionString` exists for Azurite in development only |
| `Api__PublicUrl` | The API's public origin: links in mails are built from it, never from the request |
| `Web__AppUrl`, `Web__Origins__N` | The web app's origin (invite links) and every origin allowed by CORS and as a sign-in return address |
| `OpenIddict__SigningCertificateThumbprint`, `OpenIddict__EncryptionCertificateThumbprint` | Certificates in `LocalMachine\My`; the API refuses to issue tokens without them in production |
| `DataProtection__Dpapi` | `true`: the cookie and token keys (kept in the database) are encrypted with the machine's DPAPI |
| `Smtp__Host`, `__Port`, `__User`, `__Password`, `__From` | Mail (Q8); `Smtp__PickupDirectory` writes mail to a folder instead, for development and tests only |
| `RateLimits__anonymous`, `__signin`, `__token`, `__user`, `__push`, `__search`, `__preview`, `__import`, `__ticket`, `__sheet` | Requests per minute (DECISIONS.md, defaults; `import` is a database's CSV import, 20 a minute a person; `ticket` Sheet's Redeem, 30 a minute an address; `sheet` Sheet's session routes, 600 a minute an address); leave unset in production |
| `Sheet__Origin`, `Sheet__Origins__N` | Phase 5: Cash Gear Sheet's origin for launch links (`{origin}/cloud#launch=…`), and the origins allowed to redeem them, to call the sheet-session routes (CORS without credentials) and, outside production, to read Azurite. Required, https, in production |
| `Workbooks__MaxSaveBytes` | The largest version Sheet may save (100 MB; 413 `limit.size` above it). The API's `web.config` lets IIS take bodies up to 110 MB, so the API's own limit answers first |
| `Erp__ApiBase` | The one ERP API an ERP link may name (`https://api.cashgearerp.com`). Required, https, in production. The server never calls it |
| `Databases__CacheRows` | Database rows the API keeps in memory for queries, across databases (300,000 by default, about 300 bytes a row of five properties; the least recently used database goes first). Each API instance has its own cache |
| `Mail__CooldownSeconds` | At most one account mail per address in this many seconds (120); leave unset in production |
| `Logging__Format` | `json` for structured logs with the correlation id in every line |
| `Logging__LogLevel__Microsoft.AspNetCore` | `Warning` (`install.ps1` sets it), so ASP.NET Core's request lines, which hold the query string, are not logged |
| `Ydoc__Library` | The worker's `cgw_ydoc.dll`, if not beside the worker |
| `AZURE_*` | The identity for Blob Storage when the host has no managed identity (DefaultAzureCredential) |
| `Api__AllowHttp`, `OpenIddict__EphemeralKeys`, `Api__PublicUrlFromRequest` | Development shortcuts: plain http (cookies not Secure), signing keys made at start, mail links from the request. The API refuses to start in Production with any of them, or without `Web__Origins`, an https `Api__PublicUrl` and `DataProtection__Dpapi=true`; the rehearsal sets the first two on Staging |

Confirmation links last 24 hours and password reset links one hour, and both carry their token in
the query string: besides the log level above, `install.ps1` leaves the query string (`UriQuery`)
out of the site's IIS log fields. Keep both if the logging is changed.

## Updating

Build the new package, then run `install.ps1` with the same parameters. The migrations run
first; the site and the worker stop for the copy (about a minute). Clients keep working offline
in the meantime and push what waited when the API answers again. A migration is never edited
once released; a change ships as a new one.

Version 0.3.0's migrations add the Phase 3 columns and indexes (`Phase3Offline`) and turn on
`READ_COMMITTED_SNAPSHOT` (`ReadCommittedSnapshot`, `ALTER DATABASE ... WITH ROLLBACK
IMMEDIATE`, outside a transaction): the migration's login needs `ALTER` on the database, and the
transactions open on the old version are rolled back once (the clients retry them). Azure SQL
has the setting on already. To undo it, `ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT OFF`;
the change feed's ordering does not depend on it.

Version 0.4.0's migration (`Phase4Databases`) adds the `Databases`, `DatabaseViews` and
`DatabaseRows` tables and a filtered index on `Pages`; it runs in a transaction like the others. The
worker gains the `recompute` job (formula and rollup results of databases marked pending, every 2 s).
A database's first query on an API instance reads all its rows into memory (about 2 s for 50,000
rows on the reference machine); later ones read only rows written since.

Version 0.5.0's migration (`Phase5Workbooks`) adds `Workbooks`, `WorkbookVersions`,
`WorkbookPermissions`, `WorkbookPreviews`, `WorkbookTickets`, `FileSessions` and `ErpLinks`, in a
transaction like the others. Before installing it, add the Blob Storage CORS rule for Sheet's
origins (First installation, step 3); `install.ps1` sets `Sheet__Origin`, `Sheet__Origins__0` and
`Erp__ApiBase` (the live ones by default), without which the API refuses to start. The worker gains
`workbookRetention` (workbooks in the trash for 60 days). The web app is built with the three
`VITE_CGW_SHEET`, `VITE_CGW_ERP_*` variables above.

The ERP's side (Track E, in its repositories, deployed by you): run
`CashGear.IdentitySystem/DbScripts/Create_WorkspaceConnect.sql` on CGService before deploying a
UnifiedAPI built with Track E (Sheet's sessions read its columns too), deploy UnifiedAPI, then add
a company to `WorkspaceConnect:Companies` to turn Workspace on for it; deploy ERPClient_React
(its "Link Cash Gear Workspace" stays hidden until then). Sheet's side: deploy Sheet's web app
with Track S3 to S5 (its `/embed` route), and give it the storage account's origin as above.

## Backups and the restore drill

- **SQL Server.** Full backups daily, differential every 6 hours, log backups every 15 minutes,
  kept 35 days (point-in-time restore). On Azure SQL this is the default policy.
- **Blob Storage.** Soft delete and versioning on (30 days or more); the container is never
  public.
- **SQL and Blob drift after a restore** (ARCHITECTURE.md): the worker's reconcile job runs every
  hour and at start. A snapshot row whose blob is missing is undeleted from soft delete if it
  can be, else dropped and logged; blobs no row names are deleted after a day; an asset whose
  blob is missing is marked deleted.
- **The drill**, each release and after any change to storage: `node scripts/restore-drill.mjs`
  backs up a seeded scratch database, copies its blobs, restores both into a scratch environment,
  starts the API and the worker on it, lets the reconcile job run, and opens every page through
  the API, comparing each with the original (`bench/results/restore-drill.json`). In production
  the same steps are: restore the database to a new name at a point in time, copy the container
  (or restore deleted blobs), point a staging app pool at both, check `/health/ready`, open pages.

## Operating

| Watch | Where | Act when |
| --- | --- | --- |
| The worker's lag | `/health/ready` (`worker`); `JobStates` (`LastOkAt` per job) | Degraded: new edits wait to reach other devices (pulls still work). Restart the service; read its event log |
| Refused updates | Worker log ("Refused N of M updates"); `AuditLog` `doc.forgedClient` | A client sending updates as someone else: look at the device and user |
| Failed sign-ins and lockouts | `AuditLog` `signin.fail`, `signin.lockedOut` | Many from one IP: block it at the edge |
| Rate limits | 429 answers with `limit.rate` in the logs | A client in a loop |
| Storage used | `Workspaces.StorageUsedBytes` (Q10: recorded, not enforced) | — |
| Retention | `JobStates` for `feedRetention` and `trashRetention` (every 10 minutes); `AuditLog` `page.purgedByRetention` | The change feed keeps 90 days and the trash 60 (DECISIONS.md, Phase 3); a device away longer than 90 days takes the whole tree when it returns (`410 feed.expired`) |
| Database results | `JobStates` for `recompute`; `Databases.ComputePending` rows waiting | Formula and rollup results of big databases lag while it is behind; filters on them use the last results |
| Validation lag | `/health/ready` and `JobStates` (`validate`, on a loop of its own) | Edits reach other people within 5 s at p95 with 200 people typing (`bench/phase2.mjs`); longer means the worker or the database is short of something |

Signing a device out (the user's devices list, or `DELETE /api/v1/account/devices/{id}`) ends its
session and revokes its tokens at once. Workspace and account deletion are in the app; deleted
workspaces are purged after 30 days.
