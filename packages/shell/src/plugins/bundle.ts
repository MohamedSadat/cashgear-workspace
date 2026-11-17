// A plugin's bundle read on the device before it is sent (Phase 10, M10.5): Settings shows its
// manifest (name, type, version, what it reads) first, and refuses on the spot what the server
// would refuse, by the server's rules and codes (server/src/Cgw.Core/Plugins/PluginBundle.cs): a
// zip of at most 5 MB, at most 200 files, each at most 5 MB unpacked and 20 MB in all, none
// declaring over 100 times its packed size, names the bundle may hold, files of the listed types,
// a manifest at the root (at most 16 KB) and its entry page. The archive is a stranger's: its
// central directory is read by our own bounds-checked code, nothing but the manifest is unpacked,
// and that in slices, never past what it declares. The server reads it all again and decides.
import { Inflate } from 'fflate';
import {
  bundleTypeOf,
  isBundlePath,
  parseManifest,
  type BundleError,
  type PluginManifest,
} from '@cgw/plugins/frame';

export const BUNDLE_LIMITS = Object.freeze({
  zipBytes: 5 * 1024 * 1024,
  files: 200,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  ratio: 100,
  manifestBytes: 16 * 1024,
});

const MANIFEST = 'manifest.json';

export interface BundleSummary {
  manifest: PluginManifest;
  /** Files in the bundle (folders not counted), and their bytes unpacked, as declared. */
  files: number;
  unpackedBytes: number;
  zipBytes: number;
}

export type BundleRead =
  { ok: true; summary: BundleSummary } | { ok: false; errors: BundleError[] };

const refused = (...errors: BundleError[]): BundleRead => ({ ok: false, errors });

interface Entry {
  name: string;
  method: number;
  encrypted: boolean;
  size: number;
  originalSize: number;
  offset: number;
}

class Damaged extends Error {}
class TooMany extends Error {}

const u16 = (d: Uint8Array, at: number) => d[at]! | (d[at + 1]! << 8);
const u32 = (d: Uint8Array, at: number) =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;
const u64 = (d: Uint8Array, at: number) => u32(d, at) + u32(d, at + 4) * 0x100000000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const CENTRAL_ENTRY = 46;

