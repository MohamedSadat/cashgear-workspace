// The Yjs seam (D5): the editor sees one function; which binding sits behind it is a choice.
//   tiptap-ids: the product's binding, from @cgw/doc: Tiptap's fork @tiptap/y-tiptap with the
//               Q18 patch (patches/), so every run tests what ships
//   upstream:   y-prosemirror 1.x's sync and undo plugins, kept for S1's comparison runs
// Phase 0 also ran the fork without the patch ("tiptap"); with the patch installed that is the
// same code, so its numbers stay in DECISIONS.md (2026-11-11: Phase 0 results).
import { Extension, type AnyExtension } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPlugin, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror';
import type * as Y from 'yjs';
import { isRemoteChange as isRemoteFork, yjsBinding } from '@cgw/doc';

export type BindingKind = 'tiptap-ids' | 'upstream';

export function isRemoteChange(kind: BindingKind, tr: Transaction): boolean {
  if (kind === 'tiptap-ids') return isRemoteFork(tr);
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

export function yjsExtension(
  kind: BindingKind,
  fragment: Y.XmlFragment,
  onInvalidContent: (error: Error) => void,
): AnyExtension {
  if (kind === 'tiptap-ids') return yjsBinding({ fragment, onInvalidContent });
  return Extension.create({
    name: 'upstreamYjs',
    addProseMirrorPlugins: () => [ySyncPlugin(fragment), yUndoPlugin()],
  });
}
