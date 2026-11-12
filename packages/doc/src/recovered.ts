// Recovered pages (contracts, section 5; SYNC_DESIGN.md, "Across the two models" and "Epoch
// change"): what a device set aside so nothing typed is lost becomes a new page. Its content is
// the set-aside log (the snapshot first, then every update) merged in a fresh document and read
// as ProseMirror JSON, block ids kept. The shell writes it as the new page's first update
// (`newDocumentUpdate(newPageId, recoveredContent(entry.parts), clientId)`), so the new page gets
// its own meta: its own page id, epoch 0 and this build's schema version.
import * as Y from 'yjs';
import { fragmentToJSON, type DocJSON } from './binding';
import { retryPending } from './document';
import { CONTENT, LOAD } from './names';

/**
 * The content a set-aside log holds. A part that does not decode is left out and the rest is
 * recovered: the point is that nothing that can be read is lost. The parts may be from another
 * epoch than the page has now; they are read on their own, never mixed with the page.
 */
export function recoveredContent(parts: readonly Uint8Array[]): DocJSON {
  const doc = new Y.Doc({ gc: true });
  try {
    doc.transact(() => {
      for (const part of parts) {
        try {
          Y.applyUpdate(doc, part, LOAD);
        } catch (error) {
          console.warn('A set-aside update did not decode; the rest is recovered.', error);
        }
      }
    }, LOAD);
    retryPending(doc);
    return fragmentToJSON(doc.getXmlFragment(CONTENT));
  } finally {
    doc.destroy();
  }
}
