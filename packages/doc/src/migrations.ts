// Document schema migrations (DATA_MODEL.md, "Schema versions and migrations"). A migration is a
// function from version n to n + 1 that edits the document as an ordinary Yjs transaction. It
// runs on the first capable client that opens the page with edit rights (PageDocument.open), as
// one local transaction with the MIGRATE origin, so it is saved and pushed like any edit; the
// server worker accepts the higher `meta.schemaVersion` when the push says this build knows it
// (contracts, section 2). Each step sets `meta.schemaVersion` to n + 1. A step is never edited
// once shipped; each has a fixture of the older version (fixtures/) and a test that the result
// loads in this build.
import * as Y from 'yjs';
import { META, MIGRATE, documentVersion } from './names';
import { SCHEMA_VERSION } from './schema';

export type Migration = (doc: Y.Doc) => void;

export const migrations: Record<number, Migration> = {
  // 1 -> 2: version 2 adds the `tableOfContents` body. No content changes; the version rises so
  // that a version-1 build opens the page read-only rather than meet a node it cannot draw.
  1: (doc) => {
    doc.getMap(META).set('schemaVersion', 2);
  },
};

export interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Brings the document up to this build's schema version, every step in one Yjs transaction.
 * Null when there was nothing to do (already current, or newer than this build: never touched).
 */
export function migrate(doc: Y.Doc, origin: unknown = MIGRATE): MigrationResult | null {
  const from = documentVersion(doc);
  if (from >= SCHEMA_VERSION) return null;
  doc.transact(() => {
    for (let version = from; version < SCHEMA_VERSION; version++) {
      const step = migrations[version];
      if (!step) throw new Error(`No migration from document schema version ${version}`);
      step(doc);
      if (documentVersion(doc) !== version + 1) doc.getMap(META).set('schemaVersion', version + 1);
    }
  }, origin);
  return { from, to: SCHEMA_VERSION };
}
