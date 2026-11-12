// The move intent (SYNC_DESIGN.md, "Inside a page"; Phase 3, M3.3). Yjs has no move: moving a
// block (drag, Alt+Shift+arrows, indent, outdent) deletes it and inserts a copy, so typing a peer
// did in the block meanwhile goes with the deleted copy. That is a named limit; what this module
// adds is that it is recorded and told:
//
// - The writer: when a local transaction removes block ids and inserts them again (the block-id
//   rules keep a moved block's id, D4), the editor records `moves[id] = { at, parent }` in the
//   page's Yjs document, in the same Yjs transaction as the move. A moved block is recognisable
//   in history, and older clients keep the map (Yjs keeps root types it does not read).
// - The check: when a remote change deletes this device's own content (by its Yjs client id)
//   that the remote change did not itself name, the other device deleted a block it could not
//   see those edits in. If that block lives on under the same id, it was moved, and the edit was
//   lost with the old copy: `editLost`. If the remote change records a move of a block this
//   device also moved, and the block now appears twice, that is `movedTwice`. Either way the
//   page's history has the content as it was.
import type { Node as PMNode, Slice, Fragment } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { repairId, textOnlyChange } from './ids';
import { CONTENT, MOVES } from './names';

/** What the `moves` map holds for a block id: when (this device's clock) and under which block. */
export interface MoveIntent {
  /** Milliseconds since 1970 on the moving device: for people reading history, never compared. */
  at: number;
  /** The block it was moved into, or null at the top of the page. */
  parent: string | null;
}

export interface MoveConflict {
  blockId: string;
  /**
   * `editLost`: this device's edit inside the block was lost because another device moved it
   * without having seen the edit. `movedTwice`: this device and another moved it at once; it now
   * appears twice.
   */
  reason: 'editLost' | 'movedTwice';
}

// ---------------------------------------------------------------------------------------------
// The writer

/** Block ids in a slice that it really inserts (not the open nodes at its edges). */
function insertedIds(slice: Slice, out: Set<string>) {
  const visit = (fragment: Fragment, depth: number, leftEdge: boolean, rightEdge: boolean) => {
    fragment.forEach((node, _offset, index) => {
      const left = leftEdge && index === 0;
      const right = rightEdge && index === fragment.childCount - 1;
      const open = (left && depth < slice.openStart) || (right && depth < slice.openEnd);
      if (node.type.name !== 'block') return;
      if (!open && node.attrs.id) out.add(node.attrs.id as string);
      visit(node.content, depth + 1, left, right);
    });
  };
  visit(slice.content, 0, true, true);
}

/** Block ids of the blocks that lie wholly inside [from, to) of a document. */
function idsWithin(doc: PMNode, from: number, to: number, out: Set<string>) {
  if (to <= from) return;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'block') return false;
    if (pos >= from && pos + node.nodeSize <= to && node.attrs.id) out.add(node.attrs.id as string);
    return true;
  });
}

/**
 * The block ids a transaction removed and inserted again: a move, an indent, an outdent, a drag,
 * and the children a merge or an outdent carries along. Text-only transactions cost nothing.
 */
export function movedBlockIds(tr: Transaction): Set<string> {
  const moved = new Set<string>();
  if (!tr.docChanged || textOnlyChange(tr)) return moved;
  const removed = new Set<string>();
  const inserted = new Set<string>();
  tr.steps.forEach((step, i) => {
    const doc = tr.docs[i];
    if (step instanceof ReplaceStep) {
      const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
      idsWithin(doc, from, to, removed);
      insertedIds(slice, inserted);
    } else if (step instanceof ReplaceAroundStep) {
      // Wrapping and lifting: Yjs makes the gap's blocks again inside their new parent.
      const { from, to, gapFrom, gapTo, slice } = step as unknown as {
        from: number;
        to: number;
        gapFrom: number;
        gapTo: number;
        slice: Slice;
      };
      idsWithin(doc, from, to, removed);
      idsWithin(doc, gapFrom, gapTo, inserted);
      insertedIds(slice, inserted);
    }
  });
  for (const id of removed) if (inserted.has(id)) moved.add(id);
  return moved;
}

