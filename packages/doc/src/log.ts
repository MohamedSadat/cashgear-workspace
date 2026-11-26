// A page's stored log replayed into a Y.Doc: what `PageDocument.open` does first, and (after
// 0.19.0) what a page out reads in its worker, off the main thread (`@cgw/doc/out`'s
// `readContent`). Only Yjs and the names: a worker that imports it brings nothing of the editor.
import * as Y from 'yjs';
import type { StoredDoc } from '@cgw/workspace';
import { LOAD } from './names';

type YStore = { pendingStructs: { update: Uint8Array } | null; pendingDs: Uint8Array | null };
const yStore = (doc: Y.Doc) => (doc as unknown as { store: YStore }).store;

/**
 * Yjs 13.6.33 can hold updates as pending after everything they need has arrived, depending on
 * order (S1; bench/editor/fixtures/yjs-pending-order.json). Applying the pending update once more
 * integrates them. Returns whether anything was pending before and after.
 */
export function retryPending(
  doc: Y.Doc,
  origin: unknown = LOAD,
): { before: boolean; after: boolean } {
  const store = yStore(doc);
  const before = !!store.pendingStructs || !!store.pendingDs;
  if (store.pendingStructs) Y.applyUpdateV2(doc, store.pendingStructs.update, origin);
  // Yjs keeps its pending delete set in the V2 encoding too.
  if (store.pendingDs) Y.applyUpdateV2(doc, store.pendingDs, origin);
  return { before, after: !!store.pendingStructs || !!store.pendingDs };
}

/**
 * The snapshot, then each update, in one transaction as `LOAD`. An update that will not apply is
 * set aside: its local sequence is returned, for the store's quarantine.
 */
export function replayLog(doc: Y.Doc, stored: StoredDoc): number[] {
  const bad: number[] = [];
  doc.transact(() => {
    if (stored.snapshot) Y.applyUpdate(doc, stored.snapshot, LOAD);
    for (const update of stored.updates) {
      try {
        Y.applyUpdate(doc, update.data, LOAD);
      } catch {
        bad.push(update.localSeq);
      }
    }
  }, LOAD);
  return bad;
}
