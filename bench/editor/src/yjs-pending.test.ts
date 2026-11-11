// Found by spike S1's harness: Yjs 13.6.33 can leave updates pending after every update they
// depend on has arrived, depending on arrival order. Applying the pending update once more
// integrates it. The document layer must do that after every batch (DECISIONS.md, S1).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as Y from 'yjs';

const updates = (
  JSON.parse(
    readFileSync(new URL('../fixtures/yjs-pending-order.json', import.meta.url), 'utf8'),
  ) as string[]
).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
type Store = { pendingStructs: { update: Uint8Array } | null; pendingDs: unknown };
const store = (doc: Y.Doc) => (doc as unknown as { store: Store }).store;

it('Yjs leaves integrable updates pending, and one retry integrates them', () => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  expect(store(doc).pendingStructs).not.toBeNull();
  Y.applyUpdateV2(doc, store(doc).pendingStructs!.update);
  expect(store(doc).pendingStructs).toBeNull();
  expect(store(doc).pendingDs).toBeNull();
  const twice = new Y.Doc();
  for (const update of [...updates, ...updates]) Y.applyUpdate(twice, update);
  expect(doc.getXmlFragment('content').toJSON()).toBe(twice.getXmlFragment('content').toJSON());
});
