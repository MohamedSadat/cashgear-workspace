// Types for der.mjs, for the mock's own test and anything else that builds requests with it.

import type { KeyObject } from 'node:crypto';

export declare class DerError extends Error {}

/** A PKCS #10 request as the mock reads it. */
export interface ParsedCsr {
  readonly commonName: string | null;
  readonly dnsNames: readonly string[];
  /** Names in the subjectAltName of any kind but dNSName (IP addresses, emails). */
  readonly otherNames: number;
  /** The SubjectPublicKeyInfo's bytes, as given: a certificate carries them verbatim. */
  readonly spki: Buffer;
  readonly publicKey: KeyObject | null;
  readonly signatureAlgorithm: string;
  /** RSA PKCS #1 v1.5 or ECDSA P-256, with SHA-256; anything else is false. */
  readonly signatureValid: boolean;
}

/** Throws `DerError` when the request cannot be read. */
export declare function parseCsr(der: Uint8Array): ParsedCsr;

/** A request, DER, signed by `privateKey` (RSA, or EC P-256), SHA-256. */
export declare function makeCsr(options: {
  privateKey: KeyObject | string | Buffer;
  commonName?: string | null;
  dnsNames?: readonly string[];
}): Buffer;

export interface MockCa {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** The CA's Name, DER. */
  readonly subject: Buffer;
  readonly keyId: Buffer;
  readonly der: Buffer;
  readonly pem: string;
}

export declare function makeCa(options?: { commonName?: string; days?: number }): MockCa;

export declare function issueCertificate(options: {
  ca: MockCa;
  spki: Uint8Array;
  names: readonly string[];
  commonName?: string | null;
  notBefore: Date;
  notAfter: Date;
}): { der: Buffer; pem: string; serial: string };

export declare function pem(der: Uint8Array, label?: string): string;
