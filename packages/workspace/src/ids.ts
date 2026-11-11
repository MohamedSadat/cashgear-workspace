// Entity ids are UUIDv7, made on the client (DATA_MODEL.md, Identifiers): pages can be created
// offline, and ids sort by creation time. Lower-case hyphenated text everywhere outside SQL Server.

export type Id = string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isId = (value: unknown): value is Id => typeof value === 'string' && UUID.test(value);

let lastMs = 0;
let sequence = 0;

/**
 * RFC 9562 version 7: 48 bits of Unix milliseconds, then 74 random bits. Within one millisecond a
 * 12-bit counter in `rand_a` keeps ids made by this client in order.
 */
export function uuidv7(now: number = Date.now()): Id {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  if (now <= lastMs) {
    sequence++;
    if (sequence > 0xfff) {
      // More than 4,096 ids in one millisecond: borrow the next millisecond.
      lastMs++;
      sequence = 0;
    }
    now = lastMs;
  } else {
    lastMs = now;
    sequence = bytes[6] & 0x03; // a small random start keeps two clients' counters apart
  }
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The creation time an id carries, in Unix milliseconds. */
export function idTime(id: Id): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
