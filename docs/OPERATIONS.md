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
| Sites (Phase 9) | IIS on the same host, a site and app pool of their own, `CashGearWorkspaceSites`, at `https://pages.cashgearerp.com`: published pages as HTML, an origin of its own so a published page can read neither the app's nor the API's session. From 0.10.0 the same site also answers `https://plugins.cashgearerp.com` (a second host-name binding): third-party plugins' files, only under a frame ticket the API made for a member | The deploy package's `sites` folder: no sign-in code, no cookies, no Yjs library (checked when packing), no Data Protection; it reads the database and Blob Storage only, and (0.10.0) its identity is denied the Data Protection key ring's table |
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
| `sites/` | Phase 9: the Sites process, framework-dependent .NET 10 for `win-x64`, with its own `web.config` (bodies over 64 KB refused; IIS's `Server` and `X-Powered-By` headers removed). It holds no Yjs library and no OpenID Connect server (checked when packing) |
| `migrate/efbundle.exe` | The EF Core migration bundle: `efbundle.exe --connection "<connection>"` |
| `migrate/migrations.sql` | The same migrations as an idempotent script, for a DBA who runs SQL by hand |
| `deploy/iis/install.ps1` | Installs or updates both on an IIS host (below) |
| `manifest.json` | Version, commit, runtime, build time |

## First installation

1. **Host prerequisites.** Windows Server with IIS, the ASP.NET Core Module and the .NET 10
   runtime (the Hosting Bundle). From 0.6.0, IIS's WebSocket Protocol feature (`Web-WebSockets`),
   for the real-time hub: `install.ps1` turns it on when it is off. A group managed service account (gMSA), say
   `DOMAIN\cgw-workspace$`, for both the app pool and the worker. A host outside a domain has no
   gMSA: leave out `-ServiceAccount` and the app pool runs as its own `IIS AppPool\<site>`, the
   worker as `NT SERVICE\<service>`; `install.ps1` gives both their SQL login and user (the roles
   below) and read access to the OpenID Connect keys and the Azure certificate file once they
   exist.
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
   never holds an account key (D17). `DefaultAzureCredential` reads a service principal's
   certificate from a file (`AZURE_CLIENT_CERTIFICATE_PATH`), not from a store: make it on the
   host (`New-SelfSignedCertificate`), write it as a PFX without a password under
   `<root>\secrets`, readable only by administrators and the two identities, and upload only its
   public half to the app registration; `install.ps1` takes `-AzureClientId`, `-AzureTenantId`
   and `-AzureCertificatePath`.
4. **Certificates** in `LocalMachine\My`, readable by the gMSA: the HTTPS certificate for
   `workspace-api.cashgearerp.com`, and two for OpenID Connect (signing and encryption; RSA 2048
   or more, self-signed is fine, they never leave the server). Note their thumbprints.
5. **Mail (Q8).** An SMTP account at the provider you choose: host, port (587 with STARTTLS, or
   465), user and password.
6. **DNS.** `workspace-api.cashgearerp.com` to the IIS host; `workspace.cashgearerp.com` to Static
   Web Apps (its custom-domain wizard); from 0.9.0 `pages.cashgearerp.com` to the IIS host too,
   with a certificate for it (the host's `*.cashgearerp.com` covers it); from 0.10.0
   `plugins.cashgearerp.com` to the IIS host as well, with its certificate (the same wildcard
   covers it). The DNS records and the certificates are the owner's to make.
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
   # Phase 9's sites, shown with their defaults (the certificate is the API's unless given):
   #   -SitesHostName pages.cashgearerp.com -SitesSiteName CashGearWorkspaceSites -SitesCertificateThumbprint <https>
   # Phase 10's plugins host, a second binding of the sites' site (the certificate is the sites' unless given):
   #   -PluginsHostName plugins.cashgearerp.com -PluginsCertificateThumbprint <https>
   # Phase 13's local model and Cash Gear's subscription (its keys as the SMTP password, in
   # $env:CGW_AI_ANTHROPIC_KEY and $env:CGW_AI_VOYAGE_KEY, removed after):
   #   -LocalModel <cgw-local-model-voyage-4-nano-587d8d6.zip> -LocalModelThreads 8
   #   -AiMonthlyTokens 2000000 -AiEmbeddingsMonthlyTokens 5000000
   # Phase 18's completion model and paid plans (Paddle's key and webhook secret as the SMTP
   # password, in $env:CGW_PADDLE_API_KEY and $env:CGW_PADDLE_WEBHOOK_SECRET, removed after):
   #   -CompletionModel <cgw-completion-model-qwen3.5-4b-851bf6e.zip> -CompletionModelThreads 6
   #   -PaddleClientToken <live_…> -BillingPlans @{ team = @{ PriceId = 'pri_…'; MonthlyTokens = 10000000; EmbeddingsMonthlyTokens = 10000000; NameEn = 'Team'; NameAr = 'الفريق' } }
   Remove-Item Env:\CGW_SMTP_PASSWORD
   ```

   A host that keeps its site certificates in IIS's `WebHosting` store passes
   `-CertificateStore WebHosting`; the binding is always by host name (SNI), so the host's other
   sites on 443 keep theirs. A SQL Server on the same host with its own self-signed certificate
   takes `-TrustServerCertificate` (still encrypted, not verified).

   It runs the migrations first (a failure stops it with the old version still serving), copies
   the files, configures the app pool (no managed code, the gMSA, always running) with the
   environment below, binds HTTPS, installs the worker service with the same environment in its
   own registry key, starts both, and prints `/health/ready`. From 0.9.0 it also makes the sites'
   app pool and site (`CashGearWorkspaceSites`, bound by SNI to `-SitesHostName`), with only the
   database's and storage's settings (no SMTP password, no OpenID Connect certificates), gives a
   built-in identity `db_datareader` alone and read on the Azure certificate file, and prints the
   sites' `/health/live`. From 0.10.0 it adds the site's second binding, `-PluginsHostName` (by SNI
   too), gives the sites' app pool `Plugins__PublicUrl` and the Web origins (a plugin frame's
   allowed ancestors), denies a built-in sites identity `SELECT` on `DataProtectionKeys` (below),
   and checks the plugins host answers its 404 page.
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

## Production as installed

Installed 2026-11-14 (0.5.0); updated to 0.10.0 on 2026-11-19 with `install.ps1`, which also
installed the Sites process, to 0.12.0 on 2026-11-21 (Phase 11's migrations, the passkeys' relying
party `workspace-api.cashgearerp.com`), and to 0.18.0 on 2026-11-26 (Phases 13 to 18's migrations,
the local embedding model, a site's own host names; PROGRESS.md, After 0.18.0: production), and on
2026-11-28 to 0.19.0 at `5119c49` (`SiteCertificateDirectory` and `Phase19PageLayout`, voice notes'
audio; every app pool and worker variable unchanged). The web
app deploys itself on every push, the server does not: check `GET /api/v1/version` against the
release when something new fails in production (from 2026-11-20 to 2026-11-21 the 0.11 and 0.12 web
apps ran against the 0.10.0 API, and from 2026-11-22 to 2026-11-26 the 0.13 to 0.18 web apps against
the 0.12.0 API). Names only; no setting here is a secret.

An update, as done for 0.12.0 and 0.18.0:
1. Copy the package onto the host over Remote Desktop's clipboard (no drive is redirected), into
   `C:\CashGearWorkspace\packages`, and compare its hash.
2. Take a copy-only backup and verify it with `RESTORE VERIFYONLY`.
3. Run `install.ps1` from an administrator's PowerShell, with its parameters read back from the API
   app pool's environment, its HTTPS binding and the worker's environment.
   `CGW_SMTP_PASSWORD` and `CGW_SITES_CERT_PASSWORD` are set from those environments in that
   session, so no setting is typed again.
4. Compare the app pools' and the worker's variables with a copy taken before.

From 0.18.0, scripts beside the packages do steps 3 and 4 (not in the repo):
- `cgw-install.ps1 -Package <unpacked package> [-LocalModel <zip>] [-CustomDomains -AgreeToAcmeTerms] [-DryRun]`
  runs step 3.
- `cgw-snap.ps1` and `cgw-compare.ps1` take and compare the copies, with secrets shown only as a
  short hash.
- `cgw-live.ps1` reads the host names' certificates, reminders, the mail queue, webhook deliveries
  and runs.

0.18.0's first run stopped at "Copying api failed (9)": a `w3wp` of the API pool was still alive
after the pool read `Stopped`. From the release after 0.18.0, `install.ps1` waits for a pool's
processes as well as its state. It finds them by `-ap "<pool>"` on their command line, and at the
deadline (the pool's `shutdownTimeLimit` and 30 s) it ends one still running, with a warning. With
0.18.0's own script, end it by hand (`Get-CimInstance Win32_Process -Filter "name='w3wp.exe'"` names
its pool after `-ap`) and run `install.ps1` again: the migrations already applied are skipped. In
0.19.0's run the API pool's old process overran its shutdown and was ended at the deadline as meant;
the script also counted exited `w3wp`s whose handles something still held (no threads, no memory, no
command line left; one was 0.18.0's process ended by hand), which cost only the wait. On
the host, `sqlcmd` needs `-I` for writes to a table with a filtered index (`QUOTED_IDENTIFIER`).

| Part | Where |
| --- | --- |
| Web app | Static Web App `cashgear-workspace-web` (Free plan) in resource group `rg-cashgear-workspace`, custom domain `workspace.cashgearerp.com`; deployed by `.github/workflows/azure-static-web-apps-ambitious-field-02a19e810.yml` on every push to `main` |
| API and worker | The IIS host behind `api.cashgearerp.com` (Windows Server 2022, workgroup): site and app pool `CashGearWorkspaceApi`, service `CashGearWorkspaceWorker`, files under `C:\CashGearWorkspace`, built-in identities; IIS has WebDAV Publishing installed for other sites, which the `web.config`s remove (from after 0.10.0: with it, every `PUT` and `DELETE` was answered 405); deploy packages unpacked under `C:\CashGearWorkspace\packages`, and a copy-only backup before each update in SQL Server's own backup folder (`CashGearWorkspace-pre-<version>-<date>.bak`) |
| HTTPS | The `*.cashgearerp.com` certificate in `WebHosting` (valid until 2027-01-02), bound by SNI to `workspace-api.`, `pages.` and `plugins.cashgearerp.com` |
| Database | `CashGearWorkspace` on the host's `MSSQLSERVER01` instance (SQL Server 2019 Standard, no Full-Text Search: search uses `LIKE`) |
| Blob Storage | Storage account `cashgearworkspace` (Spain Central, Standard LRS, no public access, soft delete and container soft delete 30 days, versioning), container `workspace`, CORS as in step 3 |
| Blob identity | App registration `cashgear-workspace-api` with Storage Blob Data Contributor and Storage Blob Delegator on that account only; its certificate made on the host, PFX in `C:\CashGearWorkspace\secrets` (expires 2028-11-14; the app registration accepts it until 2027-11-14, so upload it again or make a new one before then) |
| Sites | Site and app pool `CashGearWorkspaceSites` (from 2026-11-19), bound to `pages.cashgearerp.com` and `plugins.cashgearerp.com`, both pointed at the host by DNS |
| A site's own host names | `-CustomDomains` from 2026-11-26, Let's Encrypt's production directory (its terms agreed by the owner), no contact address. Certificates: `C:\CashGearWorkspace\certificates`. Binding: the task `\Cash Gear Workspace\Site bindings`, its log `C:\CashGearWorkspace\logs\site-bindings.log`. ACME's path on Default Web Site goes to `pages.`. The certificates' password is only in the worker's environment, made on the host and read back by the next update. `docs.test.cashgearerp.com` serves the test workspace "Live checks"' site. After the switch from `-AcmeStaging` to the production directory, its live staging certificate was replaced only once its `CertificateRenewAt` was set to now by SQL (the worker renews with a third of a certificate's life left); from the release after 0.18.0 the worker replaces it by itself (A site's own host name, the switch from staging to production) |
| DNS | cashgearerp.com at Squarespace (Google Cloud DNS's name servers; its edits ask for the owner's authenticator code). A wildcard `*` A record leads to the host, but a site's own name still needs its own `CNAME` to `pages.cashgearerp.com`: the proof's `TXT` record at `_cashgear-workspace.<name>` makes the name exist, and a wildcard covers no existing name. Squarespace's console appends the zone to a record's name: type `_cashgear-workspace.docs.test`, not the full name |
| Local models | `voyage-4-nano` in `C:\CashGearWorkspace\models\voyage-4-nano` (from 2026-11-26, `cgw-local-model-voyage-4-nano-587d8d6.zip`), offered as "On this server". Not installed: the completion model, Cash Gear's subscription keys, and Paddle (billing off) |
| Mail | `smtp.gmail.com:587` as `info@cashgearerp.com` (the ERP's account), with its own Google app password named "Cash Gear Workspace", entered on the host only. Gmail answers a wrong one with `535 5.7.8` (in the event log as "A confirm mail was not sent: AuthenticationException…"); test a new password from the host (an SMTP `AUTH` alone sends nothing) before storing it in the app pool's and the worker's `Smtp__Password` |

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
| `RateLimits__anonymous`, `__signin`, `__token`, `__user`, `__push`, `__search`, `__preview`, `__import`, `__ticket`, `__sheet`, `__realtime`, `__ai`, `__meaning`, `__frames`, `__pull` | Requests per minute (DECISIONS.md, defaults; `import` is a database's CSV import, 20 a minute a person; `ticket` Sheet's Redeem, 30 a minute an address; `sheet` Sheet's session routes, 600 a minute an address; `realtime` hub tickets, 60 a minute a person; the hub's pushes count against a budget the size of `push`, apart from HTTP; `ai` AI completions, 30 a minute a person; Phase 10: `meaning` searches by meaning, 30 a minute a person; `frames` plugin frame tickets, 120 a minute a person; Phase 12: `pull` batch pulls of up to 100 documents, 120 a minute a person). `anonymous`, `signin`, `token`, `ticket` and `sheet` count an address's requests; every other a person's, signed in by the web's cookie or the desktop's token, in one window on every address they ask from, and an address's for a caller not signed in, so people behind one office address no longer share them (2026-11-21). The address is the connection's, as IIS hands it over in process: no forwarded header is read; leave unset in production |
| `Realtime__RelayMs`, `__RecheckSeconds`, `__SweepSeconds`, `__ChangesMs` | Phase 6, the hub: how often the relay reads joined pages' and followed workspaces' heads (20 ms); the longest a connection's access is trusted unchecked (60 s) and how often the sweep looks (10 s); `ChangesAvailable` at most this often a workspace (250 ms). Leave unset in production |
| `Realtime__Metrics` | `true` maps `GET`/`DELETE /api/v1/realtime/metrics` (relay times, connections) for the bench; ignored in Production |
| `Sheet__Origin`, `Sheet__Origins__N` | Phase 5: Cash Gear Sheet's origin for launch links (`{origin}/cloud#launch=…`), and the origins allowed to redeem them, to call the sheet-session routes (CORS without credentials) and, outside production, to read Azurite. Required, https, in production |
| `Sheet__DesktopOrigins__N` | Phase 9 (Track S6): the origins of Sheet's desktop app, which alone redeem a desktop launch ticket (`cashgear-sheet://workspace/launch#ticket=…`) and are allowed by the sheet-session routes' CORS. Default `http://tauri.localhost` and `tauri://localhost`, in production too; leave unset |
| `Sites__Acme__Directory`, `Sites__Acme__AgreeToTerms`, `Sites__Acme__Email`, `Sites__Acme__IntervalSeconds`, `Sites__CertificateStore` | Phase 14, the API and the worker: where a site's own host names' certificates come from (an ACME directory, https in Production; `install.ps1 -CustomDomains` sets Let's Encrypt's, or its staging's with `-AcmeStaging`), that its operator agreed to its terms (`true`; nothing is ordered otherwise), an optional contact, how often the worker looks (60 s), and the folder it writes each name's `<host>.pfx` to (`<Root>\certificates`), which the host's scheduled task binds. Without them the app says the server makes no certificates |
| `Sites__CertificatePassword` | Phase 14, the worker only: the certificates' private key password. A secret, from `CGW_SITES_CERT_PASSWORD` in the installing session; the binding task reads it, as SYSTEM, from the worker service's environment |
| `RateLimits__formMinute`, `RateLimits__formDay` | Phase 16, the API: the answers one address may send to one form link a minute (10) and a day (100), an IPv6 address by its /64, kept in the API's memory (a restart starts both again; each API instance has its own), before the `anonymous` window, which the answers count against too. Past either, 429 with `Retry-After` and a page saying so. The e2e stack raises both for the bench. Leave unset in production |
| `RateLimits__sites`, `RateLimits__sitesPlugins` | Phase 14, the Sites process: pages and files a minute one address may ask of every site together (300), and of the plugins host (1,200); an IPv6 address counted by its /64; `robots.txt`, `/health/live` and ACME's challenges are outside both. The address is the connection's (IIS in process). Leave unset in production |
| `Sites__PublicUrl` | Phase 9, the API: the sites' public origin (`https://pages.cashgearerp.com`), from which a site's address is built, never from a request. Required, https, in production (`install.ps1` sets it from `-SitesHostName`). The Sites process itself reads only `ConnectionStrings__Sql`, `Blob__*`, `AZURE_*`, `Logging__*`, (Phase 10) the two below, (Phase 14) this one, to tell its own host name from a site's own, its rate limits, and (Phase 16) `Api__PublicUrl`, where a form link's last page is sent on to |
| `Plugins__PublicUrl` | Phase 10, the API and the Sites process: the plugins' origin (`https://plugins.cashgearerp.com`). The API builds a frame's address from it (`{origin}/f/{ticket}/{entry}`) and refuses to start in production without an https one; the Sites process answers that host name alone with plugins' files (`install.ps1` sets both from `-PluginsHostName`). Development and e2e: `http://localhost:5291` |
| `Identity__Passkeys__ServerDomain` | Phase 11, the API: the passkeys' relying party id, the API's own host (`workspace-api.cashgearerp.com`), never a wider domain (the ERP, the sites and the plugins could then ask for assertions). Required in production, and it must be the host of `Api__PublicUrl`, or the API does not start (`install.ps1 -PasskeyDomain`, default `workspace-api.cashgearerp.com`, refused unless it is `-HostName`). A ceremony is accepted only from the origin of `Api__PublicUrl`. Changing it later makes every passkey made for the old name useless (people sign in with their password and add one again). Unset on a developer's machine: the request's host, and the request's own origin too, so the e2e stack's passkey specs run on `http://localhost:5280` |
| `Sso__DnsBaseUrl` | Phase 11, development and the e2e stack only: a domain's `TXT` record is read from the mock OpenID Connect provider's DNS stand-in (`{base}/__mock/dns?name=`, `tests/mocks/oidc`) instead of DNS. The API refuses to start in Production with it set. In production the API asks the host's own resolvers (DnsClient, no cache, 5 s, two tries, TCP when UDP is cut short) for `TXT _cashgear-workspace.<domain>` when an owner presses Verify, and at no other time: the API host needs DNS on 53 (UDP and TCP) to its resolvers |
| `Web__Origins__N` (Sites) | Phase 10, the Sites process: the origins a plugin's frame may be framed by (its CSP's `frame-ancestors`): the web app's and the desktop's (`install.ps1` sets the same three as the API's) |
| `Workbooks__MaxSaveBytes` | The largest version Sheet may save (100 MB; 413 `limit.size` above it). The API's `web.config` lets IIS take bodies up to 110 MB, so the API's own limit answers first |
| `Erp__ApiBase` | The one ERP API an ERP link may name (`https://api.cashgearerp.com`). Required, https, in production. The server never calls it |
| `Ai__Enabled` | Phase 7: `false` turns AI off for every workspace on this server, whatever their settings say (on by default; each workspace is off until an owner or admin turns it on with the workspace's own Anthropic key) |
| `Ai__Models__N` | The Claude models an admin may choose, the first the default (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) |
| `Ai__AnthropicBaseUrl` | Development and tests only: where the provider is (the mock in `tests/mocks/ai`). Ignored in Production, where a workspace's key goes only to Anthropic's API. For AI, the API host must reach `https://api.anthropic.com` on 443 |
| `Ai__VoyageBaseUrl` | Phase 10, development and tests only: where the embeddings provider is (the mock's `/v1/embeddings`). Ignored in Production, where a workspace's Voyage key goes only to Voyage's API: for search by meaning the API host and the worker's must reach `https://api.voyageai.com` on 443 |
| `Ai__EmbeddingsCacheMb` | Phase 10, the API: the most memory its copies of workspaces' vectors take together (1,024; from Phase 13 1,280: about 1.1 KB a chunk with its sign bits, so a million chunks); the least recently used workspace's copy goes first and loads again on its next search. Each API instance has its own |
| `Ai__EmbeddingsApproximateFrom`, `Ai__EmbeddingsCandidates` | Phase 13, the API: past this many chunks a workspace (200,000) a search ranks every chunk by its sign bits first and scores exactly only the nearest this many (4,096). Leave unset in production |
| `Ai__LocalModel__Path` | Phase 13, the API and the worker: the folder of the local model's package (`voyage-4-nano`; `install.ps1 -LocalModel` unpacks it to `<Root>\models\voyage-4-nano` and sets this). Set, and its files the ones pinned in the server's code, the model is offered in Settings as "On this server"; a package that fails the check is not offered and the log says why. The Sites process is never given it |
| `Ai__LocalModel__Threads`, `Ai__LocalModel__IdleMinutes` | Phase 13: the processor threads one embedding takes (half the processors, at most 8; `install.ps1 -LocalModelThreads`), and how long the model stays loaded unused (30). Loaded, it takes about 1 GB in each of the API and the worker |
| `Ai__Subscription__AnthropicKey`, `__VoyageKey` | Phase 13, the API and the worker: Cash Gear's own keys for its subscription, from the environment only (`install.ps1` reads `CGW_AI_ANTHROPIC_KEY` and `CGW_AI_VOYAGE_KEY` from its session, as the SMTP password; never a parameter or a file). Without one, that part is not offered on the subscription |
| `Ai__Subscription__MonthlyTokens`, `__EmbeddingsMonthlyTokens`, `__Workspaces__<id>__MonthlyTokens`, `__Workspaces__<id>__EmbeddingsMonthlyTokens` | Phase 13: a workspace's allowance a calendar month (UTC) in tokens, input and output alike, for AI and for search by meaning; a workspace's own by its id. 0 or unset: not offered (`install.ps1 -AiMonthlyTokens`, `-AiEmbeddingsMonthlyTokens`, `-AiWorkspaceMonthlyTokens @{'<id>' = n}`, `-AiWorkspaceEmbeddingsMonthlyTokens`). Past it, the workspace's calls are refused until the next month (429 `ai.limit`) |
| `Ai__CompletionModel__Path` | Phase 18, the API only: the folder of the local completion model's package (`qwen3.5-4b`; `install.ps1 -CompletionModel` unpacks it to `<Root>\models\completions` and sets this). Set, and its files the ones pinned in the server's code, the model is offered in Settings → AI as "This server's own model". The worker and the Sites process are never given it |
| `Ai__CompletionModel__Threads`, `__IdleMinutes`, `__Queue` | Phase 18: the processor threads one answer takes (half the processors, at most 8; `install.ps1 -CompletionModelThreads`), how long the model stays loaded unused (30), and how many answers may wait for the one being written (8; `-CompletionModelQueue`; past it 503 `ai.limit`). Loaded and writing, it took the spike's API about 5.6 GB at its peak on the production host |
| `Billing__Paddle__ApiKey`, `__WebhookSecret` | Phase 18, the API and the worker: Paddle's API key and the notification destination's secret, from the environment only (`install.ps1` reads `CGW_PADDLE_API_KEY` and `CGW_PADDLE_WEBHOOK_SECRET` from its session, as the SMTP password). Without both, or with no plan, nothing of billing is offered and its routes answer 404 |
| `Billing__Paddle__ClientToken`, `__Environment` | Phase 18: Paddle's client-side token (public by Paddle's design), the one thing of Paddle's the Sites process is given, for its pay page (`-PaddleClientToken`); `sandbox` or `live` (`-PaddleEnvironment`; unset, the API key's own prefix says) |
| `Billing__Plans__<id>__PriceId`, `__MonthlyTokens`, `__EmbeddingsMonthlyTokens`, `__Names__en`, `__Names__ar` | Phase 18: each paid plan: Paddle's price (`pri_…`, whose amount is Paddle's catalogue's) and the allowance a month it gives for AI and for search by meaning, and its names (`install.ps1 -BillingPlans @{ team = @{ PriceId = 'pri_…'; MonthlyTokens = …; EmbeddingsMonthlyTokens = …; NameEn = 'Team'; NameAr = '…' } }`). A workspace on a plan has the larger of the plan's and the default allowance; its own override still wins |
| `Ai__EmbeddingsFloor`, `Ai__EmbeddingsFloors__<model>` | Phase 10, the API: the least cosine similarity a page found by meaning must have (0.3, for every model unless one has its own); a question with no page above it finds none. Raise it if unrelated pages show under "Related by meaning"; lower it if related ones are missed |
| `Ai__EmbeddingsSettleSeconds` | Phase 10, the worker: how long a page is left unchanged before it is embedded (30; the e2e stack sets 1, the server's tests 0). Leave unset in production |
| `Automations__AllowLoopback` | Phase 15, development and tests only (`true`): a webhook may call http on a loopback address (the e2e stack's mock receiver). Ignored in Production, where a webhook calls https on port 443 to a public address only. For webhooks, the worker's host must reach its receivers on 443 |
| `Databases__CacheRows` | Database rows the API keeps in memory for queries, across databases (300,000 by default, about 300 bytes a row of five properties; the least recently used database goes first). Each API instance has its own cache |
| `Mail__CooldownSeconds` | At most one account mail per address in this many seconds (120); leave unset in production |
| `Mail__NotificationDelaySeconds` | Phase 8: a mention, a mention in a comment or a reply is mailed once it has been unread this long, and a person gets at most one such mail in this long (900, 15 minutes; a daily summary once a day). The e2e stack sets 5. Leave unset in production |
| `Mail__DailyCap` | Phase 8: notification mails sent in any 24 hours, at most (1,500); what is over waits in the queue for room. Keep it under the SMTP account's own limit (Google Workspace: 2,000 a day, and the account mails count there too); a personal Gmail account allows 500 |
| `Logging__Format` | `json` for structured logs with the correlation id in every line |
| `Logging__EventLog__Enabled` | `true` (`install.ps1` sets it and registers the sources): under IIS and as a service the console goes nowhere, so warnings and errors also go to the Application event log, as "Cash Gear Workspace API", "Cash Gear Workspace worker" and (Phase 9) "Cash Gear Workspace sites", and each account mail sent or not sent, by kind only (never its address or link) |
| `Logging__LogLevel__Microsoft.AspNetCore` | `Warning` (`install.ps1` sets it), so ASP.NET Core's request lines, which hold the query string, are not logged |
| `Ydoc__Library` | The worker's `cgw_ydoc.dll`, if not beside the worker |
| `AZURE_*` | The identity for Blob Storage when the host has no managed identity (DefaultAzureCredential) |
| `Api__AllowHttp`, `OpenIddict__EphemeralKeys`, `Api__PublicUrlFromRequest` | Development shortcuts: plain http (cookies not Secure), signing keys made at start, mail links from the request. The API refuses to start in Production with any of them, or without `Web__Origins`, an https `Api__PublicUrl` and `DataProtection__Dpapi=true`; the rehearsal sets the first two on Staging |

Confirmation links last 24 hours and password reset links one hour, and both carry their token in
the query string: besides the log level above, `install.ps1` leaves the query string (`UriQuery`)
out of the site's IIS log fields. Keep both if the logging is changed. (Phase 11: a provider's
answer to `/account/sso/callback` carries its one-use code in the query string too.)

### Single sign-on (Phase 11)

Set up per workspace by its owners in the app (Settings, Single sign-on); nothing here is
configured on the server but the network:

- **What an owner registers at their provider** (a "web" application of Microsoft Entra ID, Google
  Workspace, Okta and the like): the redirect URI `{Api__PublicUrl}/account/sso/callback`
  (`https://workspace-api.cashgearerp.com/account/sso/callback`; the app shows it), the
  authorisation code flow with PKCE (S256), the scopes `openid email profile`, a client secret
  (sent by `client_secret_basic`, or `client_secret_post` when that is all the provider offers),
  and id tokens signed RS256, RS384, RS512, ES256, ES384 or PS256 that carry `email` (and, where
  the provider has it, `email_verified`). Then the owner enters the issuer (exactly as the
  provider's discovery document names it), the client id and the secret, and proves each email
  domain with the `TXT` record the app shows.
- **What the API reaches**: the issuer's `/.well-known/openid-configuration`, its `jwks_uri` (read
  again hourly) and its `token_endpoint`, over https on whatever port they name; in Production
  only at public addresses (the link previews' guard), with no redirect followed and 10 seconds
  and 1 MB at most each. A provider on a private network is refused.
- **Before turning required sign-on on**, an owner signs in through the provider once (the app
  says when it has been): that is the test it needs. Owners always keep their password, so a
  broken provider never locks out whoever can mend it. Turning it on signs out the domain's
  sessions not made through the provider (each `device.revoke` audited); a session made through
  the provider ends after the workspace's session length (24 hours unless set), as no one is
  told when someone leaves the organisation (there is no SCIM).

### Billing through Paddle (Phase 18)

Cash Gear's AI subscription is paid through Paddle, the merchant of record (INTEGRATIONS.md, Billing).
Whoever runs the server sets it up once, in Paddle's dashboard (the sandbox first, then live; each
has its own keys, settings and catalogue):

1. **The catalogue**: a product for the subscription and a price a plan, monthly (Catalog →
   Products). The plans' amounts are Paddle's; each price's id (`pri_…`) goes into a plan of
   `-BillingPlans` with the allowance it gives.
2. **An API key** (Developer tools → Authentication) with the permissions the server uses:
   transactions (read and write), subscriptions (read and write), customer portal sessions (write),
   prices (read). Paddle's keys expire (90 days unless chosen otherwise, a year at most) and mail
   before they do: make a new one and run `install.ps1` again with it in `CGW_PADDLE_API_KEY`. A
   **client-side token** for the pay page (`-PaddleClientToken`).
3. **A notification destination** (Developer tools → Notifications): `https://<api host>/api/v1/billing/paddle`,
   API version 1, the events `subscription.*` and `transaction.*`. Its secret key goes into
   `CGW_PADDLE_WEBHOOK_SECRET`. The webhook answers 200 within Paddle's five seconds once applied,
   401 to a body not signed with that secret.
4. **The checkout's page**: the pay page is on the sites' host, `https://<sites host>/_pay/en`
   (Checkout → Checkout settings → Default payment link; live needs the domain approved under
   Website approval). Each transaction names it as its checkout's address.

In the sandbox, steps 1, 3 and 4 can be made by Paddle's API instead, with a sandbox API key of every
permission in the session only: `$env:PADDLE_API_KEY = '…'; node scripts/paddle-sandbox.mjs --webhook
https://<api host>/api/v1/billing/paddle --pay-page https://<sites host>/_pay/en` makes the product,
two monthly prices (Starter and Team), the notification destination and the default payment link,
and prints the price ids and the destination's secret (once). It refuses a live key and writes
nothing to disk. The live test (Phase 18's) is then: an owner subscribes with Paddle's test card,
the plan and its allowance show in Settings → AI within a minute; the plan changed, then cancelled
in the portal; a payment failed by Paddle's declining test card.

Then `install.ps1 -BillingPlans … -PaddleClientToken … [-PaddleEnvironment sandbox]` with
`$env:CGW_PADDLE_API_KEY` and `$env:CGW_PADDLE_WEBHOOK_SECRET` set in the session (and removed
after). An update run without `-BillingPlans` turns billing off: the plans are not offered and the
webhook answers 404 (Paddle retries for days, so a short pause loses nothing; the daily reconcile
reads every subscription again). In Paddle, Retain → Payment recovery says whether a subscription
whose retries end is cancelled or paused: either ends its plan here. A workspace deleted for good
has its subscription cancelled at Paddle at once by its purge.

### A site's own host name (Phase 14)

A workspace's owners and admins add and prove host names in the app (Settings → Publishing); the
server makes their certificates once it is set up for it, which is whoever runs it's to do, once:

- **IIS**: `install.ps1 -CustomDomains` makes `<Root>\certificates`, where the worker writes one
  `<host>.pfx` a name under the certificates' private key password (`CGW_SITES_CERT_PASSWORD`, which
  the worker gets as `Sites__CertificatePassword` and the API never does), readable by
  administrators, SYSTEM and the worker alone. It copies `site-bindings.ps1` to `<Root>\scripts`
  (changeable by administrators only) and registers the scheduled task `\Cash Gear Workspace\Site
  bindings`, as SYSTEM every 2 minutes, which binds each name as the host's other sites are bound:
  the certificate imported into `LocalMachine\WebHosting` (not exportable, friendly name
  `cgw-site <host>`), an `https *:443:<host>` binding by SNI and an `http *:80:<host>` binding on the
  sites' site, the certificate swapped after a renewal; a name whose file is gone is unbound and its
  certificate removed. It never touches a name another site binds, a binding whose certificate it
  did not import, or another site. Its log is `<Root>\logs\site-bindings.log` (names and
  thumbprints). An update without `-CustomDomains` on a host whose folder holds certificates stops
  rather than turn them off.
- **Port 80 before a name's first certificate**: the name is not bound yet, so the directory's
  HTTP-01 request reaches the site holding the host's catch-all `http *:80:` (Default Web Site on
  the production host). `install.ps1` sends ACME's path there, and only that path, to the sites' own
  host (a `location` of `<that site>/.well-known/acme-challenge` with `httpRedirect` to
  `https://pages.cashgearerp.com$V`, 302; IIS's HTTP Redirection turned on if it is not), where the
  Sites process answers by the token. With no site holding the catch-all, the sites' site takes it.
  win-acme's in-memory validation, which the production host uses for its other sites' certificates,
  listens on HTTP.sys's `http://+:80/.well-known/acme-challenge/` while it runs, which comes before
  any IIS site: the two do not meet. To take the redirect off: `Remove-WebConfigurationLocation
  -Name 'Default Web Site/.well-known/acme-challenge'`.
- **The spike** (`deploy/iis/domains-spike.ps1`; decisions, 2026-11-22): the report alone changes
  nothing; `-Try` runs `site-bindings.ps1` on a scratch site and name, adds the redirect for a moment,
  checks every other name keeps its certificate, and removes all of it. Run it on a host before its
  first `-CustomDomains` install.
- **The directory**: `-AcmeStaging` first (Let's Encrypt's staging, whose certificates no browser
  trusts), then the production directory (the default). `-AgreeToAcmeTerms` says you have read its
  subscriber agreement; nothing is ordered without it. `-AcmeEmail` gives an optional contact for
  its expiry mails.
- **The switch from staging to production** (the release after 0.18.0): each name keeps the
  directory its live certificate came from (`SiteDomains.CertificateDirectory`), and a live
  certificate from a directory other than `Sites__Acme__Directory` is ordered anew at once, with
  two thirds of its life left or not. So `install.ps1` run again without `-AcmeStaging` replaces
  every staging certificate within a few of the worker's passes (five names a pass, a pass a
  minute); the task binds each new one within 2 minutes and removes the staging one. A name whose
  new order fails keeps its staging certificate, live, and is tried again after 1 hour, 6 hours,
  then daily. Any change of directory does the same, back to staging too, and each change orders
  every name again (Let's Encrypt limits the certificates of one registered domain a week): switch
  once. A certificate made by 0.18.0 or earlier has no directory kept and waits for its renewal
  (a third of its life left). To replace one sooner, set its row's renewal time to now on the host,
  as on 2026-11-26: `UPDATE SiteDomains SET CertificateRenewAt = SYSUTCDATETIME() WHERE Host =
  N'<name>'` (`sqlcmd -I`).
- **Network**: the host reaches the directory over https; the directory reaches the host on port 80
  for each name (the firewall open to the Internet on 80, as it is on 443), and the name's `CNAME`
  (or `A`/`AAAA`) leads to the host.
- **A wildcard record does not cover a proven name**: each name needs its own `CNAME` to the sites'
  host (or its own `A`/`AAAA`), even in a zone whose wildcard (`*.cashgearerp.com`) already leads to
  the host. The proof's `TXT` record at `_cashgear-workspace.<name>` makes `<name>` exist in DNS
  (with no records of its own), and a wildcard answers only for names that do not exist (RFC 4592),
  so the name resolves to no address at all. Without its `CNAME` the first order fails `notPointed`
  ("not pointed here") and is tried again after an hour; once the `CNAME` is added, take the name
  off its site and choose it again to order at once (found on 2026-11-26 with
  `docs.test.cashgearerp.com`).
- **What the app shows** for each name: waiting for its `TXT` record, proven, the page whose site it
  serves, and its certificate (none yet, being made, live until a date, or why not: not pointed
  here, the authority could not reach the site, asked to wait, could not be reached, DNS could not
  be read). The worker looks every minute (`Sites__Acme__IntervalSeconds`); a failed order is tried
  again after 1 hour, 6 hours, then daily, and renewal starts with a third of the lifetime left
  (at once for a certificate from another directory).

## Updating

Build the new package, then run `install.ps1` with the same parameters. The migrations run
first; the site and the worker stop for the copy (about a minute). Never copy a package's `api`
folder over by hand: that skips the migrations, the worker and the settings a version adds (on
2026-11-18 it left the API refusing to start for want of `Sites__PublicUrl` and
`Plugins__PublicUrl`, against a database still at 0.5.0's migrations). Clients keep working offline
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

Version 0.6.0's migration (`Phase6Collaboration`) adds `RealtimeTickets`, `CommentThreads`,
`Comments`, `Notifications` and the column `PageDocDerived.Mentions`, in a transaction like the
others. `install.ps1` turns on IIS's WebSocket Protocol feature first (a server feature: no
restart). The hub is `wss://workspace-api.cashgearerp.com/api/v1/realtime`, in the same site and
app pool; `Web__Origins` also decides which sites may open it, so it must keep the web app's
origin and the desktop's two (`install.ps1` sets all three). The app pool stays one process (no
web garden): the hub's connections live in that process, and a recycle only makes clients
reconnect and catch up. The worker's validation loop runs every 25 ms when idle (a small query
each time), and gains `ticketCleanup` (every 10 minutes). The web app's CSP gains the API's
`wss:` origin, from the same `VITE_CGW_API`.

Version 0.8.0's migration (`Phase8Mail`) adds `MailSettings` and `MailOutbox` and two columns
with their filtered indexes to `Notifications` (`EmailedAt`, `MailId`), in a transaction like the
others. The worker gains `notificationMail` (on the shared loop, every 30 s: a mail queued for each
person with mentions or replies unread past the delay) and `mailSend` (on a loop of its own, every
10 s: each queued mail made and sent, under the daily cap, retried after 1, 5 and 15 minutes, 1 and
4 hours, then given up). Notification mail goes out through the same `Smtp__*` account as the
account mails, from `Smtp__From`, and carries `List-Unsubscribe` with `List-Unsubscribe-Post`
(one click in the mail client turns it off, RFC 8058). The worker now reads the Data Protection key
ring in `DataProtectionKeys` as the API does (it writes the unsubscribe tokens the API reads): it
already has the database's rights, and with `DataProtection__Dpapi=true` the keys are encrypted
for the machine, which both identities on the host can read. The unsubscribe link,
`https://workspace-api.cashgearerp.com/mail/unsubscribe?token=…`, carries its token in the query
string, which the site's IIS log already leaves out (above).

Version 0.9.0's migration (`Phase9`) adds `PublishedSites` (with its filtered unique indexes on
the live slug and the live root) and two columns: `Workspaces.PublishingEnabled` (on for every
workspace already there) and `WorkbookTickets.Target` (`web` for every ticket already there), in
a transaction like the others. Before installing it, point `pages.cashgearerp.com` at the host
(First installation, step 6); `install.ps1` then makes the third IIS site and app pool,
`CashGearWorkspaceSites`, and sets the API's `Sites__PublicUrl`, without which the API refuses to
start in production. The Sites process answers `GET /{slug}`, `/{slug}/{pageId}`,
`/{slug}/files/{assetId}` (a 302 to a signed blob URL of a few minutes, checked on every request,
`Cache-Control: no-store`), `/robots.txt` and `/health/live`, and the bilingual 404 page for
anything else; every answer carries `Content-Security-Policy: default-src 'none'; style-src
'sha256-…'; img-src 'self' https://<account>.blob.core.windows.net; base-uri 'none'; form-action
'none'; frame-ancestors 'none'`, `nosniff`, `no-referrer`, COOP and CORP `same-origin`, a
`Permissions-Policy` that allows no powerful feature, HSTS on https, `X-Robots-Tag: noindex` unless the site's indexing is on, and
never `Set-Cookie`. It needs nothing new of Blob Storage (images load through the redirect, no
CORS). It keeps a slug's site at most 30 s, so an unpublish, the workspace's switch turned off or
the root moved out of reach holds within 30 s; pages it drew are kept in memory (at most 512, 64
MB) by a key of what they are drawn from, and every answer is `Cache-Control: no-cache` with a
strong `ETag`. Like the API, it is one process per app pool; a recycle only empties its memory.
The worker's purge of a page deleted for good unpublishes its site (`page.deleted`), freeing the
slug. The export the worker writes is format version 3: each workbook the requester may read
that has a version, as `workbooks/<name>.xlsx`.

Version 0.10.0's migration (`Phase10`) adds `PageEmbeddings` (clustered by workspace and page),
`EmbeddingChanges` and `WorkspacePlugins`, the embeddings' columns of `AiSettings` (off for every
workspace, `voyage-4` named) with a filtered index, and makes `AiUsage.UserId` nullable (the
worker's own calls), in a transaction like the others. Before installing it, point
`plugins.cashgearerp.com` at the host with its certificate (First installation, step 6);
`install.ps1 -PluginsHostName` then adds the sites' second binding and sets `Plugins__PublicUrl` for
the API (which refuses to start in production without it) and the Sites process. The worker gains
`embed` (a loop of its own, every 2 s: each workspace with embeddings on, pages unchanged for 30 s
embedded with the workspace's own Voyage key, at most 128 texts a call; a provider failure backs the
workspace off for 1, 5, then 30 minutes) and `embeddingsAndPluginsCleanup` (hourly: changes older
than a day, frame tickets a day after they expired, removed plugins' files a day after). The API keeps each searched workspace's vectors in
memory (`Ai__EmbeddingsCacheMb`), loaded on its first search by meaning (about a second for 100,000
chunks on the reference machine) and brought up to date on each search. Nothing is sent to Voyage
until an owner or admin turns embeddings on with the workspace's own key. The plugins host answers
only `GET`/`HEAD /f/{ticket}/{path}`: a plugin's file under a 10-minute ticket (32 random bytes the
API made for a member, kept only as their SHA-256 in `PluginFrameTickets`), with
`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src
https://plugins.cashgearerp.com; …; connect-src 'none'; …; frame-ancestors <the Web origins>`,
`nosniff`, `no-referrer`, `Cache-Control: private, max-age=600`, `Access-Control-Allow-Origin: *`
(a sandboxed frame's origin is null), never `Set-Cookie`; anything else on it, and `/f/` on the
pages host, is the 404 page. It keeps a ticket and a plugin's row at most 30 s (never past the
ticket's expiry; a plugin turned off or removed stops within 30 s) and files in memory by their hash
(at most 64 MB).

Version 0.13.0's migrations (`Phase13Plugins`, `Phase13Embeddings`, `Phase13Ai`) add a plugin's
approved hosts to `WorkspacePlugins` (none approved for a plugin already there: none named any),
`PageEmbeddings.SchemaVersion` (every row of a database with embeddings on is embedded again once,
now with its property values), the key sources of `AiSettings` (`own` for every workspace, as
before), `AiUsage.Subscription` and `AiReservations`, in a transaction like the others. Nothing is
offered on Cash Gear's subscription until its key and an allowance are set: in the session that
runs `install.ps1`, `$env:CGW_AI_ANTHROPIC_KEY` and `$env:CGW_AI_VOYAGE_KEY` (read as the SMTP
password is, and removed after), with `-AiMonthlyTokens` and `-AiEmbeddingsMonthlyTokens`; like the
SMTP password, an update run without them leaves the keys out. The local model is offered once its
package is placed: `node scripts/local-model.mjs` on a machine with Python 3 (it downloads the
pinned revision of the weights, about 700 MB, exports them and checks the graph against the model
card's own run) makes `target/deploy/cgw-local-model-voyage-4-nano-587d8d6.zip` (572 MB); copy it to
the host and pass `-LocalModel <zip>` once (an update without it keeps the folder). The API and the
worker each load it on first use (about 10 s with its files checked, and 1 GB) and unload it after 30 minutes unused; a
chunk takes about a second at 8 threads on the reference machine, a question about 50 ms. The
plugins host's CSP is now a bundle's own (`connect-src` its approved hosts, else `'none'`), and a
plugin's request leaves the visitor's browser from the plugins origin: the server never proxies it.

Version 0.14.0's migrations (`Phase14RowFiles`, `Phase14SiteDomains`, `Phase14PageCovers`) add the
index of rows' files (`DatabaseRowFiles`), a workspace's host names and the server's ACME account
(`SiteDomains`, `AcmeAccounts`) and an index of pages by their cover, in a transaction like the
others. After it starts, the worker fills the index of rows' files once for every row written before
(`rowFilesFill`, done when `JobStates` holds `rowFilesFill:done`; a few seconds for 100,000 rows),
and the hourly asset clean-up deletes nothing until then. Install it before 2026-12-14: until 0.14.0
a file in a row's file cell that no row's document had named was counted unreferenced, and the
first such files, from 0.5.0's install on 2026-11-14, would be deleted 30 days after. The Sites
process now also needs `Sites__PublicUrl`, which `install.ps1` gives it; without it every host name
is served as the sites' own, as before. A site's own host names stay off until `install.ps1
-CustomDomains` (above).

Version 0.19.0's migration (`Phase19PageLayout`) adds one column, `Pages.Layout` (`nvarchar(4000)`,
null), in a transaction like the others; nothing is filled. There is no new setting, job or process:
Word files, prints and PDFs are made on the device. The server only keeps a page's layout as a
device set it, and an older web app's edits keep it. Install the server before the web app: an older
API takes the change but not the layout (it reads no key it does not know), so the next record it
sends takes the layout off the device again.

Version 0.17.0's migrations (`Phase17Workflows`, `Phase17UniqueIds`, `Phase17Reminders`) add
`AutomationApprovals` and `RowReminders`, the columns of a waiting run (`AutomationRuns.Definition`,
`Place`, `WaitKind`, `WaitUntil`, `WaitedAt`, `TakenAt`, `Context`, with the filtered index
`IX_AutomationRuns_Waiting`), `Automations.WatchesRows`, `SeriesNext`, `SeriesDay` and
`SeriesRowId`, `Databases.NextNumber` and `Reminders`, `DatabaseRows.Number` (unique by database)
and `Notifications.ApprovalId`, `PropertyId` and `DateStart`, in a transaction like the others.
`Phase17UniqueIds` numbers every row already stored, in the order its page was made (by its id
when two were made at once), by one set-based statement before it adds the unique index. The worker gains `reminders` (a loop of its own, every second); waiting runs and
repeating rows are the `automations` job's, every second. Retention keeps a waiting run however
long ago it started, and deletes a reminder whose row is gone or whose person left. Install the
server before the web app: a web app of 0.17.0 offers waits, branches, approvals, repeating rows and
reminders only once the API's `/version` counts 7 step kinds, and a unique id only at 22 property
types; an older API refuses them.

Version 0.16.0's migration (`Phase16Forms`) adds `FormLinks` and the columns `Pages.FormId` (with the
filtered index `IX_Pages_Form`) and `AutomationEvents.FormId`, in a transaction like the others;
nothing is filled. A form link's pages are the Sites process's (`https://pages.cashgearerp.com/_form/…`)
and the last page's post goes on to the API's `POST /api/v1/forms/{token}` by a 307, so the Sites
process now also needs `Api__PublicUrl` (the API's origin, its pages' `form-action`), which
`install.ps1` gives it; without it a form link's last page cannot be sent. Install the server before
the web app: a web app of 0.16.0 offers a form view only once the API's `/version` counts it
(`viewTypes` 8), and an older API refuses one. A form link's answer is written by the API with no
session, from any address: the API's request log and the audit (`form.answer`, its address as the
entry's `Ip`) are where they are seen; the limits are `RateLimits__formMinute` and `__formDay` above.

Version 0.15.0's migration (`Phase15Automations`) adds `Automations`, `AutomationEvents`,
`AutomationRuns`, `Webhooks` and `WebhookDeliveries`, the columns `Workspaces.TimeZone` and
`AutomationsOff`, `Databases.EventRules` and `Notifications.AutomationId` and `Reason`, in a
transaction like the others; nothing is filled. The worker gains `automations` (a loop of its own,
every 100 ms: the rows' changes, the dates and schedules due), `webhooks` (every second) and
`automationRetention` (hourly: runs, deliveries, changes taken and deleted rules after 30 days). A
workspace made before it has no time zone until an owner or admin sets one in Settings → Automations,
or the first rule is saved there (the saver's browser's). Webhooks leave from the worker's host:
https on 443 to the addresses owners and admins name, each checked at connect against private,
loopback and link-local ranges (the egress rule is the receivers' hosts, if the host limits it).
A webhook's signing secret is kept under the key ring (`DataProtectionKeys`), so a lost key ring makes
every webhook's calls fail until an owner makes it again.

The Sites process holds no Data Protection (as in 0.9.0) and must never be able to read the key
ring: a process that serves the public must not be able to open a workspace's AI key's cipher (both
keys' ciphers are in `AiSettings`, which it can read). `install.ps1` gives a built-in sites identity
`db_datareader` and `DENY SELECT ON dbo.DataProtectionKeys` (a deny outweighs the role). A host that
runs all three under one service account (`-ServiceAccount`) cannot deny it without denying the API:
`install.ps1` warns; give the sites' app pool an account of its own, with `db_datareader` and the
same deny. The server's tests serve a site and a plugin as such a user
(`PluginTests.The_sites_process_serves_sites_and_plugins_as_a_reader_denied_the_key_rings_table`).

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
| Mail and errors | Event Viewer, Application log, sources "Cash Gear Workspace API" and "Cash Gear Workspace worker" | "A … mail was not sent": the SMTP account or its password (test from the host) |
| The worker's lag | `/health/ready` (`worker`); `JobStates` (`LastOkAt` per job) | Degraded: new edits wait to reach other devices (pulls still work). Restart the service; read its event log |
| Refused updates | Worker log ("Refused N of M updates"); `AuditLog` `doc.forgedClient` | A client sending updates as someone else: look at the device and user |
| Failed sign-ins and lockouts | `AuditLog` `signin.fail`, `signin.lockedOut` (Phase 11: a passkey's carry `method: "passkey"`; a sign-in is `account.signin` with its `method`) | Many from one IP: block it at the edge. Many `signin.fail` with `reason: "challenge used before"`: someone is sending copied passkey answers |
| Single sign-on | `AuditLog` `sso.domain.add`, `.verify`, `.require`, `.remove`, `sso.provider.set`, `.remove`, `.tested`, `sso.link`, `sso.account`; `signin.fail` with `method: "sso"` and its `refusal` (`Token`, `Outside`, `Unverified`, `Provider`, `Unavailable`, `Expired`); the API's log: "Single sign-on refused for workspace …", "the discovery of … failed" | `Unavailable` or discovery failures: the provider or the host's way out to it. `Token` (a signature, an issuer, an audience, an expiry): the provider's keys or clock, or someone forging answers. `Provider` with "the client secret could not be read": an owner enters the secret again (the key ring was lost). `Expired` with "state used before": someone replaying a callback |
| Rate limits | 429 answers with `limit.rate` in the logs | A client in a loop |
| Storage used | `Workspaces.StorageUsedBytes` (Q10: recorded, not enforced) | — |
| Retention | `JobStates` for `feedRetention` and `trashRetention` (every 10 minutes); `AuditLog` `page.purgedByRetention` | The change feed keeps 90 days and the trash 60 (DECISIONS.md, Phase 3); a device away longer than 90 days takes the whole tree when it returns (`410 feed.expired`) |
| Database results | `JobStates` for `recompute`; `Databases.ComputePending` rows waiting | Formula and rollup results of big databases lag while it is behind; filters on them use the last results |
| Notification mail | `JobStates` for `notificationMail` and `mailSend`; `MailOutbox` rows with `Outcome` null (waiting) and their `LastError`; the worker's event log: "A notification mail was not sent (attempt N of 6)" with the failure's type and SMTP status only, "The daily mail cap (N) is reached" | Failures: the SMTP account (as for account mail). The cap reached day after day: raise `Mail__DailyCap` if the account allows it, or ask people to choose the daily summary |
| Published sites | `https://pages.cashgearerp.com/health/live`; Event Viewer, source "Cash Gear Workspace sites"; `AuditLog` `site.publish`, `site.unpublish`, `workspace.publishing`; live sites: `PublishedSites` with `UnpublishedAt` null | A site that must go now: unpublish it in the app (or turn the workspace's publishing off); it is gone within 30 s. A page that should not be public: its share-link rules decide (restrict it, and it leaves every site within 30 s) |
| Search by meaning | `JobStates` for `embed`; the worker's event log: "Embedding a workspace's pages failed (<code>); trying again in N minutes"; `AiUsage` rows of `embed` and `search` with their outcomes; each workspace's progress in Settings, AI (pages and those embedded) | `ai.keyInvalid`: the workspace's Voyage key was refused (an owner or admin enters it again). `ai.limit` day after day: the key's own limit at Voyage. Turning embeddings off deletes the workspace's vectors at once |
| Plugins | `AuditLog` `plugin.add`, `plugin.update`, `plugin.enable`, `plugin.disable`, `plugin.remove`; live plugins: `WorkspacePlugins` with `RemovedAt` null; the plugins host answers only its 404 page at `https://plugins.cashgearerp.com/` | A plugin that must stop now: turn it off or remove it in Settings (owners and admins); its frames stop loading within 30 s and no new ticket is given |
| Automations | `JobStates` for `automations`, `webhooks` and `automationRetention`; `AutomationEvents` with `DoneAt` null (waiting); `AutomationRuns` by `Status` and `Reason` (`limit.rule`, `limit.workspace`: a rule or a workspace past 100 or 1,000 runs a minute; `depth`: rules starting each other; `author.access`); `WebhookDeliveries` with `Status` `failed` and their `LastStatus` and `LastError`; the worker's event log: "Automation event … failed", "Automation … on row … failed"; `AuditLog` `automations.switch`, `automations.timeZone`, `webhook.create`, `webhook.delete` | A rule that must stop now: switch it (or every rule) off in Settings → Automations (owners and admins); nothing more runs and no change is recorded for it. Many `limit.*` runs: a rule in a loop or a bulk change; the run log says what started each. Failed deliveries: the receiver's address or the host's way out to it on 443 |
| Workflows and reminders (Phase 17) | `AutomationRuns` with `Status` `waiting` by `WaitKind` and `WaitUntil` (one past due by minutes: the `automations` job is not running); `AutomationApprovals` with `Outcome` null; `Automations` with `TriggerKind` `recurring` by `SeriesNext` and `NextAt`; `RowReminders` with `DueAt` past and `SentFor` not `DueAt` (waiting to be sent); `JobStates` for `reminders`; the worker's event log: "Automation … series failed", "Reminders of workspace … failed" | A rule's waiting runs stop when it is switched off. A series by the last done waits for its last row to be done (its run log names the row). A reminder never sent to someone: they could no longer read the row, it was in the trash, or its moment was past when the date was set |
| Validation lag | `/health/ready` and `JobStates` (`validate`, on a loop of its own) | Edits reach other people within 5 s at p95 with 200 people typing (`bench/phase2.mjs`); longer means the worker or the database is short of something |

Signing a device out (the user's devices list, or `DELETE /api/v1/account/devices/{id}`) ends its
session and revokes its tokens at once. Workspace and account deletion are in the app; deleted
workspaces are purged after 30 days.
