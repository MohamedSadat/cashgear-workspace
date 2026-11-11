// The editor's keys (ARCHITECTURE.md, "Keyboard"). ProseMirror's keymap falls back to the key's
// position when a modifier is held on a non-Latin layout, so Mod-b is the same key in Arabic.
import { Extension } from '@tiptap/core';
import { newBlockId } from '@cgw/doc';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  blockAt,
  currentBlock,
  duplicateBlock,
  firstBody,
  indent,
  mergeBackward,
  mergeForward,
  moveSibling,
  outdent,
  splitBlock,
} from './blocks';
import type { HandleUi } from './handle';
import type { EditorHost } from './host';

export const BlockKeymap = Extension.create<{ host: () => EditorHost; ui: () => HandleUi }>({
  name: 'cgwBlockKeymap',
  priority: 900,
  addOptions: () => ({ host: () => ({}) as EditorHost, ui: () => ({ openBlockMenu: null }) }),
  addKeyboardShortcuts() {
    const host = () => this.options.host();
    const run = (make: () => ReturnType<typeof splitBlock>) => {
      const tr = make();
      if (!tr) return false;
      this.editor.view.dispatch(tr.scrollIntoView());
      return true;
    };
    const selected = () => currentBlock(this.editor.state);
    return {
      Enter: ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name === 'codeBlock') return false;
        return run(() => splitBlock(editor.state, (id) => host().toggles?.isOpen(id) ?? true));
      },
      'Shift-Enter': ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name !== 'textBody' && $from.parent.type.name !== 'tableCell')
          return false;
        return editor.commands.insertContent({ type: 'hardBreak' });
      },
      'Mod-Enter': ({ editor }) => {
        const block = selected();
        if (!block) return false;
        const body = firstBody(block);
        if (!body) return false;
        if (body.node.type.name === 'codeBlock') {
          // Leave the code block for a new paragraph below.
          const tr = editor.state.tr.insert(
            block.pos + block.node.nodeSize,
            editor.schema.nodes.block.create(
              { id: newBlockId() },
              editor.schema.nodes.textBody.create(),
            ),
          );
          tr.setSelection(TextSelection.create(tr.doc, block.pos + block.node.nodeSize + 2));
          editor.view.dispatch(tr);
          return true;
        }
        if (body.node.attrs.kind === 'checkItem') {
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(body.pos, undefined, {
              ...body.node.attrs,
              checked: !body.node.attrs.checked,
            }),
          );
          return true;
        }
        if (body.node.attrs.kind === 'toggle' && block.id) {
          host().toggles?.flip(block.id);
          return true;
        }
        return false;
      },
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (selection instanceof NodeSelection && selection.node.type.spec.group === 'body') {
          const block = blockAt(editor.state.doc.resolve(selection.from));
          if (block) {
            editor.view.dispatch(
              editor.state.tr.delete(block.pos, block.pos + block.node.nodeSize),
            );
            return true;
          }
        }
        return run(() => mergeBackward(editor.state));
      },
      Delete: ({ editor }) => run(() => mergeForward(editor.state)),
      Tab: ({ editor }) => {
        if (editor.isActive('tableCell')) return false;
        const block = selected();
        return block ? run(() => indent(editor.state, block)) || true : false;
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('tableCell')) return false;
        const block = selected();
        return block ? run(() => outdent(editor.state, block)) || true : false;
      },
      'Alt-Shift-ArrowUp': ({ editor }) => {
        const block = selected();
        return block ? run(() => moveSibling(editor.state, block, -1)) || true : false;
      },
      'Alt-Shift-ArrowDown': ({ editor }) => {
        const block = selected();
        return block ? run(() => moveSibling(editor.state, block, 1)) || true : false;
      },
      'Mod-d': ({ editor }) => {
        const block = selected();
        return block ? run(() => duplicateBlock(editor.state, block)) : false;
      },
      'Mod-b': ({ editor }) => editor.commands.toggleMark('bold'),
      'Mod-i': ({ editor }) => editor.commands.toggleMark('italic'),
      'Mod-u': ({ editor }) => editor.commands.toggleMark('underline'),
      'Mod-Shift-s': ({ editor }) => editor.commands.toggleMark('strike'),
      'Mod-Shift-x': ({ editor }) => editor.commands.toggleMark('strike'),
      'Mod-e': ({ editor }) => editor.commands.toggleMark('code'),
      'Mod-k': () => {
        host().onLinkRequest?.();
        return !!host().onLinkRequest;
      },
      'Mod-/': ({ editor }) => {
        const block = selected();
        const open = this.options.ui().openBlockMenu;
        if (!block || !open) return false;
        const at = editor.view.coordsAtPos(Math.min(block.pos + 2, editor.state.doc.content.size));
        open(
          block.pos,
          new DOMRect(at.left, at.top, Math.max(1, at.right - at.left), at.bottom - at.top),
        );
        return true;
      },
    };
  },
});
