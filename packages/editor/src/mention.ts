// Page mentions: typing `@` opens a page picker at the caret; the chosen page goes in as a
// pageMention node holding its id, and its title is drawn from the host (D6).
import { Extension, type NodeViewRenderer } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { EditorHost } from './host';
import type { SlashKeys } from './slash';

export interface MentionState {
  active: boolean;
  from: number;
  query: string;
}

export const mentionKey = new PluginKey<MentionState>('cgwMention');
const closed: MentionState = { active: false, from: -1, query: '' };

export const mentionState = (state: EditorState) => mentionKey.getState(state) ?? closed;

export function closeMention(view: EditorView) {
  if (mentionState(view.state).active) view.dispatch(view.state.tr.setMeta(mentionKey, closed));
}

/** Replaces `@query` with a mention of the page. */
export function insertMention(view: EditorView, pageId: string) {
  const { from, active } = mentionState(view.state);
  if (!active) return;
  const node = view.state.schema.nodes.pageMention.create({ pageId });
  const tr = view.state.tr.replaceWith(from, view.state.selection.from, node).insertText(' ');
  view.dispatch(tr.setMeta(mentionKey, closed).scrollIntoView());
  view.focus();
}

export const Mentions = Extension.create<{ keys: () => SlashKeys | null }>({
  name: 'cgwMentions',
  priority: 2000,
  addOptions: () => ({ keys: () => null }),
  addProseMirrorPlugins() {
    const keys = this.options.keys;
    return [
      new Plugin<MentionState>({
        key: mentionKey,
        state: {
          init: () => closed,
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(mentionKey) as MentionState | undefined;
            if (meta) return meta;
            if (!value.active) return value;
            const from = tr.mapping.map(value.from);
            const { $from, empty } = state.selection;
            if (!empty || $from.pos <= from || state.doc.textBetween(from, from + 1) !== '@')
              return closed;
            if ($from.pos - from > 60 || !$from.sameParent(state.doc.resolve(from))) return closed;
            return { active: true, from, query: state.doc.textBetween(from + 1, $from.pos) };
          },
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== '@' || mentionState(view.state).active) return false;
            const $from = view.state.doc.resolve(from);
            if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
            const before = $from.parent.textBetween(
              Math.max(0, $from.parentOffset - 1),
              $from.parentOffset,
            );
            if (before && !/\s/.test(before)) return false;
            view.dispatch(
              view.state.tr
                .insertText('@', from, to)
                .setMeta(mentionKey, { active: true, from, query: '' }),
            );
            return true;
          },
          handleKeyDown(view, event) {
            if (!mentionState(view.state).active) return false;
            if (event.key === 'Escape') {
              closeMention(view);
              return true;
            }
            return keys()?.onKey(event) ?? false;
          },
        },
      }),
    ];
  },
});

/** The mention as a link that draws the page's icon and title now, or says the page is gone. */
export function pageMentionView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial }) => {
    let node = initial;
    const dom = document.createElement('a');
    dom.className = 'cgw-page-mention';
    dom.contentEditable = 'false';
    const draw = () => {
      const pageId = node.attrs.pageId as string | null;
      const pages = host().pages;
      const exists = !!pageId && !!pages?.exists(pageId);
      dom.href = pageId
        ? `#/p/${pageId}${node.attrs.blockId ? `/${node.attrs.blockId}` : ''}`
        : '#';
      dom.dataset.pageId = pageId ?? '';
      dom.dataset.missing = String(!exists);
      dom.dataset.icon = (pageId && pages?.icon(pageId)) || '📄';
      dom.textContent = exists
        ? pages!.title(pageId!) || (host().strings?.untitled ?? '')
        : (host().strings?.missingPage ?? '');
    };
    dom.addEventListener('click', (event) => {
      event.preventDefault();
      const pageId = node.attrs.pageId as string | null;
      if (pageId && host().pages?.exists(pageId)) host().pages?.open(pageId, node.attrs.blockId);
    });
    const unsubscribe = host().pages?.subscribe(draw);
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      ignoreMutation: () => true,
      destroy: () => unsubscribe?.(),
    };
  };
}
