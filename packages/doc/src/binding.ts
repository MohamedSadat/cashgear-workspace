// The Yjs seam (D5): everything above sees these functions, never the binding behind them. Today
// that is Tiptap's fork, @tiptap/y-tiptap, carrying the Q18 patch (patches/): a node with an id
// never stands in for a node with another id, equal ids anchor the diff, and attributes this
// schema does not know are kept.
import { Extension, type AnyExtension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
  redo,
  undo,
  yUndoPluginKey,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yXmlFragmentToProsemirrorJSON,
  prosemirrorJSONToYXmlFragment,
} from '@tiptap/y-tiptap';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

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

/** The sync plugin, undo through Yjs (only this client's changes), and the undo keys. */
export function yjsBinding({ fragment, onInvalidContent }: BindingOptions): AnyExtension {
  return Extension.create({
    name: 'cgwYjs',
    priority: 1000,
    addProseMirrorPlugins: () => [
      ySyncPlugin(fragment, { onInvalidContent: onInvalidContent ?? (() => {}) }),
      yUndoPlugin(),
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
