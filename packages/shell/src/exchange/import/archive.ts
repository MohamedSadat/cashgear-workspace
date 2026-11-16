// Reading what an import is given into a list of files, with the guards against a hostile archive
// (M8.4): a path out of the folder (`..`), an absolute path or one with control characters is
// not read; a zip bomb (an entry unpacking to over 1,000 times its size, or more than 500 MB in
// all) and more than 20,000 files are refused before anything is unpacked, by the sizes the
// archive declares; the central directory is read by our own bounds-checked code, and an entry is
// inflated in slices and refused once it unpacks past what it declared. An archive of archives (a
// Notion export in parts) is read as their files, a part at a time, two levels deep at most.
// Nothing is ever written to a disk: paths are only names here.
import { Inflate } from 'fflate';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_NESTED_ZIPS,
  IMPORT_MAX_PATH_PARTS,
  IMPORT_MAX_RATIO,
  IMPORT_RATIO_FLOOR,
} from './limits';
import { ImportRefused, type ReportBuilder } from './report';

export interface ImportFile {
  /** Its path inside what was imported, `/`-separated, never starting with `/` or holding `..`. */
  path: string;
  bytes: Uint8Array;
}

/** What is left to read: bytes and files (shared by an archive and the archives inside it). */
export interface Budget {
  bytes: number;
  files: number;
}

export const newBudget = (): Budget => ({ bytes: IMPORT_MAX_BYTES, files: IMPORT_MAX_FILES });

/** Files a system writes beside a person's own: never imported, never reported. */
const SYSTEM =
  /(^|\/)(__MACOSX|\.git|\.svn|\.obsidian|\.trash)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/i;

/**
 * C0 controls and DEL: never in a name a person gave a file. (C1 ones are left: a name in an old
 * code page, read as Latin-1, has them; such a name is reported as possibly garbled instead.)
 */
const hasControl = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const BIDI = /\p{Bidi_Control}/gu;

export type PathCheck = { path: string } | { reason: 'unsafe' | 'tooDeep' | 'system' | 'folder' };

/** A path from an archive or a folder, checked and made `/`-separated. */
export function checkPath(raw: string): PathCheck {
  if (raw.endsWith('/') || raw.endsWith('\\')) return { reason: 'folder' };
  if (hasControl(raw)) return { reason: 'unsafe' };
  const path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\0'))
    return { reason: 'unsafe' };
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return { reason: 'unsafe' };
  if (!parts.length) return { reason: 'folder' };
  const joined = parts.join('/');
  if (SYSTEM.test(joined)) return { reason: 'system' };
  if (parts.length > IMPORT_MAX_PATH_PARTS) return { reason: 'tooDeep' };
  return { path: joined };
}

/** A name as a title: control and direction-override characters taken out. */
export function cleanName(name: string): { name: string; cleaned: boolean } {
  const cleaned = name.replace(/\p{Cc}/gu, ' ').replace(BIDI, '');
  return { name: cleaned.replace(/\s+/g, ' ').trim(), cleaned: cleaned !== name };
}

/** A path as the report shows it: its control characters made visible. */
const shown = (raw: string) => raw.replace(/\p{Cc}/gu, '?').slice(0, 200);

