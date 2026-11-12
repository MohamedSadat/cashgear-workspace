// The names inside every page's Yjs document (DATA_MODEL.md, "The Yjs document"), and the
// origins this layer gives the Yjs transactions it makes itself.
import type * as Y from 'yjs';

/** The ProseMirror document (`Y.XmlFragment`). */
export const CONTENT = 'content';
/** `schemaVersion`, `epoch`, `pageId` (`Y.Map`). */
export const META = 'meta';
/**
 * Move intents (`Y.Map`): block id -> `MoveIntent`, written by the editor in the same Yjs
 * transaction as the move (SYNC_DESIGN.md, "Inside a page"). Clients that do not read it keep it,
 * as Yjs keeps every root type; the server's checks read only `content`.
 */
export const MOVES = 'moves';

/** Replaying the local log: never saved again. */
export const LOAD = Symbol('cgw-load');
/** Updates pulled from the server: already in the store, never saved or pushed again. */
export const REMOTE = Symbol('cgw-remote');
/** A schema migration (migrations.ts): an ordinary local edit, saved and pushed. */
export const MIGRATE = Symbol('cgw-migrate');

/** The document's schema version, from `meta` (1 when it is not there). */
export function documentVersion(doc: Y.Doc): number {
  const value = doc.getMap(META).get('schemaVersion');
  return typeof value === 'number' ? value : 1;
}
