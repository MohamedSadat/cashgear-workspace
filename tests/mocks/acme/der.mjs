// A small DER (ASN.1) writer and reader for the mock ACME server (server.mjs beside it): enough to
// read a PKCS #10 certificate request, check its signature, and write X.509 v3 certificates signed
// by a CA made at start. Plain Node (`node:crypto`), no dependencies. Keys stay in memory only.
//
// Only what the mock needs: short and long definite lengths, low tag numbers, no BER. Anything
// else in a request throws `DerError`, which the mock answers as `badCSR`.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

/** A request or value the reader or writer refuses. */
export class DerError extends Error {}

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  t61String: 0x14,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
};

export const OID = {
  commonName: '2.5.4.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// Writing

function lengthOf(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One tag, its length and its content. */
export function tlv(tag, content) {
  const body = Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
}

/** A non-negative INTEGER from a number, a bigint, or unsigned big-endian bytes. */
export function integer(value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = Buffer.from(value);
  else {
    const n = BigInt(value);
    if (n < 0n) throw new DerError('Only non-negative integers are written.');
    const hex = n.toString(16);
    bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  bytes = bytes.length === 0 ? Buffer.from([0]) : bytes.subarray(start);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.integer, bytes);
}

export const boolean = (value) => tlv(TAG.boolean, [value ? 0xff : 0x00]);
export const nul = () => Buffer.from([TAG.null, 0x00]);
export const octetString = (bytes) => tlv(TAG.octetString, bytes);

/** A BIT STRING: `unused` is how many low bits of the last byte are not part of it. */
export function bitString(bytes, unused = 0) {
  return tlv(TAG.bitString, Buffer.concat([Buffer.from([unused]), Buffer.from(bytes)]));
}

export function oid(dotted) {
  const parts = String(dotted)
    .split('.')
    .map((part) => BigInt(part));
  if (parts.length < 2) throw new DerError(`${dotted}: an OID has two arcs at least.`);
  const out = [];
  for (const arc of [parts[0] * 40n + parts[1], ...parts.slice(2)]) {
    const group = [];
    let v = arc;
    do {
      group.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < group.length - 1; i += 1) group[i] |= 0x80;
    out.push(...group);
  }
  return tlv(TAG.oid, out);
}

export const utf8String = (text) => tlv(TAG.utf8String, Buffer.from(String(text), 'utf8'));

export function printableString(text) {
  if (!/^[A-Za-z0-9 '()+,./:=?-]*$/.test(text))
    throw new DerError(`${text}: not a PrintableString.`);
  return tlv(TAG.printableString, Buffer.from(text, 'ascii'));
}

export function ia5String(text) {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new DerError(`${text}: not printable ASCII.`);
  return tlv(TAG.ia5String, Buffer.from(text, 'ascii'));
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
const clock = (d) =>
  `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}` +
  `${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

export function utcTime(date) {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new DerError('UTCTime holds the years 1950 to 2049.');
  return tlv(TAG.utcTime, Buffer.from(`${pad(year % 100)}${clock(date)}`, 'ascii'));
}

export function generalizedTime(date) {
  return tlv(
    TAG.generalizedTime,
    Buffer.from(`${pad(date.getUTCFullYear(), 4)}${clock(date)}`, 'ascii'),
  );
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
export function time(date) {
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050 ? utcTime(date) : generalizedTime(date);
}

export const sequence = (...items) => tlv(TAG.sequence, Buffer.concat(items));

/** A SET OF: DER sorts its members by their encodings. */
export const set = (...items) => tlv(TAG.set, Buffer.concat([...items].sort(Buffer.compare)));

/** `[n]` EXPLICIT, or IMPLICIT over constructed content: a constructed context tag. */
export const explicit = (n, ...items) => tlv(0xa0 | n, Buffer.concat(items));

/** `[n]` IMPLICIT over primitive content. */
export const implicit = (n, bytes) => tlv(0x80 | n, bytes);

/** PEM with `\n` line ends and 64 characters a line. */
export function pem(der, label = 'CERTIFICATE') {
  const lines =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------------------------
// Reading

/** The TLV at `offset`: its tag, its content, the bytes it spans and where it ends. */
export function read(buf, offset = 0) {
  if (offset + 2 > buf.length) throw new DerError('Truncated: no tag and length.');
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError('High tag numbers are not read.');
  let length = buf[offset + 1];
  let pos = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0) throw new DerError('An indefinite length is not DER.');
    if (count > 4) throw new DerError('A length of more than 4 bytes.');
    if (pos + count > buf.length) throw new DerError('Truncated: the length.');
    if (buf[pos] === 0) throw new DerError('A length not in its shortest form.');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buf[pos + i];
    if (length < 0x80) throw new DerError('A length not in its shortest form.');
    pos += count;
  }
  const end = pos + length;
  if (end > buf.length) throw new DerError('Truncated: the content.');
  return {
    tag,
    constructed: (tag & 0x20) !== 0,
    content: buf.subarray(pos, end),
    raw: buf.subarray(offset, end),
    end,
  };
}

/** Every TLV in a constructed value's content, in order. */
export function children(content) {
  const out = [];
  for (let offset = 0; offset < content.length;) {
    const item = read(content, offset);
    out.push(item);
    offset = item.end;
  }
  return out;
}

/** A whole buffer as exactly one TLV, of `tag` when given. */
export function readOne(buf, tag, what = 'value') {
  const item = read(Buffer.from(buf), 0);
  if (item.end !== buf.length) throw new DerError(`${what}: bytes after its end.`);
  return expectTag(item, tag, what);
}

function expectTag(item, tag, what) {
  if (!item) throw new DerError(`${what}: missing.`);
  if (tag !== undefined && item.tag !== tag)
    throw new DerError(`${what}: tag 0x${item.tag.toString(16)}, not 0x${tag.toString(16)}.`);
  return item;
}

export function readOid(content) {
  if (content.length === 0 || content[content.length - 1] & 0x80)
    throw new DerError('An OID is truncated.');
  const arcs = [];
  let v = 0n;
  for (const byte of content) {
    v = (v << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(v);
      v = 0n;
    }
  }
  const first = arcs[0];
  const head = first < 80n ? [first / 40n, first % 40n] : [2n, first - 80n];
  return [...head, ...arcs.slice(1)].join('.');
}

/** The text of a UTF8String, PrintableString, IA5String or (as Latin-1) T61String. */
export function readString(item) {
  switch (item.tag) {
    case TAG.utf8String:
      return item.content.toString('utf8');
    case TAG.printableString:
    case TAG.ia5String:
      return item.content.toString('ascii');
    case TAG.t61String:
      return item.content.toString('latin1');
    default:
      throw new DerError(`A string of tag 0x${item.tag.toString(16)} is not read.`);
  }
}

/** A Name's attributes, as `{oid, value}` in order. */
function readName(item) {
  const out = [];
  for (const rdn of children(expectTag(item, TAG.sequence, 'Name').content))
    for (const pair of children(expectTag(rdn, TAG.set, 'RelativeDistinguishedName').content)) {
      const [type, value] = children(
        expectTag(pair, TAG.sequence, 'AttributeTypeAndValue').content,
      );
      out.push({
        oid: readOid(expectTag(type, TAG.oid, 'attribute type').content),
        value: expectTag(value, undefined, 'attribute value'),
      });
    }
  return out;
}

function readAlgorithm(item) {
  const [id, params, ...rest] = children(
    expectTag(item, TAG.sequence, 'AlgorithmIdentifier').content,
  );
  if (rest.length > 0) throw new DerError('AlgorithmIdentifier: too many members.');
  return { oid: readOid(expectTag(id, TAG.oid, 'algorithm').content), params: params ?? null };
}

function readExtension(item) {
  const parts = children(expectTag(item, TAG.sequence, 'Extension').content);
  const id = readOid(expectTag(parts[0], TAG.oid, 'extnID').content);
  const critical = parts.length === 3 && parts[1].tag === TAG.boolean && parts[1].content[0] !== 0;
  const value = expectTag(parts[parts.length - 1], TAG.octetString, 'extnValue').content;
  return { id, critical, value };
}

/** A subjectAltName's dNSNames, and how many names of other kinds it holds. */
function readAltNames(value) {
  const dnsNames = [];
  let others = 0;
  for (const name of children(readOne(value, TAG.sequence, 'GeneralNames').content)) {
    if (name.tag === 0x82) dnsNames.push(name.content.toString('ascii'));
    else others += 1;
  }
  return { dnsNames, others };
}

/** Whether `signature` over `data` verifies with the key in `spki` under `algorithm`. */
function signatureHolds(publicKey, algorithm, data, signature) {
  if (!publicKey) return false;
  try {
    if (algorithm === OID.sha256WithRsa && publicKey.asymmetricKeyType === 'rsa')
      return verify('sha256', data, publicKey, signature);
    if (
      algorithm === OID.ecdsaWithSha256 &&
      publicKey.asymmetricKeyType === 'ec' &&
      publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1'
    )
      return verify('sha256', data, { key: publicKey, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
  return false;
}

/**
 * A PKCS #10 request (RFC 2986), DER. Throws `DerError` when it cannot be read; a signature that
 * does not hold is `signatureValid: false`. `spki` is the SubjectPublicKeyInfo's bytes, as given.
 */
export function parseCsr(der) {
  const buf = Buffer.from(der);
  const top = readOne(buf, TAG.sequence, 'CertificationRequest');
  const [info, algorithm, signature, ...rest] = children(top.content);
  if (rest.length > 0) throw new DerError('CertificationRequest: too many members.');
  expectTag(info, TAG.sequence, 'CertificationRequestInfo');
  const signatureAlgorithm = readAlgorithm(algorithm).oid;
  expectTag(signature, TAG.bitString, 'signature');
  if (signature.content.length < 1 || signature.content[0] !== 0)
    throw new DerError('signature: a whole number of bytes.');

  const [version, subject, spki, attributes, ...more] = children(info.content);
  if (more.length > 0) throw new DerError('CertificationRequestInfo: too many members.');
  if (!expectTag(version, TAG.integer, 'version').content.equals(Buffer.from([0])))
    throw new DerError('version: only v1 (0).');
  expectTag(spki, TAG.sequence, 'SubjectPublicKeyInfo');
  if (attributes && attributes.tag !== 0xa0) throw new DerError('attributes: expected [0].');

  const cn = readName(subject).find((a) => a.oid === OID.commonName);
  const commonName = cn ? readString(cn.value) : null;
  const dnsNames = [];
  let otherNames = 0;
  for (const attribute of attributes ? children(attributes.content) : []) {
    const [type, values] = children(expectTag(attribute, TAG.sequence, 'Attribute').content);
    if (readOid(expectTag(type, TAG.oid, 'attribute type').content) !== OID.extensionRequest)
      continue;
    for (const extensions of children(expectTag(values, TAG.set, 'attribute values').content))
      for (const item of children(expectTag(extensions, TAG.sequence, 'Extensions').content)) {
        const extension = readExtension(item);
        if (extension.id !== OID.subjectAltName) continue;
        const names = readAltNames(extension.value);
        dnsNames.push(...names.dnsNames);
        otherNames += names.others;
      }
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: spki.raw, format: 'der', type: 'spki' });
  } catch {
    publicKey = null;
  }
  return {
    commonName,
    dnsNames,
    otherNames,
    spki: Buffer.from(spki.raw),
    publicKey,
    signatureAlgorithm,
    signatureValid: signatureHolds(
      publicKey,
      signatureAlgorithm,
      info.raw,
      signature.content.subarray(1),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Certificates

/** A Name of one common name (UTF8String), or the empty Name for null. */
export function name(commonName) {
  return commonName === null || commonName === undefined
    ? sequence()
    : sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

/** The signature algorithm a key signs with: ECDSA or RSA PKCS #1 v1.5, SHA-256 either way. */
function algorithmFor(key) {
  return key.asymmetricKeyType === 'ec'
    ? sequence(oid(OID.ecdsaWithSha256))
    : sequence(oid(OID.sha256WithRsa), nul());
}

export function extension(id, critical, value) {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

const dnsName = (value) => implicit(2, Buffer.from(value, 'ascii'));

/** RFC 5280 4.2.1.2's first method: SHA-1 of the subjectPublicKey's bits. */
export function keyIdOf(spki) {
  const [, bits] = children(readOne(spki, TAG.sequence, 'SubjectPublicKeyInfo').content);
  return createHash('sha1')
    .update(expectTag(bits, TAG.bitString, 'subjectPublicKey').content.subarray(1))
    .digest();
}

/** 16 random bytes, positive (top bit clear) and with a first byte that is not zero. */
export function serialNumber() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01;
  return bytes;
}

/** An X.509 v3 certificate, DER, signed by `issuerKey` (a private KeyObject). */
export function makeCertificate({
  serial,
  issuer,
  issuerKey,
  subject,
  spki,
  notBefore,
  notAfter,
  extensions,
}) {
  const algorithm = algorithmFor(issuerKey);
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    issuer,
    sequence(time(notBefore), time(notAfter)),
    subject,
    Buffer.from(spki),
    explicit(3, sequence(...extensions)),
  );
  // ECDSA's signature comes out DER (r, s), as X.509 holds it.
  return sequence(tbs, algorithm, bitString(sign('sha256', tbs, issuerKey)));
}

const wholeSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000);

/**
 * The mock's CA: a P-256 key made now, in memory only, and its self-signed certificate (CA:true,
 * keyCertSign and cRLSign), valid from an hour ago for `days`.
 */
export function makeCa({ commonName = 'Cash Gear Workspace mock ACME CA', days = 3650 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = name(commonName);
  const keyId = keyIdOf(spki);
  const now = Date.now();
  const der = makeCertificate({
    serial: serialNumber(),
    issuer: subject,
    issuerKey: privateKey,
    subject,
    spki,
    notBefore: wholeSeconds(now - HOUR),
    notAfter: wholeSeconds(now + days * DAY),
    extensions: [
      extension(OID.basicConstraints, true, sequence(boolean(true))),
      // keyCertSign (bit 5) and cRLSign (bit 6): 0x06, the last bit unused.
      extension(OID.keyUsage, true, bitString([0x06], 1)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
    ],
  });
  return { privateKey, publicKey, subject, keyId, der, pem: pem(der) };
}

/**
 * A server certificate for `names` from `ca`, over the request's own SubjectPublicKeyInfo. The
 * subject is `commonName` when it fits (64 characters), else empty with the SAN critical.
 * keyUsage is digitalSignature and keyEncipherment for an RSA key, digitalSignature for an EC one.
 */
export function issueCertificate({ ca, spki, names, commonName, notBefore, notAfter }) {
  const serial = serialNumber();
  const cn = typeof commonName === 'string' && commonName.length <= 64 ? commonName : null;
  const rsa =
    createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }).asymmetricKeyType ===
    'rsa';
  const der = makeCertificate({
    serial,
    issuer: ca.subject,
    issuerKey: ca.privateKey,
    subject: name(cn),
    spki,
    notBefore,
    notAfter,
    extensions: [
      extension(OID.subjectAltName, cn === null, sequence(...names.map(dnsName))),
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature (bit 0) and keyEncipherment (bit 2): 0xa0, 5 bits unused; or 0x80, 7.
      extension(OID.keyUsage, true, rsa ? bitString([0xa0], 5) : bitString([0x80], 7)),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(OID.authorityKeyIdentifier, false, sequence(implicit(0, ca.keyId))),
    ],
  });
  return { der, pem: pem(der), serial: serial.toString('hex').toUpperCase() };
}

/**
 * A PKCS #10 request, DER: `commonName` (or an empty subject) and `dnsNames` in an
 * extensionRequest's subjectAltName, signed by `privateKey` (RSA or EC P-256, SHA-256).
 */
export function makeCsr({ privateKey, commonName = null, dnsNames = [] }) {
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const attributes =
    dnsNames.length > 0
      ? [
          sequence(
            oid(OID.extensionRequest),
            set(sequence(extension(OID.subjectAltName, false, sequence(...dnsNames.map(dnsName))))),
          ),
        ]
      : [];
  const info = sequence(integer(0), name(commonName), spki, explicit(0, ...attributes));
  return sequence(info, algorithmFor(key), bitString(sign('sha256', info, key)));
}
