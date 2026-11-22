// Types for server.mjs, for its unit test, the browser tests and the server's tests' helpers.

import type { JsonWebKey } from 'node:crypto';

export declare const DEFAULT_PORT: number;
export declare const TERMS: string;
export declare const LIFETIME_DAYS: number;

export type MockAcmeAlg = 'ES256' | 'RS256';
export declare const ALGS: readonly MockAcmeAlg[];

export type MockAcmeFault = 'challenge' | 'rateLimited' | 'badNonce' | 'server';
export declare const FAULTS: readonly MockAcmeFault[];

/** Each error type the mock answers (`urn:ietf:params:acme:error:<type>`) and its status. */
export type MockAcmeErrorType =
  | 'malformed'
  | 'unauthorized'
  | 'accountDoesNotExist'
  | 'badNonce'
  | 'badSignatureAlgorithm'
  | 'badPublicKey'
  | 'invalidContact'
  | 'rejectedIdentifier'
  | 'badCSR'
  | 'orderNotReady'
  | 'alreadyRevoked'
  | 'badRevocationReason'
  | 'rateLimited'
  | 'incorrectResponse'
  | 'connection'
  | 'serverInternal'
  | 'userActionRequired';
export declare const ERRORS: Readonly<Record<MockAcmeErrorType, number>>;

/** RFC 7638's thumbprint of a public JWK, base64url. */
export declare function thumbprint(jwk: JsonWebKey): string;

/** `token + '.' + thumbprint(jwk)`: what the challenge URL must serve. */
export declare function keyAuthorization(token: string, jwk: JsonWebKey): string;

// ACME's objects as the mock answers them (RFC 8555 7.1).

export interface AcmeProblem {
  readonly type: string;
  readonly detail: string;
  readonly status: number;
  readonly instance?: string;
  readonly algorithms?: readonly string[];
}

export interface AcmeDirectory {
  readonly newNonce: string;
  readonly newAccount: string;
  readonly newOrder: string;
  readonly revokeCert: string;
  readonly keyChange: string;
  readonly meta: { readonly termsOfService: string };
}

export interface AcmeAccount {
  readonly status: 'valid' | 'deactivated';
  readonly contact: readonly string[];
  readonly orders: string;
}

export type AcmeOrderStatus = 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';

export interface AcmeOrder {
  readonly status: AcmeOrderStatus;
  readonly expires: string;
  readonly identifiers: readonly { readonly type: 'dns'; readonly value: string }[];
  readonly authorizations: readonly string[];
  readonly finalize: string;
  readonly certificate?: string;
  readonly error?: AcmeProblem;
}

export interface AcmeChallenge {
  readonly type: 'http-01';
  readonly url: string;
  readonly token: string;
  readonly status: 'pending' | 'processing' | 'valid' | 'invalid';
  readonly validated?: string;
  readonly error?: AcmeProblem;
}

export interface AcmeAuthorization {
  readonly status: 'pending' | 'valid' | 'invalid';
  readonly identifier: { readonly type: 'dns'; readonly value: string };
  readonly expires: string;
  readonly challenges: readonly AcmeChallenge[];
}

/** One validation, as `GET /__mock/state` lists it. */
export interface MockAcmeAttempt {
  readonly at: string;
  readonly identifier: string;
  readonly token: string;
  /** The first URL asked, `http://<name>[:<port>]/.well-known/acme-challenge/<token>`. */
  readonly url: string;
  /** The `Host` header sent: the name, with `:<port>` unless the port is 80. */
  readonly host: string;
  /** The last HTTP status seen, or null when nothing answered. */
  readonly status: number | null;
  readonly redirects: number;
  readonly outcome: 'valid' | 'invalid';
  /** The full error type (`urn:ietf:params:acme:error:...`), or null. */
  readonly error: string | null;
  readonly detail: string | null;
}

export interface MockAcmeState {
  readonly directory: string;
  readonly challenge: { readonly port: number; readonly resolve: string };
  readonly lifetimeDays: number;
  readonly faults: Readonly<Partial<Record<MockAcmeFault, number>>>;
  readonly nonces: number;
  readonly accounts: readonly {
    readonly url: string;
    readonly status: string;
    readonly contact: readonly string[];
    readonly thumbprint: string;
    readonly orders: number;
    readonly createdAt: string;
  }[];
  readonly orders: readonly {
    readonly url: string;
    readonly account: string;
    readonly status: AcmeOrderStatus;
    readonly names: readonly string[];
    readonly authorizations: readonly {
      readonly url: string;
      readonly name: string;
      readonly status: string;
    }[];
    readonly certificate: string | null;
    readonly error: AcmeProblem | null;
  }[];
  readonly attempts: readonly MockAcmeAttempt[];
  readonly certificates: readonly {
    readonly url: string;
    readonly order: string;
    readonly names: readonly string[];
    /** Upper-case hex, 32 digits: as `X509Certificate.serialNumber` reads it. */
    readonly serial: string;
    readonly notBefore: string;
    readonly notAfter: string;
    readonly revoked: boolean;
  }[];
}

export declare class MockAcme {
  /** `http://<host>:<port>`. */
  readonly origin: string;
  /** Where challenges are fetched from. */
  readonly target: { port: number; resolve: string };
  reset(): void;
  state(): MockAcmeState;
}

export declare function startMockAcme(options?: {
  port?: number;
  host?: string;
  /** The port a challenge is fetched from (80 by default): the Sites process's in tests. */
  challengePort?: number;
  /** The address a challenge is fetched from, whatever the name (127.0.0.1 by default). */
  resolve?: string;
}): Promise<{ url: string; directory: string; mock: MockAcme; close(): Promise<void> }>;
