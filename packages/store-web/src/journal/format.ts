// The journal's records (Phase 8, DECISIONS.md 2026-11-16): a second record, outside IndexedDB,
// of every document update this device made that the server may not hold yet. Chrome's IndexedDB
// can lose transactions it reported complete after a crash tears its LevelDB log; a file in the
// Origin Private File System written by the page itself cannot be torn that way, because the
// journal never writes after a torn record: the scan finds where the last whole record ends and
// the writer cuts the file there before it appends.
//
// A record: its kind (1 byte), its payload's length (4 bytes, little-endian), a CRC-32 of kind and
// payload (4 bytes), then the payload.
//   update (1): when (float64 ms), its local sequence in the page's log (float64), the page id
//               and the update id (each a byte of length and ASCII), then the update's bytes
//   forget (2): update ids (each a byte of length and ASCII) no longer needed
// A scan stops at the first record that is short, too long, of no known kind or whose checksum
// fails: everything after it is a torn tail.

export const UPDATE = 1;
export const FORGET = 2;
export const HEADER = 9;
/** No record is larger: an update of more than this is not journalled (IndexedDB still has it). */
export const MAX_RECORD = 16 * 1024 * 1024;

export interface JournalUpdate {
  pageId: string;
  updateId: string;
  /** The update's local sequence in its page's log, as the store gave it. */
  localSeq: number;
  data: Uint8Array;
  /** When it was journalled (ms since the epoch). */
  at: number;
}

export type JournalRecord =
  | { kind: typeof UPDATE; update: JournalUpdate; offset: number; size: number }
  | { kind: typeof FORGET; ids: string[]; offset: number; size: number };

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of `bytes`, continuing from `crc` (pass the previous result's `~` back). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0xffffffff): number {
  for (let i = start; i < end; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

const ascii = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7e || code < 0x20) throw new Error('A journal id must be printable ASCII');
    bytes[i] = code;
  }
  return bytes;
};

function frame(kind: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_RECORD) throw new Error('A journal record is too large');
  const out = new Uint8Array(HEADER + payload.length);
  const view = new DataView(out.buffer);
  out[0] = kind;
  view.setUint32(1, payload.length, true);
  out.set(payload, HEADER);
  // The checksum covers the kind and the payload.
  const crc = crc32(payload, 0, payload.length, crc32(out, 0, 1)) ^ 0xffffffff;
  view.setUint32(5, crc >>> 0, true);
  return out;
}

function withIds(ids: string[], head: number): { bytes: Uint8Array; at: number } {
  const encoded = ids.map(ascii);
  for (const id of encoded) if (id.length > 255) throw new Error('A journal id is too long');
  const bytes = new Uint8Array(head + encoded.reduce((n, id) => n + 1 + id.length, 0));
  let at = head;
  for (const id of encoded) {
    bytes[at++] = id.length;
    bytes.set(id, at);
    at += id.length;
  }
  return { bytes, at };
}

export function encodeUpdate(update: JournalUpdate): Uint8Array {
  const ids = withIds([update.pageId, update.updateId], 16);
  const payload = new Uint8Array(ids.bytes.length + update.data.length);
  payload.set(ids.bytes);
  const view = new DataView(payload.buffer);
  view.setFloat64(0, update.at, true);
  view.setFloat64(8, update.localSeq, true);
  payload.set(update.data, ids.bytes.length);
  return frame(UPDATE, payload);
}

export function encodeForget(ids: string[]): Uint8Array {
  return frame(FORGET, withIds(ids, 0).bytes);
}

function readIds(payload: Uint8Array, at: number, count: number): { ids: string[]; at: number } {
  const ids: string[] = [];
  for (let i = 0; (count < 0 || i < count) && at < payload.length; i++) {
    const length = payload[at++];
    if (at + length > payload.length) throw new Error('A journal id runs past its record');
    ids.push(String.fromCharCode(...payload.subarray(at, at + length)));
    at += length;
  }
  return { ids, at };
}

/**
 * The whole records of a journal file, in order, and where the last of them ends (`valid`): what
 * follows is a torn tail (a write the tab did not finish) and is never read, and the file's
 * writer cuts it off before appending.
 */
export function scan(bytes: Uint8Array): { records: JournalRecord[]; valid: number } {
  const records: JournalRecord[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + HEADER <= bytes.length) {
    const kind = bytes[offset];
    const length = view.getUint32(offset + 1, true);
    if ((kind !== UPDATE && kind !== FORGET) || length > MAX_RECORD) break;
    const end = offset + HEADER + length;
    if (end > bytes.length) break;
    const crc = crc32(bytes, offset + HEADER, end, crc32(bytes, offset, offset + 1)) ^ 0xffffffff;
    if (crc >>> 0 !== view.getUint32(offset + 5, true)) break;
    const payload = bytes.subarray(offset + HEADER, end);
    try {
      if (kind === UPDATE) {
        const head = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const { ids, at } = readIds(payload, 16, 2);
        if (ids.length !== 2) break;
        records.push({
          kind: UPDATE,
          update: {
            at: head.getFloat64(0, true),
            localSeq: head.getFloat64(8, true),
            pageId: ids[0],
            updateId: ids[1],
            data: payload.slice(at),
          },
          offset,
          size: end - offset,
        });
      } else {
        records.push({
          kind: FORGET,
          ids: readIds(payload, 0, -1).ids,
          offset,
          size: end - offset,
        });
      }
    } catch {
      // A checksum that matched over a payload that does not parse: treated as torn.
      break;
    }
    offset = end;
  }
  return { records, valid: offset };
}
