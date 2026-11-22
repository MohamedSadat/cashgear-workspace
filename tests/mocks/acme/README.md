# The mock ACME server

A stand-in for Let's Encrypt (RFC 8555) for custom domains on published sites: the server's worker
gets its TLS certificates from it in tests, by the HTTP-01 challenge. Accounts, orders,
authorizations, challenges, finalize and the certificate chain, plus test controls under
`/__mock/*`. Plain Node (`node:http`, `node:crypto`), no dependencies; `der.mjs` reads the
requests and writes the certificates. Nothing in a test ever reaches a real CA.

```bash
node tests/mocks/acme/server.mjs [--port 4289] [--host 127.0.0.1] [--challenge-port 80] [--resolve 127.0.0.1]
```

The port also comes from `ACME_MOCK_PORT`. The base URL is `http://<host>:<port>`, the directory
`http://127.0.0.1:4289/directory` by default. It prints one line at start and nothing per request
(a parent process may never read its output). It ends on `SIGTERM` or `SIGINT` after closing its
connections. In process: `startMockAcme({ port: 0, challengePort })` resolves with
`{ url, directory, mock, close }` (`server.d.mts` has the types, and the ACME objects').

## Keys and the CA

The CA's key (EC P-256) and its self-signed certificate (CA:true, keyUsage keyCertSign and
cRLSign, valid from an hour before start for ten years) are made at start and kept in memory only,
never written anywhere. They are new on every start; a reset keeps them. `GET /__mock/ca` gives the
CA certificate, so a test can check a chain or trust it. Account keys are the clients' own; the mock
keeps their public halves.

## Routes

| Route                       | What                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /directory`            | `{newNonce, newAccount, newOrder, revokeCert, keyChange, meta: {termsOfService: "https://acme.test/terms"}}`                                                       |
| `HEAD`, `GET /new-nonce`    | 200 (HEAD) or 204 (GET) with `Replay-Nonce` and `Cache-Control: no-store`                                                                                          |
| `POST /new-account`         | Signed with `jwk`. 201 and `Location: <base>/acct/<id>`, `{status: "valid", contact, orders}`; the same key again: 200, the same `Location`                        |
| `POST /new-order`           | `{identifiers: [{type: "dns", value}]}`, 1 to 100 names: 201, `Location: <base>/order/<id>`, `{status: "pending", expires, identifiers, authorizations, finalize}` |
| `POST /authz/<id>`          | POST-as-GET: `{status, identifier, expires, challenges: [{type: "http-01", url, token, status}]}`                                                                  |
| `POST /chall/<id>`          | `{}`: the response is in place, the challenge goes `processing` and is checked a few ms later; POST-as-GET reads it. `Link: <authz>;rel="up"`                      |
| `POST /order/<id>`          | POST-as-GET: the order, with `Retry-After: 1` while `processing`                                                                                                   |
| `POST /order/<id>/finalize` | `{csr}`: the order goes `processing`, then `valid` with `certificate` a moment later; the answer is the order with `Retry-After: 1`                                |
| `POST /cert/<id>`           | POST-as-GET: `application/pem-certificate-chain`, the leaf then the CA, PEM with `\n` line ends                                                                    |
| `POST /acct/<id>`           | POST-as-GET reads the account; `{contact}` replaces its contacts; `{status: "deactivated"}` deactivates it                                                         |
| `POST /acct/<id>/orders`    | POST-as-GET: `{orders: [<order URL>...]}`                                                                                                                          |
| `POST /revoke-cert`         | `{certificate, reason?}` (DER, base64url), signed by the account holding it (`kid`): 200; again: `alreadyRevoked`                                                  |
| `POST /key-change`          | Refused (`malformed`): the mock does not change account keys                                                                                                       |

An object is shown only to the account that made it (else 403 `unauthorized`); an unknown id is 404
`malformed`. `GET` on anything but the directory and new-nonce is 405.

### Every POST

A flattened JWS JSON body (`protected`, `payload`, `signature`, no unprotected `header`) with
`Content-Type: application/jose+json` (else 415 `malformed`), checked in this order:

1. `nonce`: one the mock issued and nobody used (else 400 `badNonce`). It is spent by the request
   whatever the answer. Every answer to a POST, refusals included, carries a fresh `Replay-Nonce`.
2. `alg`: `ES256` or `RS256` (else 400 `badSignatureAlgorithm`, with `algorithms`).
3. `url`: exactly the mock's base and the path requested (else 403 `unauthorized`).
4. `jwk` for newAccount, `kid` (an account URL the mock knows) for everything else; never both
   (`malformed`). An unknown `kid` is 400 `accountDoesNotExist`. ES256 needs an EC P-256 key, RS256
   an RSA key of 2048 bits or more (`badPublicKey`); a private member in `jwk` is `malformed`.
5. The signature over `protected.payload`: ES256 as JOSE's `r || s` (64 bytes), RS256 PKCS #1 v1.5
   (else 400 `malformed`). A deactivated account is then 403 `unauthorized`.
6. The payload: `""` for a POST-as-GET, else a JSON object. A POST-as-GET resource sent `{}` is
   `malformed`.

### Accounts and orders

- newAccount without `termsOfServiceAgreed: true` is 403 `userActionRequired` with `instance` and a
  `Link: <https://acme.test/terms>;rel="terms-of-service"`; `onlyReturnExisting: true` for a key with
  no account is 400 `accountDoesNotExist`. `contact`: up to 10 `mailto:` addresses
  (`invalidContact`).
