// The Yjs seam (D5): the editor sees one function; which binding sits behind it is a choice.
//   tiptap:     Tiptap's Collaboration extension on its fork, @tiptap/y-tiptap (Q2's default)
//   tiptap-ids: the same fork with an id-aware reconciliation (vendor/y-tiptap-ids.js)
//   upstream:   y-prosemirror 1.x's sync and undo plugins
import { Extension, type AnyExtension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { ySyncPluginKey as tiptapSyncKey } from '@tiptap/y-tiptap';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPlugin, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror';
import type * as Y from 'yjs';
import * as ids from '../vendor/y-tiptap-ids.js';

export type BindingKind = 'tiptap' | 'tiptap-ids' | 'upstream';

const keyOf = (kind: BindingKind) =>
  kind === 'tiptap' ? tiptapSyncKey : kind === 'tiptap-ids' ? ids.ySyncPluginKey : ySyncPluginKey;

export function isRemoteChange(kind: BindingKind, tr: Transaction): boolean {
  const meta = tr.getMeta(keyOf(kind)) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

export function yjsExtension(
  kind: BindingKind,
  fragment: Y.XmlFragment,
  onInvalidContent: (error: Error) => void,
): AnyExtension {
  if (kind === 'tiptap') return Collaboration.configure({ fragment });
  if (kind === 'tiptap-ids')
    return Extension.create({
      name: 'idAwareYjs',
      addProseMirrorPlugins: () => [
        ids.ySyncPlugin(fragment, { onInvalidContent }),
        ids.yUndoPlugin(),
      ],
    });
  return Extension.create({
    name: 'upstreamYjs',
    addProseMirrorPlugins: () => [ySyncPlugin(fragment), yUndoPlugin()],
  });
}
