// Files an import makes into assets: their type read from their first bytes as the server reads
// it (`Cgw.Core/Assets/AssetSniffer.cs`) and kept only when the server takes it
// (`AssetTypes`), so the engine's upload is never refused; at most 25 MB each; an image's size
// read from its header (never decoded), and one larger than 16,384 px a side or 100 megapixels
// refused (a decompression bomb). Each file becomes one asset however often it is linked.
import { uuidv7, type AssetRecord, type Id } from '@cgw/workspace';
import { IMPORT_MAX_ASSET_BYTES, IMPORT_MAX_IMAGE_PIXELS, IMPORT_MAX_IMAGE_SIDE } from './limits';
import type { ReportBuilder } from './report';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const FILE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/svg+xml',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  // After 0.19.0: what browsers record a voice note in.
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
]);

/** Audio named by its extension, kept as audio when its container is what the bytes show. */
const AUDIO_BY_EXTENSION: Record<string, [type: string, container: string]> = {
  weba: ['audio/webm', 'video/webm'],
  m4a: ['audio/mp4', 'video/mp4'],
  ogg: ['audio/ogg', 'audio/ogg'],
  opus: ['audio/ogg', 'audio/ogg'],
};

const starts = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Valid UTF-8 with no NUL in the first 64 KB: text. */
function isText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  // A character cut at the end of the head is not an error.
  let cut = head.length;
  for (let i = 1; i <= 3 && head.length - i >= 0; i++)
    if ((head[head.length - i] & 0xc0) === 0xc0) {
      cut = head.length - i;
      break;
    }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, cut));
    return true;
  } catch {
    return false;
  }
}