/** An entry as the archive's central directory lists it. */
interface CentralEntry {
  /** Its name: UTF-8 when flagged or valid, else Latin-1 (`garbled`). */
  name: string;
  garbled: boolean;
  method: number;
  encrypted: boolean;
  /** Packed and unpacked sizes as declared, and where its local header is. */
  size: number;
  originalSize: number;
  offset: number;
}

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u32 = (d: Uint8Array, at: number) =>
  (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
const u64 = (d: Uint8Array, at: number) => u32(d, at) + u32(d, at + 4) * 0x100000000;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const utf8 = new TextDecoder();
const latin1 = (bytes: Uint8Array) => {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};

/** A central directory entry takes at least this many bytes. */
const CENTRAL_ENTRY = 46;

/**
 * The archive's central directory, read by our own code before anything else (the security
 * review: fflate takes a zip64 end record's entry count as it stands, so a 100-byte file could make
 * it list 4.3 billion entries). The end record is the last one within a comment's reach of the
 * end; zip64's end record, when its locator is there, gives the count and offset. A count the
 * file cannot hold (46 bytes an entry) is refused as damaged, one over `maxFiles` as too many,
 * before a single entry is read. Every read is bounds-checked. Names without the UTF-8 flag are
 * read as UTF-8 when the bytes are valid UTF-8 (macOS, 7-Zip and others write it so), else as
 * Latin-1 and marked possibly garbled (an old code page).
 */
function readCentral(d: Uint8Array, maxFiles: number): CentralEntry[] {
  const damaged = () => new ImportRefused('damaged');
  const floor = Math.max(0, d.length - 22 - 0xffff);
  let end = d.length - 22;
  while (end >= floor && u32(d, end) !== 0x06054b50) end--;
  if (end < floor) throw damaged();
  let count = u16(d, end + 10);
  let at = u32(d, end + 16);
  if (end >= 20 && u32(d, end - 20) === 0x07064b50) {
    const record = u64(d, end - 12);
    if (record + 56 <= end && u32(d, record) === 0x06064b50) {
      count = u64(d, record + 32);
      at = u64(d, record + 48);
    }
  }
  if (at > d.length || count > (d.length - at) / CENTRAL_ENTRY) throw damaged();
  if (count > maxFiles) throw new ImportRefused('tooManyFiles');
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_ENTRY > d.length || u32(d, at) !== 0x02014b50) throw damaged();
    const flags = u16(d, at + 8);
    const nameLength = u16(d, at + 28);
    const extraLength = u16(d, at + 30);
    const commentLength = u16(d, at + 32);
    const nameStart = at + CENTRAL_ENTRY;
    const extraEnd = nameStart + nameLength + extraLength;
    if (extraEnd + commentLength > d.length) throw damaged();
    let size = u32(d, at + 20);
    let originalSize = u32(d, at + 24);
    let offset = u32(d, at + 42);
    // Zip64: the fields written as 0xFFFFFFFF are in the extra field of id 1, in this order.
    if (size === 0xffffffff || originalSize === 0xffffffff || offset === 0xffffffff) {
      for (let x = nameStart + nameLength; x + 4 <= extraEnd; x += 4 + u16(d, x + 2)) {
        if (u16(d, x) !== 1) continue;
        let field = x + 4;
        const next = () => {
          if (field + 8 > extraEnd) throw damaged();
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
    let garbled = false;
    if (flags & 0x800) name = utf8.decode(raw);
    else if (raw.every((b) => b < 0x80)) name = latin1(raw);
    else
      try {
        name = strictUtf8.decode(raw);
      } catch {
        name = latin1(raw);
        garbled = true;
      }
    entries.push({
      name,
      garbled,
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

/** Packed bytes fed to the inflater at a time: what one push can unpack to is bounded by it. */
const INFLATE_SLICE = 16 * 1024;

/**
 * An entry's bytes. A deflated one is inflated in slices and refused the moment it unpacks to more
 * than it declares, so neither memory nor work ever goes past the declared size (the review: a
 * one-shot inflate into a buffer of the declared size kept decoding to the stream's end).
 */
function extract(d: Uint8Array, entry: CentralEntry): Uint8Array {
  const local = entry.offset;
  if (local + 30 > d.length || u32(d, local) !== 0x04034b50) throw new ImportRefused('damaged');
  const start = local + 30 + u16(d, local + 26) + u16(d, local + 28);
  if (start + entry.size > d.length) throw new ImportRefused('damaged');
  const data = d.subarray(start, start + entry.size);
  if (entry.method === 0) return data.slice();
  if (!data.length) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const inflater = new Inflate((chunk) => {
      total += chunk.length;
      if (total > entry.originalSize) throw new ImportRefused('damaged');
      chunks.push(chunk);
    });
    for (let at = 0; at < data.length; at += INFLATE_SLICE) {
      const last = at + INFLATE_SLICE >= data.length;
      inflater.push(data.subarray(at, Math.min(at + INFLATE_SLICE, data.length)), last);
    }
  } catch (error) {
    if (error instanceof ImportRefused) throw error;
    throw new ImportRefused('damaged');
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const isZip = (path: string) => /\.zip$/i.test(path);
const MB = 1024 * 1024;

/** What an entry costs while held: a stored one its packed bytes, a deflated one its declared size. */
const held = (entry: CentralEntry) => (entry.method === 0 ? entry.size : entry.originalSize);

const charge = (budget: Budget, bytes: number) => {
  budget.bytes -= bytes;
  if (budget.bytes < 0) throw new ImportRefused('tooLarge', Math.round(IMPORT_MAX_BYTES / MB));
};

/**
 * An archive's files, checked: what cannot be read safely is left out and reported; a bomb, too
 * many files or too many bytes refuse the whole import. An archive made only of archives is read as
 * their files, one part at a time: a part is counted while it is held and given back once its
 * files are read (they are counted instead), so the budget is what is in memory.
 */
export function readArchive(
  bytes: Uint8Array,
  report: ReportBuilder,
  budget: Budget = newBudget(),
  depth = 0,
): ImportFile[] {
  const entries = readCentral(bytes, budget.files);
  const accepted: { entry: CentralEntry; path: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.garbled) report.skip('namesGarbled', shown(entry.name));
    const check = checkPath(entry.name);
    if ('reason' in check) {
      if (check.reason === 'unsafe') report.skip('unsafePath', shown(entry.name));
      else if (check.reason === 'tooDeep') report.skip('tooDeep', shown(entry.name));
      continue;
    }
    if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) {
      report.skip('unsupportedEntry', check.path);
      continue;
    }
    const key = check.path.toLowerCase();
    if (seen.has(key)) {
      report.skip('duplicate', check.path);
      continue;
    }
    seen.add(key);
    if (entry.method === 8) {
      if (
        entry.originalSize > IMPORT_RATIO_FLOOR &&
        entry.originalSize > entry.size * IMPORT_MAX_RATIO
      )
        throw new ImportRefused('zipBomb');
      // Deflate never needs much more room than the bytes it holds (stored blocks add 5 bytes in
      // 64 KB): far more packed bytes than the declared size can need is not an honest entry.
      if (entry.size > entry.originalSize + entry.originalSize / 1000 + 1024)
        throw new ImportRefused('damaged');
    }
    accepted.push({ entry, path: check.path });
  }
  budget.files -= accepted.length;
  if (budget.files < 0) throw new ImportRefused('tooManyFiles');
  // Notion writes a large export as an archive of archives (`Export-…-Part-1.zip`).
  if (accepted.length && accepted.every((file) => isZip(file.path))) {
    if (depth >= IMPORT_MAX_NESTED_ZIPS) {
      for (const file of accepted) report.skip('nestedArchive', file.path);
      return [];
    }
    const out: ImportFile[] = [];
    const taken = new Set<string>();
    for (const part of accepted) {
      charge(budget, held(part.entry));
      const inner = readArchive(extract(bytes, part.entry), report, budget, depth + 1);
      // The part's bytes are let go now; its files are what is held (and counted).
      budget.bytes += held(part.entry);
      budget.files += 1;
      for (const file of inner) {
        const key = file.path.toLowerCase();
        if (taken.has(key)) report.skip('duplicate', file.path);
        else {
          taken.add(key);
          out.push(file);
        }
      }
    }
    return out;
  }
  charge(
    budget,
    accepted.reduce((sum, file) => sum + held(file.entry), 0),
  );
  return accepted.map((file) => ({ path: file.path, bytes: extract(bytes, file.entry) }));
}

/** Files of a chosen folder (their paths start with the folder's name), checked the same way. */
export function readFolder(
  given: readonly { path: string; bytes: Uint8Array }[],
  report: ReportBuilder,
  budget: Budget = newBudget(),
): ImportFile[] {
  if (given.length > budget.files) throw new ImportRefused('tooManyFiles');
  const out: ImportFile[] = [];
  const seen = new Set<string>();
  for (const file of given) {
    const check = checkPath(file.path);
    if ('reason' in check) {
      if (check.reason === 'unsafe') report.skip('unsafePath', shown(file.path));
      else if (check.reason === 'tooDeep') report.skip('tooDeep', shown(file.path));
      continue;
    }
    const key = check.path.toLowerCase();
    if (seen.has(key)) {
      report.skip('duplicate', check.path);
      continue;
    }
    seen.add(key);
    budget.bytes -= file.bytes.length;
    budget.files -= 1;
    if (budget.bytes < 0) throw new ImportRefused('tooLarge', Math.round(IMPORT_MAX_BYTES / MB));
    out.push({ path: check.path, bytes: file.bytes });
  }
  return out;
}
