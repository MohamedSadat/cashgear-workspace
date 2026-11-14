// The Yjs seam (D5): everything above sees these functions, never the binding behind them. Today
// that is Tiptap's fork, @tiptap/y-tiptap, carrying the Q18 patch (patches/): a node with an id
// never stands in for a node with another id, equal ids anchor the diff, and attributes this
// schema does not know are kept.
import { Extension, type AnyExtension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
  absolutePositionToRelativePosition,
  redo,
  relativePositionToAbsolutePosition,
  undo,
  yUndoPluginKey,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yXmlFragmentToProsemirrorJSON,
  prosemirrorJSONToYXmlFragment,
} from '@tiptap/y-tiptap';
import type { Schema } from '@tiptap/pm/model';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import { moveIntentPlugin } from './moves';

/** True for a transaction the binding made from a change that came from Yjs. */
export function isRemoteChange(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

export interface BindingOptions {
  fragment: Y.XmlFragment;
  /** The binding found content the schema cannot hold; it stops syncing that client (S1, S7). */
  onInvalidContent?: (error: Error) => void;
}

/**
 * The sync plugin, undo through Yjs (only this client's changes), the undo keys, and the move
 * intent (moves.ts), written in the same Yjs transaction as the move it records.
 */
export function yjsBinding({ fragment, onInvalidContent }: BindingOptions): AnyExtension {
  return Extension.create({
    name: 'cgwYjs',
    priority: 1000,
    addProseMirrorPlugins: () => [
      ySyncPlugin(fragment, { onInvalidContent: onInvalidContent ?? (() => {}) }),
      yUndoPlugin(),
      moveIntentPlugin(fragment, isRemoteChange),
    ],
    // Always handled: the browser's own undo would edit the DOM behind ProseMirror's back.
    addKeyboardShortcuts: () => ({
      'Mod-z': ({ editor }) => (undo(editor.state), true),
      'Mod-y': ({ editor }) => (redo(editor.state), true),
      'Mod-Shift-z': ({ editor }) => (redo(editor.state), true),
    }),
  });
}

export const undoCommand = (state: EditorState): boolean => undo(state) === true;
export const redoCommand = (state: EditorState): boolean => redo(state) === true;

/** Whether there is anything to undo or redo, for menus. */
export function undoDepth(state: EditorState): { undo: number; redo: number } {
  const manager = yUndoPluginKey.getState(state)?.undoManager as
    { undoStack: unknown[]; redoStack: unknown[] } | undefined;
  return { undo: manager?.undoStack.length ?? 0, redo: manager?.redoStack.length ?? 0 };
}

/** The ProseMirror JSON a Yjs fragment holds, read without an editor (export, search, history). */
export function fragmentToJSON(fragment: Y.XmlFragment): DocJSON {
  return yXmlFragmentToProsemirrorJSON(fragment) as DocJSON;
}

/** Writes ProseMirror JSON into an empty fragment, as one local change (first run, import). */
export function writeJSON(fragment: Y.XmlFragment, schema: Schema, json: DocJSON): void {
  prosemirrorJSONToYXmlFragment(schema, json, fragment);
}

export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** The sync plugin's state, once the binding has drawn the fragment (its mapping holds it). */
function boundState(state: EditorState) {
  const sync = ySyncPluginKey.getState(state);
  return sync && sync.binding.mapping.size > 0 ? sync : null;
}

/**
 * A ProseMirror position as a Yjs relative position (`Y.encodeRelativePosition`, base64), through
 * the binding's mapping, so it keeps its place as the document changes on any client: presence's
 * cursors and a comment's anchor (Phase 6). The binding's own position sticks to the character
 * before it; inside text, `assoc` 0 makes it stick to the character after it instead (a comment's
 * start, so text typed just before the range stays out of it). Null when the editor is not bound
 * to Yjs or the position cannot be named.
 *
 * Read it after the binding has written the editor's latest change to Yjs (a plugin view's
 * `update`, after the sync plugin's), never inside a transaction's `apply`.
 */
export function relativePosition(state: EditorState, pos: number, assoc?: number): string | null {
  const sync = boundState(state);
  if (!sync || pos < 0 || pos > state.doc.content.size) return null;
  try {
    let relative = absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping);
    if (assoc !== undefined) {
      const at = Y.createAbsolutePositionFromRelativePosition(relative, sync.doc);
      if (at && at.type instanceof Y.XmlText)
        relative = Y.createRelativePositionFromTypeIndex(at.type, at.index, assoc);
    }
    return toBase64(Y.encodeRelativePosition(relative));
  } catch {
    return null;
  }
}

/**
 * Where a relative position made by `relativePosition` (on any client) is in this editor's
 * document now, or null: not bound, not decodable, or its place is gone (the text it stuck to was
 * deleted with its block, or the block was moved, which writes it anew).
 */
export function absolutePosition(state: EditorState, encoded: string): number | null {
  const sync = boundState(state);
  if (!sync || !encoded) return null;
  try {
    const relative = Y.decodeRelativePosition(fromBase64(encoded));
    const pos = relativePositionToAbsolutePosition(
      sync.doc,
      sync.type,
      relative,
      sync.binding.mapping,
    );
    return pos === null || pos < 0 || pos > state.doc.content.size ? null : pos;
  } catch {
    return null;
  }
}

/** Ends the current undo group, so the next change is an undo step of its own (a restore). */
export function stopUndoCapturing(state: EditorState): void {
  const manager = yUndoPluginKey.getState(state)?.undoManager as
    { stopCapturing(): void } | undefined;
  manager?.stopCapturing();
}