/** The type the bytes say they are, as the server sniffs it; null for none it knows. */
export function sniff(b: Uint8Array): string | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) return 'image/gif';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'image/webp';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WAVE'), 8)) return 'audio/wav';
  if (starts(b, ascii('%PDF-'))) return 'application/pdf';
  if (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 3 || b[2] === 5) &&
    (b[3] === 4 || b[3] === 6)
  )
    return 'application/zip';
  if (starts(b, ascii('ftyp'), 4)) return 'video/mp4';
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (starts(b, ascii('OggS'))) return 'audio/ogg';
  if (starts(b, ascii('ID3')) || (b.length >= 3 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
    return 'audio/mpeg';
  return isText(b) ? 'text/plain' : null;
}

const BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The type a file is kept as (one the server takes and the bytes fit), or null. */
export function contentTypeOf(path: string, bytes: Uint8Array): string | null {
  const sniffed = sniff(bytes);
  if (!sniffed) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? '';
  const audio = AUDIO_BY_EXTENSION[extension];
  if (audio) return sniffed === audio[1] ? audio[0] : null;
  const named = BY_EXTENSION[extension];
  if (named) {
    if (named.startsWith('application/vnd.openxml'))
      return sniffed === 'application/zip' ? named : null;
    if (named === 'image/svg+xml') {
      const head = new TextDecoder().decode(bytes.subarray(0, 4096)).toLowerCase();
      return sniffed === 'text/plain' && head.includes('<svg') ? named : null;
    }
    return sniffed === 'text/plain' ? named : null;
  }
  return (IMAGE_TYPES as readonly string[]).includes(sniffed) || FILE_TYPES.has(sniffed)
    ? sniffed
    : null;
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

/** An image's width and height from its header, as the server reads them; null when unread. */
export function imageSize(type: string, b: Uint8Array): { width: number; height: number } | null {
  switch (type) {
    case 'image/png':
      return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
    case 'image/gif':
      return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
    case 'image/webp': {
      if (b.length < 30) return null;
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === 'VP8X')
        return {
          width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
          height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
        };
      if (chunk === 'VP8L')
        return {
          width: 1 + ((b[21] | (b[22] << 8)) & 0x3fff),
          height: 1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff),
        };
      if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      return null;
    }
    case 'image/jpeg': {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const length = u16be(b, i + 2);
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        )
          return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        i += 2 + length;
      }
      return null;
    }
  }
  return null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Pending {
  id: Id;
  path: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/** The assets an import makes: one per file, decided when a page first links it. */
export class AssetPlanner {
  private readonly byPath = new Map<string, Pending | null>();
  /** Assets a block points at: only those are made. */
  private readonly referenced = new Set<Id>();
  /** Paths of files used as an asset or as a page (so the rest are reported as not linked). */
  readonly used = new Set<string>();

  constructor(
    private readonly files: ReadonlyMap<string, Uint8Array>,
    private readonly report: ReportBuilder,
  ) {}

  /** A file of the import as an image block's asset; null (reported) when it cannot be one. */
  image(path: string): Id | null {
    const asset = this.asset(path, true);
    if (!asset || asset.width === null) return null;
    this.referenced.add(asset.id);
    return asset.id;
  }

  /** A file of the import as an attachment's asset; null (reported) when it cannot be one. */
  file(path: string): Id | null {
    const asset = this.asset(path, false);
    if (!asset) return null;
    this.referenced.add(asset.id);
    return asset.id;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Whether a file of the import can be kept as an attachment (nothing is reported). */
  canKeep(path: string): boolean {
    const bytes = this.files.get(path);
    return !!bytes && bytes.length <= IMPORT_MAX_ASSET_BYTES && contentTypeOf(path, bytes) !== null;
  }

  private asset(path: string, image: boolean): Pending | null {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    this.used.add(path);
    if (this.byPath.has(path)) {
      const known = this.byPath.get(path)!;
      if (known && image && known.width === null) this.report.skip('notImage', path);
      return known;
    }
    const name = path.split('/').pop() ?? path;
    const made = this.make(path, name, bytes, image);
    this.byPath.set(path, made);
    return made;
  }

  private make(path: string, name: string, bytes: Uint8Array, image: boolean): Pending | null {
    const contentType = contentTypeOf(path, bytes);
    if (!contentType) {
      this.report.skip('unknownType', path);
      return null;
    }
    if (bytes.length > IMPORT_MAX_ASSET_BYTES) {
      this.report.skip(contentType.startsWith('image/') ? 'imageTooLarge' : 'fileTooLarge', path);
      return null;
    }
    let width: number | null = null;
    let height: number | null = null;
    if ((IMAGE_TYPES as readonly string[]).includes(contentType)) {
      const size = imageSize(contentType, bytes);
      if (
        !size ||
        size.width < 1 ||
        size.height < 1 ||
        size.width > IMPORT_MAX_IMAGE_SIDE ||
        size.height > IMPORT_MAX_IMAGE_SIDE ||
        size.width * size.height > IMPORT_MAX_IMAGE_PIXELS
      ) {
        this.report.skip(size ? 'imageTooLarge' : 'notImage', path);
        return null;
      }
      width = size.width;
      height = size.height;
    } else if (image) this.report.skip('notImage', path);
    return {
      id: uuidv7(),
      path,
      fileName: name.slice(0, 255) || 'file',
      contentType,
      bytes,
      width,
      height,
    };
  }

  /** The assets made, as records of the workspace, with their bytes. */
  async records(
    workspaceId: Id,
    now: string,
  ): Promise<{ record: AssetRecord; bytes: Uint8Array; image: boolean }[]> {
    const out: { record: AssetRecord; bytes: Uint8Array; image: boolean }[] = [];
    for (const pending of this.byPath.values()) {
      if (!pending || !this.referenced.has(pending.id)) continue;
      out.push({
        record: {
          id: pending.id,
          workspaceId,
          fileName: pending.fileName,
          contentType: pending.contentType,
          sizeBytes: pending.bytes.byteLength,
          sha256: await sha256(pending.bytes),
          width: pending.width,
          height: pending.height,
          createdAt: now,
        },
        bytes: pending.bytes,
        image: pending.width !== null,
      });
    }
    return out;
  }
}