/** Each id's parent block in the document (null at the top), for the ids asked about. */
function parentsOf(doc: PMNode, ids: ReadonlySet<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const walk = (node: PMNode, parent: string | null) => {
    node.forEach((child) => {
      if (child.type.name !== 'block') return;
      const id = child.attrs.id as string | null;
      if (id && ids.has(id) && !out.has(id)) out.set(id, parent);
      walk(child, id);
    });
  };
  walk(doc, null);
  return out;
}

/** Records move intents, inside the current Yjs transaction when there is one. */
export function writeMoves(
  doc: Y.Doc,
  moves: ReadonlyMap<string, string | null>,
  at = Date.now(),
): void {
  if (!moves.size) return;
  const map = doc.getMap<MoveIntent>(MOVES);
  doc.transact(() => {
    for (const [id, parent] of moves) map.set(id, { at, parent });
  });
}

export const moveIntentKey = new PluginKey('cgwMoveIntents');

/**
 * Records a local move's intent in the same Yjs transaction as the move. The plugin notes the
 * moved ids when the transaction is applied; the binding then writes the new document to Yjs in
 * one transaction with its own origin, and the note is written as that transaction begins. A
 * remote change, an undo (Yjs's own), and the id repair never record anything.
 */
export function moveIntentPlugin(
  fragment: Y.XmlFragment,
  isRemote: (tr: Transaction) => boolean,
): Plugin {
  let pending: { doc: PMNode; ids: Set<string> } | null = null;
  return new Plugin({
    key: moveIntentKey,
    state: {
      init: () => null,
      apply(tr, _value, oldState, newState) {
        if (!tr.docChanged) return null;
        if (isRemote(tr)) {
          pending = null;
          return null;
        }
        const moved = movedBlockIds(tr);
        // Transactions appended to this one (the id plugin's) carry the note on.
        if (pending && pending.doc === oldState.doc) {
          pending.doc = newState.doc;
          for (const id of moved) pending.ids.add(id);
        } else pending = moved.size ? { doc: newState.doc, ids: moved } : null;
        return null;
      },
    },
    view(view) {
      const doc = fragment.doc;
      if (!doc) return {};
      const before = (transaction: Y.Transaction) => {
        if (!pending || transaction.origin !== ySyncPluginKey) return;
        const note = pending;
        pending = null;
        if (view.state.doc !== note.doc) return;
        const parents = parentsOf(note.doc, note.ids);
        writeMoves(doc, parents);
      };
      doc.on('beforeTransaction', before);
      return { destroy: () => doc.off('beforeTransaction', before) };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The check

type YStore = { pendingDs: Uint8Array | null };
type AnyType = Y.AbstractType<unknown>;
type MapEntries = Map<string, Y.Item>;

/** The id attribute of a block element, read from its item even after it was deleted. */
function rawBlockId(element: Y.XmlElement): string | null {
  const item = (element as unknown as { _map: MapEntries })._map.get('id');
  const value = item?.content.getContent()[0];
  return typeof value === 'string' ? value : null;
}

/** The innermost block element an item is in, or is. */
function enclosingBlock(item: Y.Item): Y.XmlElement | null {
  let type: AnyType | null =
    item.content instanceof Y.ContentType
      ? (item.content.type as AnyType)
      : (item.parent as AnyType | null);
  while (type) {
    if (type instanceof Y.XmlElement && type.nodeName === 'block') return type;
    type = (type._item?.parent as AnyType | undefined) ?? null;
  }
  return null;
}

/** The block element around a block element, if any. */
function enclosingOf(block: Y.XmlElement): Y.XmlElement | null {
  let type = (block._item?.parent as AnyType | undefined) ?? null;
  while (type) {
    if (type instanceof Y.XmlElement && type.nodeName === 'block') return type;
    type = (type._item?.parent as AnyType | undefined) ?? null;
  }
  return null;
}

/** How many live blocks hold each id. */
function liveBlockIds(fragment: Y.XmlFragment): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'block') continue;
      const id = child.getAttribute('id');
      if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
      walk(child);
    }
  };
  walk(fragment);
  return counts;
}