- newOrder lower-cases and dedupes the names. A wildcard, an IP address (`type: "ip"`, or a dotted
  quad as `dns`), a single label (`localhost`) or anything that is not a DNS name is 400
  `rejectedIdentifier`. `notBefore` and `notAfter` are refused (`malformed`), as Let's Encrypt does.
- Each name has an authorization of its own with one `http-01` challenge (token: 32 random bytes,
  base64url). Authorizations are never reused between orders. Orders and authorizations say they
  expire in 7 days and never do.

### The challenge

The mock connects to `--resolve` (127.0.0.1) at `--challenge-port` (80), whatever the name
resolves to, and asks `GET /.well-known/acme-challenge/<token>` with `Host: <name>:<port>`, or
`Host: <name>` when the port is 80. The tests pass the Sites process's port; `POST /__mock/challenge`
changes either while it runs.

- Valid when the answer is 200 and its body, trimmed, is the key authorization
  `<token>.<thumbprint>`, the thumbprint being RFC 7638's of the account key (SHA-256 over
  `{"crv","kty","x","y"}` or `{"e","kty","n"}`, base64url; exported as `thumbprint` and
  `keyAuthorization`). Then the challenge and the authorization are `valid`, and the order `ready`
  once all its authorizations are.
- Any other status, or another body: `incorrectResponse` (403). Refused, timed out (5 s) or broken:
  `connection` (400). Redirects (301, 302, 303, 307, 308) are followed 3 at most, and only to
  `http://` on the same host and port; anything else is `connection`. The body is read up to 8 KiB.
- A failure makes the challenge `invalid` with its `error`, the authorization `invalid`, and the
  order `invalid` with an `error` naming the name.
- Each attempt is recorded for `/__mock/state`: the name, token, URL, `Host`, the last status seen
  (null when nothing answered), redirects, outcome and error type.

### Finalize and the certificate

