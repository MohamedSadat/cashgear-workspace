// The slash menu's state: typing `/` at the start of a block or after a space opens it; the text
// typed after it filters the commands; Escape, a click elsewhere or moving the caret out closes
// it. The list itself comes from the shell's command registry (host.slash), drawn by SlashMenu.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface SlashState {
  active: boolean;
  /** Position of the `/`. */
  from: number;
  query: string;
}

export const slashKey = new PluginKey<SlashState>('cgwSlash');
const closed: SlashState = { active: false, from: -1, query: '' };

/** The menu's keyboard, set by the menu while it is open. */
export interface SlashKeys {
  onKey(event: KeyboardEvent): boolean;
}

export function slashState(state: EditorState): SlashState {
  return slashKey.getState(state) ?? closed;
}

export function closeSlash(view: EditorView) {
  if (slashState(view.state).active) view.dispatch(view.state.tr.setMeta(slashKey, closed));
}

/** Deletes the `/query` text: the chosen command then acts on a clean block. */
export function removeSlashText(view: EditorView) {
  const { from, active } = slashState(view.state);
  if (!active) return;
  const to = view.state.selection.from;
  view.dispatch(view.state.tr.delete(from, to).setMeta(slashKey, closed));
}

/** Opens the menu at the caret as typing `/` would (the touch toolbar's insert button). */
export function openSlash(view: EditorView): boolean {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
  const tr = view.state.tr;
  if (before && !/s/.test(before)) tr.insertText(' ');
  const from = tr.selection.from;
  tr.insertText('/').setMeta(slashKey, { active: true, from, query: '' });
  view.dispatch(tr);
  return true;
}

export const SlashCommands = Extension.create<{ keys: () => SlashKeys | null }>({
  name: 'cgwSlash',
  // Before the block keys: Enter and the arrows belong to the menu while it is open.
  priority: 2000,
  addOptions: () => ({ keys: () => null }),
  addProseMirrorPlugins() {
    const keys = this.options.keys;
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => closed,
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(slashKey) as SlashState | undefined;
            if (meta) return meta;
            if (!value.active) return value;
            const from = tr.mapping.map(value.from);
            const { $from, empty } = state.selection;
            // The caret left the query, or the slash itself was deleted.
            if (!empty || $from.pos <= from || state.doc.textBetween(from, from + 1) !== '/')
              return closed;
            if ($from.pos - from > 40 || !$from.sameParent(state.doc.resolve(from))) return closed;
            const query = state.doc.textBetween(from + 1, $from.pos);
            if (/\s{2}/.test(query) || query.startsWith(' ')) return closed;
            return { active: true, from, query };
          },
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== '/' || slashState(view.state).active) return false;
            const $from = view.state.doc.resolve(from);
            if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
            const before = $from.parent.textBetween(
              Math.max(0, $from.parentOffset - 1),
              $from.parentOffset,
            );
            if (before && !/\s/.test(before)) return false;
            const tr = view.state.tr.insertText('/', from, to);
            tr.setMeta(slashKey, { active: true, from, query: '' });
            view.dispatch(tr);
            return true;
          },
          handleKeyDown(view, event) {
            if (!slashState(view.state).active) return false;
            if (event.key === 'Escape') {
              closeSlash(view);
              return true;
            }
            return keys()?.onKey(event) ?? false;
          },
          handleDOMEvents: {
            blur: (view) => {
              // A click on the menu itself keeps focus (mousedown is prevented there).
              setTimeout(() => !view.isDestroyed && !view.hasFocus() && closeSlash(view), 150);
              return false;
            },
          },
        },
      }),
    ];
  },
});
