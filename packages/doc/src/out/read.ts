// After 0.19.0: a page's content read from its stored log where the page out is written, in the
// shell's worker, so the main thread never replays a large page or holds its JSON while someone
// types on another page. It reads what `PageDocument.open` with `canEdit: false` then
// `fragmentToJSON` read on the main thread until then: the snapshot and every update (one that
// will not apply is set aside and named, for the store's quarantine), the pending retry, and no
// migration.
import * as Y from 'yjs';
import type { StoredDoc } from '@cgw/workspace';
import { fragmentToJSON, type DocJSON } from '../binding';
import { replayLog, retryPending } from '../log';
import { CONTENT } from '../names';

export function readContent(stored: StoredDoc): { content: DocJSON; bad: number[] } {
  const doc = new Y.Doc({ gc: true });
  try {
    const bad = replayLog(doc, stored);
    retryPending(doc);
    return { content: fragmentToJSON(doc.getXmlFragment(CONTENT)), bad };
  } finally {
    doc.destroy();
  }
}
