// Types for server.mjs, for its unit test, the browser tests and the benches.

export declare const DEFAULT_PORT: number;

export declare const LIFETIMES: {
  readonly codeMs: number;
  readonly idTokenS: number;
  readonly accessTokenS: number;
};

export type MockOidcAlg = 'RS256' | 'ES256';
export declare const ALGS: readonly MockOidcAlg[];

export type MockOidcFault =
  | 'wrongKey'
  | 'algNone'
  | 'wrongAudience'
  | 'wrongIssuer'
  | 'expired'
  | 'nonce'
  | 'emailUnverified'
  | 'noEmail'
  | 'tokenError'
  | 'discoveryDown';
export declare const FAULTS: readonly MockOidcFault[];

/** A seeded person: a button on the sign-in page. */
export interface MockOidcPerson {
  readonly id: 'ada' | 'omar' | 'zed' | 'owner';
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly lang: 'en' | 'ar';
}
export declare const PEOPLE: readonly MockOidcPerson[];

/** `POST /__mock/clients`. */
export interface MockOidcClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: readonly string[];
  /** How its ID tokens are signed; RS256 when absent. */
  readonly alg?: MockOidcAlg;
}
export declare const DEV_CLIENT: Required<MockOidcClient>;

/** `POST /__mock/next`: the next `GET /authorize` signs this person in (or refuses) at once. */
export type MockOidcNext =
  | {
      readonly email: string;
      /** Absent: the seeded person's, else `sub-<hashOf(lower-case email)>`. */
      readonly sub?: string;
      /** Absent: the seeded person's, else none; null: none. */
      readonly name?: string | null;
      /** Absent: true; null leaves `email_verified` out. */
      readonly emailVerified?: boolean | null;
    }
  | { readonly error: string };

/** One request to the provider (or the DNS stand-in), as `GET /__mock/requests` lists it. */
export interface MockOidcRequest {
  readonly id: string;
  readonly at: string;
  readonly endpoint: 'discovery' | 'authorize' | 'token' | 'jwks' | 'userinfo' | 'dns';
  readonly method: string;
  /** The headers' names, never their values. */
  readonly headers: readonly string[];
  /** Secrets (`client_secret`, `code`, `code_verifier`, `access_token`) as `sha256:<hashOf>`. */
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly form: Readonly<Record<string, string | string[]>> | null;
  readonly clientId: string | null;
  readonly auth: 'client_secret_post' | 'client_secret_basic' | null;
  /** `hashOf` the client secret presented. */
  readonly secretHash: string | null;
  /** `hashOf` the access token presented at /userinfo. */
  readonly tokenHash: string | null;
  readonly sub: string | null;
  readonly status: number | null;
  readonly error: string | null;
}

/** The first 16 hex digits of a value's SHA-256: how a record names a secret. */
export declare function hashOf(value: string): string;

export declare class MockOidc {
  /** `http://<host>:<port>`: the root realm's issuer. */
  readonly origin: string;
  reset(): void;
}

export declare function startMockOidc(options?: {
  port?: number;
  host?: string;
}): Promise<{ url: string; mock: MockOidc; close(): Promise<void> }>;
