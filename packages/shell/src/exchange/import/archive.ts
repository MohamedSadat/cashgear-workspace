// Reading what an import is given into a list of files, with the guards against a hostile archive
// (M8.4): a path out of the folder (`..`), an absolute path or one with control characters is
// not read; a zip bomb (an entry unpacking to over 1,000 times its size, or more than 500 MB in
// all) and more than 20,000 files are refused before anything is unpacked, by the sizes the
// archive declares; nothing unpacks to more than it declared (fflate writes into a buffer of the
// declared size). An archive of archives (a Notion export in parts) is read as their files, two
// levels deep at most. Nothing is ever written to a disk: paths are only names here.
import { unzipSync } from 'fflate';
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

interface Entry {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

function listEntries(bytes: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        entries.push({ ...file });
        return false;
      },
    });
  } catch {
    throw new ImportRefused('damaged');
  }
  return entries;
}

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u32 = (d: Uint8Array, at: number) =>
  (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

/**
 * Each entry's name as the central directory writes it, in its order (fflate's): its bytes and
 * whether the UTF-8 flag (bit 11) is set. Read the way fflate reads it (the end record, zip64's
 * when there is one), after fflate has read the same bytes without an error.
 */
function rawNames(d: Uint8Array): { utf8: boolean; bytes: Uint8Array }[] {
  let end = d.length - 22;
  while (end > 0 && u32(d, end) !== 0x06054b50) end--;
  let count = u16(d, end + 8);
  let at = u32(d, end + 16);
  if (end >= 20 && u32(d, end - 20) === 0x07064b50) {
    const zip64 = u32(d, end - 12);
    if (u32(d, zip64) === 0x06064b50) {
      count = u32(d, zip64 + 32);
      at = u32(d, zip64 + 48);
    }
  }
  const out: { utf8: boolean; bytes: Uint8Array }[] = [];
  for (let i = 0; i < count && at + 46 <= d.length; i++) {
    const nameLength = u16(d, at + 28);
    out.push({
      utf8: (u16(d, at + 8) & 0x800) !== 0,
      bytes: d.subarray(at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + u16(d, at + 30) + u16(d, at + 32);
  }
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * An entry's name: fflate reads a name without the UTF-8 flag as Latin-1, but macOS, 7-Zip and
 * many tools write UTF-8 there without setting the flag. Bytes that are valid UTF-8 are read as
 * UTF-8; others keep fflate's Latin-1 and are reported as possibly garbled (an old code page).
 */
function nameOf(
  latin1: string,
  raw: { utf8: boolean; bytes: Uint8Array } | undefined,
  report: ReportBuilder,
): string {
  if (!raw || raw.utf8 || raw.bytes.every((b) => b < 0x80)) return latin1;
  try {
    return strictUtf8.decode(raw.bytes);
  } catch {
    report.skip('namesGarbled', shown(latin1));
    return latin1;
  }
}

const isZip = (path: string) => /\.zip$/i.test(path);
const MB = 1024 * 1024;

/**
 * An archive's files, checked: what cannot be read safely is left out and reported; a bomb, too
 * many files or too many bytes refuse the whole import. An archive made only of archives is
 * read as their files.
 */
export function readArchive(
  bytes: Uint8Array,
  report: ReportBuilder,
  budget: Budget = newBudget(),
  depth = 0,
): ImportFile[] {
  const entries = listEntries(bytes);
  if (entries.length > budget.files) throw new ImportRefused('tooManyFiles');
  const names = rawNames(bytes);
  const accepted = new Map<number, string>();
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const check = checkPath(nameOf(entry.name, names[index], report));
    if ('reason' in check) {
      if (check.reason === 'unsafe') report.skip('unsafePath', shown(entry.name));
      else if (check.reason === 'tooDeep') report.skip('tooDeep', shown(entry.name));
      return;
    }
    if (entry.compression !== 0 && entry.compression !== 8) {
      report.skip('unsupportedEntry', check.path);
      return;
    }
    const key = check.path.toLowerCase();
    if (seen.has(key)) {
      report.skip('duplicate', check.path);
      return;
    }
    seen.add(key);
    // A stored entry is its packed bytes; a deflated one unpacks to what it declares, never more.
    const size = entry.compression === 0 ? entry.size : entry.originalSize;
    if (
      entry.originalSize > IMPORT_RATIO_FLOOR &&
      entry.originalSize > entry.size * IMPORT_MAX_RATIO
    )
      throw new ImportRefused('zipBomb');
    budget.bytes -= size;
    budget.files -= 1;
    if (budget.bytes < 0) throw new ImportRefused('tooLarge', Math.round(IMPORT_MAX_BYTES / MB));
    if (budget.files < 0) throw new ImportRefused('tooManyFiles');
    accepted.set(index, check.path);
  });
  let unpacked: Record<string, Uint8Array>;
  const order: string[] = [];
  try {
    let index = -1;
    unpacked = unzipSync(bytes, {
      filter: (file) => {
        index++;
        if (!accepted.has(index)) return false;
        // fflate keys files by their names as written; ours are checked and may differ.
        order.push(file.name);
        return true;
      },
    });
  } catch {
    throw new ImportRefused('damaged');
  }
  const paths = [...accepted.values()];
  const files: ImportFile[] = order.map((name, i) => ({ path: paths[i], bytes: unpacked[name] }));
  // Notion writes a large export as an archive of archives (`Export-…-Part-1.zip`).
  if (files.length && files.every((file) => isZip(file.path))) {
    if (depth >= IMPORT_MAX_NESTED_ZIPS) {
      for (const file of files) report.skip('nestedArchive', file.path);
      return [];
    }
    const out: ImportFile[] = [];
    const taken = new Set<string>();
    for (const file of files) {
      // The part's own bytes are gone once it is read: its files count instead.
      budget.bytes += file.bytes.length;
      budget.files += 1;
      for (const inner of readArchive(file.bytes, report, budget, depth + 1)) {
        const key = inner.path.toLowerCase();
        if (taken.has(key)) report.skip('duplicate', inner.path);
        else {
          taken.add(key);
          out.push(inner);
        }
      }
    }
    return out;
  }
  return files;
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
