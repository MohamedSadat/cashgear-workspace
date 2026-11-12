// The state hash (Phase 3 contracts, section 2; SYNC_DESIGN.md, the repair path): a short name
// for what a page's document holds, the same in TypeScript and in Rust (`cgw-ydoc`'s
// `state_hash`), so a device and the server can tell whether they hold the same state without
// sending it. The canonical text is
//
//   v1;sv=<client>:<clock>,...;ds=<client>:<start>-<end>,...
//
// with the state vector's pairs sorted by client (clients at clock 0 left out) and the delete
// set's ranges sorted by client, then start, adjacent or overlapping ranges merged, `end`
// exclusive. The hash is the lowercase hex SHA-256 of its UTF-8 bytes. Shared vectors:
// `packages/doc/vectors/state-hash-vectors.json`.
import * as Y from 'yjs';
import { LOAD, retryPending } from './document';

/** A delete-set range as Yjs keeps it: `len` structs from `clock`. */
export interface ClockRange {
  clock: number;
  len: number;
}

/** The canonical text of a state vector and a delete set (any order, ranges may overlap). */
export function canonicalStateText(
  stateVector: ReadonlyMap<number, number>,
  deleteSet: ReadonlyMap<number, readonly ClockRange[]>,
): string {
  const sv = [...stateVector]
    .filter(([, clock]) => clock > 0)
    .sort(([a], [b]) => a - b)
    .map(([client, clock]) => `${client}:${clock}`);
  const ds: string[] = [];
  for (const client of [...deleteSet.keys()].sort((a, b) => a - b)) {
    const ranges = (deleteSet.get(client) ?? [])
      .filter((r) => r.len > 0)
      .map((r) => [r.clock, r.clock + r.len] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current: [number, number] | null = null;
    for (const range of ranges) {
      if (current && range[0] <= current[1]) current[1] = Math.max(current[1], range[1]);
      else {
        if (current) ds.push(`${client}:${current[0]}-${current[1]}`);
        current = [...range];
      }
    }
    if (current) ds.push(`${client}:${current[0]}-${current[1]}`);
  }
  return `v1;sv=${sv.join(',')};ds=${ds.join(',')}`;
}

/** The canonical text of what a Yjs document holds: its state vector and its delete set. */
export function docStateText(doc: Y.Doc): string {
  const deleteSet = Y.createDeleteSetFromStructStore(doc.store);
  return canonicalStateText(Y.decodeStateVector(Y.encodeStateVector(doc)), deleteSet.clients);
}

/** The document these parts make (a snapshot first, then updates, or any updates in any order). */
function docOf(parts: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc({ gc: true });
  doc.transact(() => {
    for (const part of parts) Y.applyUpdate(doc, part, LOAD);
  }, LOAD);
  // Yjs 13.6.33 can hold integrable updates as pending (S1); what Rust holds has them integrated.
  retryPending(doc);
  return doc;
}

/** The canonical text of the document these parts make. Throws if a part does not decode. */
export function stateText(parts: readonly Uint8Array[]): string {
  const doc = docOf(parts);
  try {
    return docStateText(doc);
  } finally {
    doc.destroy();
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The state hash of the document these parts make (contracts, section 2). */
export async function stateHash(parts: readonly Uint8Array[]): Promise<string> {
  return sha256Hex(stateText(parts));
}