/** Whether every clock in [clock, clock + len) is inside the ranges. */
function covered(ranges: readonly { clock: number; len: number }[], clock: number, len: number) {
  let at = clock;
  for (const range of [...ranges].sort((a, b) => a.clock - b.clock)) {
    if (range.clock > at) break;
    at = Math.max(at, range.clock + range.len);
    if (at >= clock + len) return true;
  }
  return at >= clock + len;
}

export interface MoveCheck {
  /** Call after the remote transactions, with the updates they applied (Yjs's V1 encoding). */
  finish(updates: readonly Uint8Array[]): MoveConflict[];
}

/**
 * Starts watching remote transactions on a document for move conflicts (see the top of this
 * file). `ownMoves` are the block ids this device has recorded moves of. Costs nothing unless a
 * remote change deletes this device's content or records a move.
 */
export function watchMoves(
  doc: Y.Doc,
  isRemote: (origin: unknown) => boolean,
  ownMoves: ReadonlySet<string>,
): MoveCheck {
  const own = doc.clientID;
  const pendingDs = (doc.store as unknown as YStore).pendingDs;
  const moves: unknown = doc.getMap(MOVES);
  /** This device's structs the remote changes deleted, with the deleted blocks around them. */
  const lost: { clock: number; len: number; blocks: string[] }[] = [];
  const movedKeys = new Set<string>();
  const listener = (transaction: Y.Transaction) => {
    if (!isRemote(transaction.origin)) return;
    for (const [type, keys] of transaction.changed)
      if (type === moves) for (const key of keys) if (key) movedKeys.add(key);
    const ranges = transaction.deleteSet.clients.get(own);
    if (!ranges?.length) return;
    const mine = Y.createDeleteSet();
    mine.clients.set(own, ranges);
    Y.iterateDeletedStructs(transaction, mine, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      // The deleted blocks around it, innermost first. Only a block deleted as a whole can have
      // been moved: a body replaced ("turn into" code) is not a move.
      const blocks: string[] = [];
      for (let block = enclosingBlock(struct); block?._item?.deleted; block = enclosingOf(block)) {
        const id = rawBlockId(block);
        if (id) blocks.push(id);
      }
      if (blocks.length) lost.push({ clock: struct.id.clock, len: struct.length, blocks });
    });
  };
  doc.on('afterTransaction', listener);
  return {
    finish(updates) {
      doc.off('afterTransaction', listener);
      const conflicts = new Map<string, MoveConflict['reason']>();
      const twice = [...movedKeys].filter((id) => ownMoves.has(id));
      if (!lost.length && !twice.length) return [];
      const live = liveBlockIds(doc.getXmlFragment(CONTENT));
      if (lost.length) {
        // What the remote changes deleted by name: those it had seen. The rest went with a
        // block they deleted without having seen it.
        const named: { clock: number; len: number }[] = [];
        const add = (ds: { clients: Map<number, { clock: number; len: number }[]> }) =>
          named.push(...(ds.clients.get(own) ?? []));
        for (const update of updates) {
          try {
            add(Y.decodeUpdate(update).ds);
          } catch {
            // An update that did not apply named nothing.
          }
        }
        if (pendingDs) add(Y.decodeUpdateV2(pendingDs).ds);
        // The innermost deleted block that lives on under its id was moved: the edit went with
        // its old copy (typing in it, or a block added inside a moved parent).
        for (const item of lost) {
          if (covered(named, item.clock, item.len)) continue;
          const moved = item.blocks.find((id) => (live.get(id) ?? 0) > 0);
          if (moved) conflicts.set(moved, 'editLost');
        }
      }
      for (const id of twice) {
        const copies = (live.get(id) ?? 0) + (live.get(repairId(id, 1)) ?? 0);
        if (copies >= 2 && !conflicts.has(id)) conflicts.set(id, 'movedTwice');
      }
      return [...conflicts].map(([blockId, reason]) => ({ blockId, reason }));
    },
  };
}
