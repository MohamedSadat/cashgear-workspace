// Mentions: typing `@` opens a picker at the caret. A chosen person (schema version 5) goes in as
// a userMention holding their user id, their name drawn from the host; a chosen page as a
// pageMention holding its id, its title drawn from the host (D6); a chosen date (schema version 3)
// as a dateMention holding the date (dates.ts).
import { Extension, type NodeViewRenderer } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { localDate } from '@cgw/doc';
import { insertDateMention, openDatePicker, type DateUi } from './dates';
import { editorString, type EditorHost, type OnHostChange, type SlashItem } from './host';
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

/** Replaces `@query` with a mention of the page, or (`person`) of the person. */
export function insertMention(view: EditorView, id: string, person = false) {
  const { from, active } = mentionState(view.state);
  if (!active) return;
  const { schema } = view.state;
  const node = person
    ? schema.nodes.userMention.create({ userId: id })
    : schema.nodes.pageMention.create({ pageId: id });
  const tr = view.state.tr.replaceWith(from, view.state.selection.from, node).insertText(' ');
  view.dispatch(tr.setMeta(mentionKey, closed).scrollIntoView());
  view.focus();
}

/** A person's item id in the "@" menu: pages and people both have UUIDs. */
const PERSON = 'person:';

/** The "@" menu's date items: today and tomorrow on this device, or a date from the picker. */
const DATE_ITEMS = [
  { id: 'date:today', days: 0, label: 'dateToday', glyph: '📅', words: ['today', 'date', 'now'] },
  { id: 'date:tomorrow', days: 1, label: 'dateTomorrow', glyph: '📅', words: ['tomorrow', 'date'] },
  { id: 'date:pick', days: 0, label: 'datePick', glyph: '🗓', words: ['date', 'pick', 'calendar'] },
] as const;

/** Lower case, without Arabic diacritics and tatweel, for matching what is typed after `@`. */
const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .trim();

/**
 * What the "@" menu lists for a query: people whose name or address starts with it (from the
 * host, which folds both), pages whose titles match (from the host), and the dates whose names
 * (in the interface language, or in English) start with it. People come first; then the pages,
 * unless a date's name was typed, when the dates come before them. Groups are named when more
 * than one kind is listed.
 */
export function mentionItems(host: EditorHost, query: string): SlashItem[] {
  const strings = host.strings;
  const typed = fold(query);
  const dates: SlashItem[] = DATE_ITEMS.filter(
    (item) =>
      !typed ||
      [...fold(strings?.[item.label] ?? '').split(/\s+/), ...item.words].some((word) =>
        word.startsWith(typed),
      ),
  ).map((item) => ({
    id: item.id,
    label: strings?.[item.label] ?? item.label,
    glyph: item.glyph,
    group: strings?.mentionDates,
  }));
  const found = (host.people?.search(query) ?? []).slice(0, 8);
  const pageList = (host.pages?.search(query) ?? []).slice(0, 12);
  const people: SlashItem[] = found.map((person) => ({
    id: `${PERSON}${person.id}`,
    label: person.name || editorString(host, 'someone'),
    glyph: '👤',
    group: dates.length || pageList.length ? editorString(host, 'mentionPeople') : undefined,
  }));
  const pages: SlashItem[] = pageList.map((page) => ({
    id: page.id,
    label: page.title || (strings?.untitled ?? ''),
    glyph: page.icon ?? '📄',
    group: dates.length || people.length ? strings?.mentionPages : undefined,
  }));
  return typed && dates.length ? [...people, ...dates, ...pages] : [...people, ...pages, ...dates];
}

/** Puts the chosen item in place of `@query`: a page mention, or a date (and its picker). */
export function chooseMention(view: EditorView, ui: DateUi, id: string): void {
  const { from, active } = mentionState(view.state);
  if (!active) return;
  if (id.startsWith(PERSON)) {
    insertMention(view, id.slice(PERSON.length), true);
    return;
  }
  const item = DATE_ITEMS.find((d) => d.id === id);
  if (!item) {
    insertMention(view, id);
    return;
  }
  const range = { from, to: view.state.selection.from };
  const at = insertDateMention(view, range, localDate(item.days), (tr) =>
    tr.setMeta(mentionKey, closed),
  );
  view.focus();
  // "Pick a date" goes in as today, then asks.
  if (item.id === 'date:pick') openDatePicker(view, ui, at);
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

/**
 * A person's mention: `@` and their name from the host now, `@` and "someone" when the host
 * cannot name them. Drawn again when the host's people change (or another host is given), only
 * if the name it shows changed; never per transaction.
 */
export function userMentionView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return ({ node: initial }) => {
    let node = initial;
    const dom = document.createElement('span');
    dom.className = 'cgw-user-mention';
    dom.contentEditable = 'false';
    // Isolated: a name in one script inside text of the other direction.
    dom.dir = 'auto';
    let drawn: string | null = null;
    const draw = () => {
      const current = host();
      const userId = typeof node.attrs.userId === 'string' ? node.attrs.userId : null;
      const name = userId ? current.people?.name(userId) : undefined;
      const text = `@${name || editorString(current, 'someone')}`;
      if (text === drawn) return;
      drawn = text;
      dom.textContent = text;
      dom.dataset.userId = userId ?? '';
      dom.dataset.unknown = String(!name);
    };
    let unsubscribe = host().people?.subscribe(draw);
    const offHost = onHostChange(() => {
      unsubscribe?.();
      unsubscribe = host().people?.subscribe(draw);
      draw();
    });
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        const changed = next.attrs.userId !== node.attrs.userId;
        node = next;
        if (changed) draw();
        return true;
      },
      ignoreMutation: () => true,
      destroy() {
        unsubscribe?.();
        offHost();
      },
    };
  };
}
