// Block selection (ARCHITECTURE.md, Keyboard): Esc selects the block holding the caret;
// Shift+Up and Down extend over its siblings; then Delete removes, Ctrl+D duplicates,
// Alt+Shift+Up and Down move, Tab and Shift+Tab indent and outdent, Ctrl+C and Ctrl+X copy and
// cut, Enter goes back to editing. The selected blocks carry a class: a few decorations, only
// while a selection exists.
import { Extension } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  blockAt,
  blockInfoAt,
  duplicateBlock,
  firstBody,
  indent,
  moveSibling,
  outdent,
  siblingRange,
  withoutIds,
} from './blocks';

export interface BlockSelectionState {
  anchor: number;
  head: number;
}

export const blockSelectionKey = new PluginKey<BlockSelectionState | null>('cgwBlockSelection');

export function selectedBlocks(state: EditorState) {
  const sel = blockSelectionKey.getState(state);
  return sel ? siblingRange(state, sel.anchor, sel.head) : [];
}

function setSelection(
  view: EditorView,
  sel: BlockSelectionState | null,
  tr: Transaction = view.state.tr,
) {
  tr.setMeta(blockSelectionKey, sel ?? 'clear');
  if (sel) {
    const node = tr.doc.nodeAt(sel.head);
    if (node) tr.setSelection(NodeSelection.create(tr.doc, sel.head));
  }
  view.dispatch(tr.scrollIntoView());
}

/** Selects the block holding the caret (Esc). */
export function selectCurrentBlock(view: EditorView): boolean {
  const { selection } = view.state;
  const block =
    selection instanceof NodeSelection && selection.node.type.name === 'block'
      ? blockInfoAt(view.state.doc, selection.from)
      : blockAt(selection.$from);
  if (!block) return false;
  setSelection(view, { anchor: block.pos, head: block.pos });
  return true;
}

function sibling(state: EditorState, pos: number, direction: -1 | 1): number | null {
  const block = blockInfoAt(state.doc, pos);
  if (!block) return null;
  const parent = block.parentPos < 0 ? state.doc : state.doc.nodeAt(block.parentPos)!;
  const index = block.index + direction;
  if (index < 0 || index >= parent.childCount) return null;
  const node = parent.child(index);
  if (node.type.name !== 'block') return null;
  return direction < 0 ? pos - node.nodeSize : pos + block.node.nodeSize;
}

function serialiseRange(state: EditorState) {
  const blocks = selectedBlocks(state);
  return new Slice(Fragment.from(blocks.map((b) => b.node)), 0, 0);
}

export const BlockSelection = Extension.create({
  name: 'cgwBlockSelection',
  priority: 1500,
  addProseMirrorPlugins() {
    return [
      new Plugin<BlockSelectionState | null>({
        key: blockSelectionKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockSelectionKey) as BlockSelectionState | 'clear' | undefined;
            if (meta === 'clear') return null;
            if (meta) return meta;
            if (!value) return null;
            // A text selection or typing ends block selection.
            if (tr.selectionSet && !(tr.selection instanceof NodeSelection)) return null;
            if (!tr.docChanged) return value;
            const anchor = tr.mapping.mapResult(value.anchor);
            const head = tr.mapping.mapResult(value.head);
            if (anchor.deleted || head.deleted) return null;
            return { anchor: anchor.pos, head: head.pos };
          },
        },
        props: {
          decorations(state) {
            const blocks = selectedBlocks(state);
            if (!blocks.length) return null;
            return DecorationSet.create(
              state.doc,
              blocks.map((b) =>
                Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: 'is-block-selected' }),
              ),
            );
          },
          handleKeyDown(view, event) {
            const sel = blockSelectionKey.getState(view.state);
            if (!sel) {
              if (
                event.key === 'Escape' &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              )
                return selectCurrentBlock(view);
              return false;
            }
            const { state } = view;
            const mod = event.ctrlKey || event.metaKey;
            const blocks = selectedBlocks(state);
            const first = blocks[0];
            const last = blocks[blocks.length - 1];
            if (!first) return false;
            const run = (make: (s: EditorState) => Transaction | null, keep = true) => {
              const tr = make(state);
              event.preventDefault();
              if (!tr) return true;
              if (keep) {
                // Keep the moved blocks selected where they went.
                const pos = tr.mapping.map(first.pos, 1);
                const node = tr.doc.nodeAt(pos);
                const at = node?.type.name === 'block' ? pos : tr.mapping.map(first.pos, -1);
                setSelection(view, { anchor: at, head: at }, tr);
              } else setSelection(view, null, tr);
              return true;
            };
            switch (event.key) {
              case 'Escape':
                setSelection(
                  view,
                  null,
                  state.tr.setSelection(TextSelection.near(state.doc.resolve(first.pos + 2))),
                );
                return true;
              case 'Enter': {
                const body = firstBody(last);
                const at =
                  body && body.node.isTextblock
                    ? body.pos + 1 + body.node.content.size
                    : last.pos + 2;
                setSelection(
                  view,
                  null,
                  state.tr.setSelection(TextSelection.near(state.doc.resolve(at))),
                );
                return true;
              }
              case 'Backspace':
              case 'Delete': {
                const tr = state.tr.delete(first.pos, last.pos + last.node.nodeSize);
                setSelection(
                  view,
                  null,
                  tr.setSelection(
                    TextSelection.near(tr.doc.resolve(Math.min(first.pos, tr.doc.content.size))),
                  ),
                );
                event.preventDefault();
                return true;
              }
              case 'ArrowUp':
              case 'ArrowDown': {
                const direction = event.key === 'ArrowUp' ? -1 : 1;
                if (event.altKey && event.shiftKey) {
                  if (blocks.length !== 1) return true;
                  return run((s) => moveSibling(s, first, direction));
                }
                const next = sibling(state, sel.head, direction);
                event.preventDefault();
                if (next === null) return true;
                setSelection(view, { anchor: event.shiftKey ? sel.anchor : next, head: next });
                return true;
              }
              case 'Tab':
                if (blocks.length !== 1) return true;
                return run((s) => (event.shiftKey ? outdent(s, first) : indent(s, first)));
              default:
                break;
            }
            if (mod && event.code === 'KeyD') return run((s) => duplicateBlock(s, last), false);
            if (mod && event.code === 'KeyA') {
              const parent = first.parentPos < 0 ? state.doc : state.doc.nodeAt(first.parentPos)!;
              const start = first.parentPos < 0 ? 0 : first.parentPos + 1;
              let end = start;
              parent.forEach((child, offset) => {
                if (child.type.name === 'block') end = start + offset;
              });
              setSelection(view, {
                anchor:
                  start +
                  (parent.firstChild?.type.name === 'block' ? 0 : parent.firstChild!.nodeSize),
                head: end,
              });
              event.preventDefault();
              return true;
            }
            if (event.key.length === 1 && !mod) {
              // Typing replaces nothing: leave block selection for the first block's text.
              setSelection(
                view,
                null,
                state.tr.setSelection(TextSelection.near(state.doc.resolve(first.pos + 2))),
              );
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** For the clipboard: a block selection copies its blocks; a paste mints new ids. */
export function blockSelectionSlice(state: EditorState): Slice | null {
  if (!blockSelectionKey.getState(state)) return null;
  const slice = serialiseRange(state);
  return new Slice(Fragment.from(slice.content.content.map(withoutIds)), 0, 0);
}
