// What presence's cursors and comments' highlights share (Phase 6): decorations drawn from Yjs
// relative positions the host holds. They are made again only when their source says it changed
// (the host's `subscribe`), when a change came from Yjs (the binding has just mapped it, so the
// positions resolve against the document the transaction made), and after a local change that was
// more than typing: the binding writes a local change to Yjs in its view update, after the
// transaction, so such a change marks them stale and the plugin view asks again a moment later.
// Typing maps them (S6: nothing is made again per keystroke).
import { isRemoteChange, textOnlyChange } from '@cgw/doc';
import type { PluginKey, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export type SourcedStep = 'compute' | 'map' | 'keep';

/** What a transaction means for decorations drawn from relative positions. */
export function sourcedStep(tr: Transaction, key: PluginKey): SourcedStep {
  if (tr.getMeta(key) || isRemoteChange(tr)) return 'compute';
  return tr.docChanged ? 'map' : 'keep';
}

/** Whether a local change mapped the decorations past what mapping can keep right. */
export const staleAfter = (tr: Transaction): boolean => !textOnlyChange(tr);

/**
 * Asks the plugin for its decorations again, once, in a microtask: never inside another
 * transaction or a plugin view's update, and after the binding has written the latest change.
 */
export function refresher(view: EditorView, key: PluginKey): () => void {
  let queued = false;
  return () => {
    if (queued || view.isDestroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
    });
  };
}
