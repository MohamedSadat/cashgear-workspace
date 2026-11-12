// What the sync engine needs from Yjs (DocCodec in @cgw/workspace): the workspace layer moves
// documents as opaque bytes and never looks inside one; this is the document layer's half.
import * as Y from 'yjs';
import type { DocCodec } from '@cgw/workspace';
import { SCHEMA_VERSION } from './schema';
import { stateHash } from './stateHash';

/** `DocCodec` with the Phase 3 addition (contracts, section 3), whether or not the type has it yet. */
export type DocCodecV3 = DocCodec & { stateHash(parts: Uint8Array[]): Promise<string> };

export const docCodec: DocCodecV3 = {
  schemaVersion: SCHEMA_VERSION,
  merge: (updates) => (updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)),
  /** The ids an update writes structs as (not those whose content it only deletes). */
  clientIds: (update) => {
    const { from, to } = Y.parseUpdateMeta(update);
    return [...to.keys()].filter((client) => (to.get(client) ?? 0) > (from.get(client) ?? 0));
  },
  /** The canonical state hash (contracts, section 2) of the document these parts make. */
  stateHash: (parts) => stateHash(parts),
};
