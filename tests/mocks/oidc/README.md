# The mock OpenID Connect provider

A stand-in for a workspace's own identity provider (Phase 11, single sign-on): discovery, the
authorisation code flow with PKCE, the token endpoint, the keys and userinfo, plus test controls
under `/__mock/*` and the DNS stand-in the server reads to prove a domain. Plain Node
(`node:http`, `node:crypto`), no dependencies. The server's tests, the browser tests and the dev
stack use it; nothing in a test ever reaches a real provider.

```bash
node tests/mocks/oidc/server.mjs [--port 4287] [--host 127.0.0.1]
```

The port also comes from `OIDC_MOCK_PORT` (or `CGW_MOCK_OIDC_PORT`). The issuer is
`http://<host>:<port>`, so `http://127.0.0.1:4287` by default. It prints one line at start and
nothing per request (the server's tests do not read its output). It ends on `SIGTERM` or
`SIGINT` after closing its connections. In process: `startMockOidc({ port: 0 })` resolves with
`{ url, mock, close }` (`server.d.mts` has the types).

## Keys

Made at start, in memory only, never exported in private form or written to any file:

| `kid`   | Key                                   | Signs                                                        | Published at `/jwks` |
| ------- | ------------------------------------- | ------------------------------------------------------------ | -------------------- |
| `rsa-1` | RSA 2048                              | RS256 (PKCS #1 v1.5, SHA-256)                                | yes                  |
| `ec-1`  | EC P-256                              | ES256, the signature in JOSE's form (`r` then `s`, 64 bytes) | yes                  |
| none    | a rogue RSA key and a rogue P-256 key | the `wrongKey` fault, under the published `kid`              | never                |

A client's ID tokens are signed with the algorithm it was registered with (`alg`, RS256 by
default). The keys are new on every start; a reset keeps them.

## Routes

| Route                                   | What                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration` | Discovery: `issuer`, the endpoints, `jwks_uri`, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]`, `id_token_signing_alg_values_supported: ["RS256", "ES256"]` |
| `GET /authorize`                        | The sign-in page, or straight back to the client when `/__mock/next` has queued someone                                                                                                                                                                                                 |
| `POST /authorize`                       | The page's form: the original query again, and the person chosen (`person`) or `cancel`                                                                                                                                                                                                 |
| `POST /token`                           | The code for tokens: `{access_token, token_type: "Bearer", expires_in: 3600, scope, id_token}`                                                                                                                                                                                          |
| `GET /jwks`                             | `{keys: [rsa-1, ec-1]}`, public parts only                                                                                                                                                                                                                                              |
| `GET`, `POST /userinfo`                 | The person's claims for a `Bearer` access token (or `access_token` in a form)                                                                                                                                                                                                           |
| `GET /favicon.ico`                      | 204, so a browser logs no 404 on the page                                                                                                                                                                                                                                               |

Every route is also served under `/realms/<name>` (`name`: 1 to 64 of `A-Z a-z 0-9 _ -`): a
provider of its own with the issuer `http://127.0.0.1:4287/realms/<name>`, its own clients,
people queued, fault, clock, codes, tokens and requests, made on first use. Tests that share one
running mock (the server's tests run side by side) each take a realm, usually a fresh GUID, and
never meet each other's state. The keys and the DNS records are shared by all.

### `/authorize`

- A client or redirect address the mock does not know gets a 400 page and is never redirected to.
  `redirect_uri` must equal one registered for the client, exactly.
- Every other mistake goes back to `redirect_uri` as an OAuth error (`error`, `error_description`,
  `state`, `iss`): `response_type` other than `code` (`unsupported_response_type`);
  `response_mode` other than `query`, `code_challenge_method` other than `S256`, a
  `code_challenge` that is not 43 base64url characters, or a parameter given twice
  (`invalid_request`); a `scope` without `openid` (`invalid_scope`). Cancel on the page answers
  `access_denied`.
- The page lists the seeded people as buttons in one form that posts the original query back. It
  is plain HTML (no script), with a CSP of `default-src 'none'` and the style by hash; English, or
  Arabic with `dir="rtl"` when `ui_locales` asks for `ar` first; each name in a `<bdi>` with its own
  `lang` and `dir`, each email in `<bdi dir="ltr">`. `login_hint` is shown on the page and chooses
  nobody: only `/__mock/next` skips the page.
- Success redirects with `code`, `state` and `iss`. A code lasts 60 s on the realm's clock, is used
  once, and is bound to the client, the redirect address, the PKCE challenge, the nonce, the scopes
  and the person.

### `/token`

`application/x-www-form-urlencoded` only, `grant_type=authorization_code`. The client authenticates
by `client_secret_post` (`client_id` and `client_secret` in the form) or `client_secret_basic`
(RFC 6749 §2.3.1: the id and the secret each form-urlencoded, then joined by `:` and base64'd, so a
secret holding `+` or `%` sent unencoded does not match); never both (400 `invalid_request`), never
neither (401 `invalid_client`). A wrong secret or unknown client: 401 `invalid_client` (with
`WWW-Authenticate: Basic` when basic was used). Then the code: unknown or used, another client's,
past its 60 s, a different `redirect_uri`, or a `code_verifier` whose S256 is not the challenge: 400
`invalid_grant`. Any exchange by an authenticated client that names a code spends it, whether it
succeeds or not.

### The ID token

Header `{alg, typ: "JWT", kid}`. Claims: `iss` (the realm's issuer), `sub`, `aud` (the client id),
`exp` (`iat` + 300 s), `iat`, `auth_time`, `nonce` (when the request sent one), `at_hash` (the left
half of the access token's SHA-256), then the person's: `email` and `email_verified` with the
`email` scope, `name` with `profile` when the person has one. `/userinfo` answers the same person's
claims (`sub`, `email`, `email_verified`, `name`), faults included.

## Faults

`POST /__mock/fault {kind}`. One fault at a time per realm: setting one replaces the last. **A fault
stays until it is replaced, cleared with `{kind: null}`, or reset**; it is not used up by a sign-in.

| `kind`            | What happens                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `wrongKey`        | The ID token is signed by the rogue key of its algorithm, under the published `kid` (`rsa-1` or `ec-1`)        |
| `algNone`         | The ID token's header is `{alg: "none", typ: "JWT"}` (no `kid`) and its signature is empty (`header.payload.`) |
| `wrongAudience`   | `aud` is `<clientId>-other`                                                                                    |
| `wrongIssuer`     | `iss` is `<issuer>/wrong`                                                                                      |
| `expired`         | `iat` 15 minutes ago, `exp` 10 minutes ago: past any clock skew                                                |
| `nonce`           | `nonce` is `<the request's nonce>-other` (a random one when none was sent)                                     |
| `emailUnverified` | `email_verified` is `false`                                                                                    |
| `noEmail`         | No `email` and no `email_verified`, in the ID token and at `/userinfo`                                         |
| `tokenError`      | `/token` answers 400 `{error: "invalid_grant"}` to every exchange                                              |
| `discoveryDown`   | Discovery answers 503 `{error: "temporarily_unavailable"}`; `/jwks` still answers                              |

Every other fault leaves the signature good, so a test proves the server refuses for that reason
alone.

## The seeded people

| `person` | `sub`       | Email             | Name         |
| -------- | ----------- | ----------------- | ------------ |
| `ada`    | `sub-ada`   | `ada@acme.test`   | Ada Lovelace |
| `omar`   | `sub-omar`  | `omar@acme.test`  | عمر          |
| `zed`    | `sub-zed`   | `zed@other.test`  | Zed          |
| `owner`  | `sub-owner` | `owner@acme.test` | Acme Owner   |

All with `email_verified: true`. `/__mock/next` signs in anyone else.

## Controls

On the root or under a realm (`/realms/<name>/__mock/...`), JSON in and out.

| Route                   | What                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__mock/clients`  | Registers `{clientId, clientSecret, redirectUris, alg?}` (`alg` RS256 or ES256), replacing one of that id: 201 `{clientId, redirectUris, alg}`. The secret is kept only as its SHA-256 and never shown                                                                                                                                                                                                                       |
| `GET /__mock/clients`   | `{clients: [{clientId, redirectUris, alg}]}`                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /__mock/next`     | Queues `{email, sub?, name?, emailVerified?}` (or `{error}`, such as `access_denied`): each `GET /authorize` takes one and redirects at once. Absent `sub`: the seeded person's, else `sub-<hashOf(lower-case email)>`, so an email signs in as the same `sub` each time. Absent `name`: the seeded person's, else none. `emailVerified`: true when absent, `null` leaves the claim out. The email is kept in the case given |
| `POST /__mock/fault`    | `{kind}` as above, or `{kind: null}`                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /__mock/clock`    | `{advanceMs}` moves the realm's clock (codes' and tokens' lifetimes, `iat` and `exp`): 200 `{offsetMs}`                                                                                                                                                                                                                                                                                                                      |
| `GET /__mock/requests`  | `{requests}`: what the provider routes were sent, latest 500, filtered by `?endpoint=` and `?clientId=`. Headers by name only; `client_secret`, `code`, `code_verifier` and `access_token` as `sha256:<hashOf>`; `auth`, `secretHash`, `tokenHash`, `sub`, `status`, `error`                                                                                                                                                 |
| `GET /__mock/state`     | The realm's issuer, client ids, people queued, fault, clock offset, counts (the root adds `realms` and `dns`)                                                                                                                                                                                                                                                                                                                |
| `POST /__mock/reset`    | On the root: everything (every realm, every DNS record, the root back to its one client). Under a realm: that realm only                                                                                                                                                                                                                                                                                                     |
| `GET /__mock/dns?name=` | `{txt: string[]}` for the name (any case, a final dot ignored); `[]` when none. Recorded in the realm's requests as `endpoint: "dns"`                                                                                                                                                                                                                                                                                        |
| `POST /__mock/dns`      | `{name, txt}` sets the name's TXT strings (a string or a list); `txt: null` or `[]` removes them. Shared by every realm                                                                                                                                                                                                                                                                                                      |

`hashOf` (exported) is the first 16 hex digits of the value's SHA-256, as the mock AI provider's
`keyId`.

The root has one client from the start and after a reset, for the dev and e2e stacks' API on 5280:
`cgw-workspace-dev`, secret `mock-oidc-secret` (a fixed value of a mock, not a credential),
redirect addresses `http://127.0.0.1:5280/account/sso/callback` and
`http://localhost:5280/account/sso/callback`.

## How tests use it

- **Its own test**: `npx vitest run tests/mocks/oidc` (also in `pnpm test`). Discovery, then
  `next`, `/authorize` and `/token` with PKCE, the ID token's signature checked with `node:crypto`
  against `/jwks` (RS256, and ES256 as 64 bytes), the page, the codes' rules, client
  authentication, the DNS stand-in, and each fault.
- **The server's tests**: started as the mock AI provider is (`ServerFixture`: `node
tests/mocks/oidc/server.mjs --port <free> --host 127.0.0.1`, then wait for the port). Each test
  takes a realm (`{mock}/realms/{Guid:N}`), registers its client there, queues the person with
  `next`, and sets a fault there; the issuer it configures is the realm's. Point the server's DNS
  at the root (`Sso:DnsBaseUrl` = the mock's address; the server asks `/__mock/dns?name=`) and use a
  domain of the test's own, so tests side by side do not share one. `Microsoft.IdentityModel`'s
  `HttpDocumentRetriever` refuses `http` unless `RequireHttps = false`: the server must allow it
  outside Production for the mock.
- **The browser tests**: Playwright starts it (`http://127.0.0.1:4287/__mock/state` as its ready
  address); a spec registers its client (or uses `cgw-workspace-dev` on the root), queues the person
  with `next` and lets the browser follow the redirects, or clicks a person on the page.
- **By hand**: with `pnpm dev:server`, set up the provider in Settings with the issuer
  `http://127.0.0.1:4287`, the client `cgw-workspace-dev` and its secret; prove the domain by
  `POST /__mock/dns`, and sign in by clicking a person.