/** The central directory: refused as damaged when it does not fit, too many before one is read. */
function readCentral(d: Uint8Array): Entry[] {
  const floor = Math.max(0, d.length - 22 - 0xffff);
  let end = d.length - 22;
  while (end >= floor && u32(d, end) !== 0x06054b50) end--;
  if (end < floor) throw new Damaged();
  let count = u16(d, end + 10);
  let at = u32(d, end + 16);
  if (end >= 20 && u32(d, end - 20) === 0x07064b50) {
    const record = u64(d, end - 12);
    if (record + 56 <= end && u32(d, record) === 0x06064b50) {
      count = u64(d, record + 32);
      at = u64(d, record + 48);
    }
  }
  if (at > d.length || count > (d.length - at) / CENTRAL_ENTRY) throw new Damaged();
  // Folders do not count toward the files, so the bound here is loose: twice the files allowed.
  if (count > BUNDLE_LIMITS.files * 2) throw new TooMany();
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_ENTRY > d.length || u32(d, at) !== 0x02014b50) throw new Damaged();
    const flags = u16(d, at + 8);
    const nameLength = u16(d, at + 28);
    const extraLength = u16(d, at + 30);
    const commentLength = u16(d, at + 32);
    const nameStart = at + CENTRAL_ENTRY;
    const extraEnd = nameStart + nameLength + extraLength;
    if (extraEnd + commentLength > d.length) throw new Damaged();
    let size = u32(d, at + 20);
    let originalSize = u32(d, at + 24);
    let offset = u32(d, at + 42);
    if (size === 0xffffffff || originalSize === 0xffffffff || offset === 0xffffffff) {
      for (let x = nameStart + nameLength; x + 4 <= extraEnd; x += 4 + u16(d, x + 2)) {
        if (u16(d, x) !== 1) continue;
        let field = x + 4;
        const next = () => {
          if (field + 8 > extraEnd) throw new Damaged();
          const value = u64(d, field);
          field += 8;
          return value;
        };
        if (originalSize === 0xffffffff) originalSize = next();
        if (size === 0xffffffff) size = next();
        if (offset === 0xffffffff) offset = next();
        break;
      }
    }
    const raw = d.subarray(nameStart, nameStart + nameLength);
    let name: string;
    if (flags & 0x800 || raw.every((b) => b < 0x80)) {
      try {
        name = flags & 0x800 ? utf8.decode(raw) : latin1(raw);
      } catch {
        throw new Damaged();
      }
    } else {
      // No UTF-8 flag: UTF-8 when the bytes are, else Latin-1 (an old code page), as the server's
      // reader takes a name too.
      try {
        name = utf8.decode(raw);
      } catch {
        name = latin1(raw);
      }
    }
    entries.push({
      name,
      method: u16(d, at + 10),
      encrypted: (flags & 1) !== 0,
      size,
      originalSize,
      offset,
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated in slices and refused once past what it declared. */
function extract(d: Uint8Array, entry: Entry): Uint8Array {
  const local = entry.offset;
  if (local + 30 > d.length || u32(d, local) !== 0x04034b50) throw new Damaged();
  const start = local + 30 + u16(d, local + 26) + u16(d, local + 28);
  if (start + entry.size > d.length) throw new Damaged();
  const data = d.subarray(start, start + entry.size);
  if (entry.method === 0) {
    if (entry.size !== entry.originalSize) throw new Damaged();
    return data.slice();
  }
  if (entry.method !== 8) throw new Damaged();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const inflater = new Inflate((chunk) => {
      total += chunk.length;
      if (total > entry.originalSize) throw new Damaged();
      chunks.push(chunk);
    });
    for (let at = 0; at < data.length; at += 16 * 1024) {
      inflater.push(
        data.subarray(at, Math.min(at + 16 * 1024, data.length)),
        at + 16 * 1024 >= data.length,
      );
    }
  } catch {
    throw new Damaged();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const shown = (name: string) => name.slice(0, 200);

/** The bundle checked as the server checks it, with its manifest when it passes. */
export function readBundle(bytes: Uint8Array): BundleRead {
  if (bytes.length > BUNDLE_LIMITS.zipBytes) return refused({ code: 'bundle.tooLarge' });
  let entries: Entry[];
  try {
    entries = readCentral(bytes);
  } catch (error) {
    return error instanceof TooMany
      ? refused({ code: 'bundle.tooLarge' })
      : refused({ code: 'bundle.zip' });
  }
  // Folders are not files.
  const files = entries.filter((e) => !(e.name.endsWith('/') && e.originalSize === 0));
  if (files.length > BUNDLE_LIMITS.files) return refused({ code: 'bundle.tooLarge' });
  let declared = 0;
  for (const entry of files) {
    if (entry.encrypted || (entry.method !== 0 && entry.method !== 8))
      return refused({ code: 'bundle.zip', path: shown(entry.name) });
    if (entry.originalSize > BUNDLE_LIMITS.fileBytes)
      return refused({ code: 'bundle.tooLarge', path: shown(entry.name) });
    if (
      entry.originalSize > 0 &&
      (entry.size <= 0 || entry.originalSize > entry.size * BUNDLE_LIMITS.ratio)
    )
      return refused({ code: 'bundle.tooLarge', path: shown(entry.name) });
    declared += entry.originalSize;
  }
  if (declared > BUNDLE_LIMITS.totalBytes) return refused({ code: 'bundle.tooLarge' });

  const problems: BundleError[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    const folded = entry.name.toLowerCase();
    if (!isBundlePath(entry.name) || seen.has(folded))
      problems.push({ code: 'file.name', path: shown(entry.name) });
    else if (!bundleTypeOf(entry.name))
      problems.push({ code: 'file.type', path: shown(entry.name) });
    seen.add(folded);
  }
  if (problems.length) return refused(...problems.slice(0, 50));

  const manifestEntry = files.find((e) => e.name === MANIFEST);
  if (!manifestEntry) return refused({ code: 'manifest.missing', path: MANIFEST });
  if (manifestEntry.originalSize > BUNDLE_LIMITS.manifestBytes)
    return refused({ code: 'manifest.invalid', path: MANIFEST });
  let json: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(extract(bytes, manifestEntry))
      .replace(/^\uFEFF/, '');
    json = JSON.parse(text);
  } catch (error) {
    return error instanceof Damaged
      ? refused({ code: 'bundle.zip', path: MANIFEST })
      : refused({ code: 'manifest.invalid', path: MANIFEST });
  }
  const read = parseManifest(json);
  if (!read.ok) return { ok: false, errors: read.errors };
  if (!files.some((e) => e.name === read.manifest.entry))
    return refused({ code: 'entry.missing', path: shown(read.manifest.entry) });
  return {
    ok: true,
    summary: {
      manifest: read.manifest,
      files: files.length,
      unpackedBytes: declared,
      zipBytes: bytes.length,
    },
  };
}
