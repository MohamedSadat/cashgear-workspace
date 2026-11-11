// A minimal block handle for spike S5: a widget at the start of each top-level block, placed
// with logical CSS so it sits on the right in RTL. The real one (Track U3) replaces it.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

const key = new PluginKey('cgwHandle');

function decorations(doc: PMNode): DecorationSet {
  const list: Decoration[] = [];
  doc.forEach((block, offset) => {
    list.push(
      Decoration.widget(
        offset + 1,
        () => {
          const handle = document.createElement('span');
          handle.className = 'cgw-handle';
          handle.contentEditable = 'false';
          handle.setAttribute('role', 'button');
          handle.setAttribute('aria-label', 'Block menu');
          handle.textContent = '⠿';
          return handle;
        },
        { side: -1, key: `h${block.attrs.id}` },
      ),
    );
  });
  return DecorationSet.create(doc, list);
}

export const BlockHandle = Extension.create({
  name: 'blockHandle',
  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (_, state) => decorations(state.doc),
        apply: (tr, set) => (tr.docChanged ? decorations(tr.doc) : set),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
});