The order must be `ready` (else 403 `orderNotReady`). The CSR (DER, base64url) must read as PKCS
#10, its signature must hold (RSA PKCS #1 v1.5 or ECDSA P-256, SHA-256), an RSA key must have 2048
bits, its key must not be the account key, and its names (the SAN's dNSNames, else the CN) must be
the order's names exactly as a set, with a CN among them and no SAN of another kind; any of these
is 400 `badCSR`, and the order stays `ready`.

The leaf carries the CSR's SubjectPublicKeyInfo verbatim; a random positive 16-byte serial; the
subject CN (the CSR's, else the first name; none when longer than 64, the SAN then critical);
subjectAltName with every name; basicConstraints CA:false; keyUsage digitalSignature and
keyEncipherment for an RSA key, digitalSignature for an EC one; extKeyUsage serverAuth; the CA's
key id. Valid from one hour ago to `lifetimeDays` (90) from now, in whole seconds.

## Errors

`application/problem+json`, `{type: "urn:ietf:params:acme:error:<type>", detail, status}`:

| Type                                    | Status | When                                                                            |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `malformed`                             | 400    | A body, header, payload or signature that does not hold; 404, 405, 413, 415 too |
| `badNonce`                              | 400    | Unknown, used or missing nonce; the `badNonce` fault                            |
| `badSignatureAlgorithm`                 | 400    | `alg` other than ES256 or RS256                                                 |
| `badPublicKey`                          | 400    | A key that does not fit `alg`, or RSA under 2048 bits                           |
| `accountDoesNotExist`                   | 400    | An unknown `kid`; `onlyReturnExisting` for a new key                            |
| `unauthorized`                          | 403    | `url` mismatch; another account's object; a deactivated account                 |
| `userActionRequired`                    | 403    | newAccount without `termsOfServiceAgreed: true`                                 |
| `invalidContact`                        | 400    | `contact` other than up to 10 `mailto:` addresses                               |
| `rejectedIdentifier`                    | 400    | A wildcard, an IP address or not a DNS name                                     |
| `orderNotReady`                         | 403    | finalize on an order that is not `ready`                                        |
| `badCSR`                                | 400    | The CSR's names, signature or key                                               |
| `rateLimited`                           | 429    | The `rateLimited` fault, with `Retry-After: 3600`                               |
| `serverInternal`                        | 500    | The `server` fault                                                              |
| `alreadyRevoked`, `badRevocationReason` | 400    | revokeCert                                                                      |
| `incorrectResponse`                     | 403    | In a challenge's `error`: the wrong answer                                      |
| `connection`                            | 400    | In a challenge's `error`: no answer, or a redirect elsewhere                    |

## Faults

`POST /__mock/fault {kind, count?}`: the next `count` (1 by default) times, then gone. `{kind, count:
0}` clears one, `{kind: null}` all. Faults are global: tests sharing one running mock must not set
them side by side.

| `kind`        | What happens                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `challenge`   | The next validation fails as `incorrectResponse` ("Mock fault: challenge.") whatever is served |
| `rateLimited` | The next newOrder answers 429 `rateLimited` with `Retry-After: 3600`                           |
| `badNonce`    | The next POST is refused as `badNonce`, its nonce spent                                        |
| `server`      | The next POST answers 500 `serverInternal` before anything is read (its nonce is not spent)    |

## Controls

JSON in and out.

| Route                    | What                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__mock/state`      | `directory`, `challenge` (`port`, `resolve`), `lifetimeDays`, `faults`, the count of `nonces`; `accounts` (URL, status, contact, thumbprint, orders); `orders` (URL, account, status, names, authorizations, certificate, error); `attempts`; `certificates` (URL, order, names, serial as upper-case hex, notBefore, notAfter, revoked) |
| `POST /__mock/reset`     | Forgets everything but the CA and the challenge target: nonces, accounts, orders, attempts, certificates, faults, the lifetime. A client's next POST gets `badNonce` once                                                                                                                                                                |
| `POST /__mock/fault`     | `{kind, count?}` as above                                                                                                                                                                                                                                                                                                                |
| `POST /__mock/lifetime`  | `{days}` (above 0, at most 3650; fractions allowed) for certificates issued from now: 200 `{days}`                                                                                                                                                                                                                                       |
| `POST /__mock/challenge` | `{port?, resolve?}`: where challenges are fetched from from now: 200 `{port, resolve}`                                                                                                                                                                                                                                                   |
| `GET /__mock/ca`         | The CA certificate, PEM                                                                                                                                                                                                                                                                                                                  |

## Left out of RFC 8555

dns-01 and tls-alpn-01 (so no wildcards), key change, revocation signed by the certificate's own key,
authorization deactivation, pre-authorization (`newAuthz`), external account binding (ignored),
order and authorization expiry, authorization reuse, `Retry-After` enforcement (a client may poll
sooner), alternate chains (`Link: rel="alternate"`), the `subproblems` of a multi-name refusal,
and any rate limit but the fault.

## How tests use it

- **Its own test**: `npx vitest run tests/mocks/acme` (also in `pnpm test`): the whole flow as a
  client makes it, with a stand-in for the Sites process on a free port, the chain read with
  `X509Certificate`; each refusal, fault and control.
- **The server's tests**: started as the mock OpenID Connect provider is (`node
tests/mocks/acme/server.mjs --port <free> --challenge-port <the Sites process's port>`, then wait
  for `/__mock/state`), or the challenge target set later with `POST /__mock/challenge`. The worker's
  directory URL is `http://127.0.0.1:<port>/directory`; it trusts the CA from `GET /__mock/ca`. Use
  names under a domain of the test's own, and set faults only in tests that run alone.
