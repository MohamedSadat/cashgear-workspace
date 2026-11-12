// Date mentions (schema version 3): an inline atom holding a date as a database date value's start
// (`@cgw/doc` dates.ts), with an optional end. Drawn in the interface language; inserted from the
// "@" menu (Today, Tomorrow, Pick a date); clicking one, or Enter on a selected one, opens the date
// picker when the page is editable (ui/DatePicker.tsx). The document keeps the stored form only.
import { Extension, type NodeViewRenderer } from '@tiptap/core';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isDateValue } from '@cgw/doc';
import type { EditorHost, OnHostChange } from './host';

/** What the overlays give the editor's date mentions: the picker, while it is drawn. */
export interface DateUi {
  openDatePicker: ((pos: number, anchor: HTMLElement) => void) | null;
}

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A date value as a Date, and whether it is a calendar date (drawn in UTC) or an instant. */
function parse(value: string): { at: Date; day: boolean } | null {
  const day = DAY.exec(value);
  const at = day
    ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])))
    : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  if (day) at.setUTCFullYear(Number(day[1])); // Years below 100 are not 19xx.
  return { at, day: !!day };
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string | undefined, day: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${day}`;
  let made = formats.get(key);
  if (!made) {
    try {
      made = new Intl.DateTimeFormat(
        locale,
        day
          ? { dateStyle: 'medium', timeZone: 'UTC' }
          : { dateStyle: 'medium', timeStyle: 'short' },
      );
    } catch {
      made = new Intl.DateTimeFormat(undefined, day ? { timeZone: 'UTC' } : {});
    }
    formats.set(key, made);
  }
  return made;
}

/** The interface language dates are drawn in. */
export const localeOf = (host: EditorHost) =>
  host.locale || document.documentElement.lang || undefined;

/**
 * A date mention as the interface language writes it: a calendar date as that day (whatever the
 * device's time zone), an instant in the device's time zone, a span as the language writes a
 * span. Null when the stored date is not a date.
 */
export function formatDateMention(
  attrs: Record<string, unknown>,
  locale: string | undefined,
): string | null {
  if (!isDateValue(attrs.date)) return null;
  const start = parse(attrs.date);
  if (!start) return null;
  const end = isDateValue(attrs.end) ? parse(attrs.end) : null;
  const shown = format(locale, start.day);
  if (!end) return shown.format(start.at);
  if (end.day === start.day && typeof shown.formatRange === 'function')
    return shown.formatRange(start.at, end.at);
  return `${shown.format(start.at)} – ${format(locale, end.day).format(end.at)}`;
}

/**
 * Puts a date in place of a range (the `@query`, or the selection), with a space after it, in one
 * transaction (`extra` adds to it). Returns where the date is.
 */
export function insertDateMention(
  view: EditorView,
  range: { from: number; to: number },
  date: string,
  extra: (tr: Transaction) => Transaction = (tr) => tr,
): number {
  const node = view.state.schema.nodes.dateMention.create({ date });
  const tr = view.state.tr.replaceWith(range.from, range.to, node).insertText(' ');
  view.dispatch(extra(tr).scrollIntoView());
  return range.from;
}

/** Opens the picker for the date mention at `pos`, when the page is editable. */
export function openDatePicker(view: EditorView, ui: DateUi, pos: number): boolean {
  if (!view.editable || !ui.openDatePicker) return false;
  const node = view.state.doc.nodeAt(pos);
  const dom = view.nodeDOM(pos);
  if (node?.type.name !== 'dateMention' || !(dom instanceof HTMLElement)) return false;
  ui.openDatePicker(pos, dom);
  return true;
}

/** Enter on a selected date opens its picker. */
export const DateMentions = Extension.create<{ ui: () => DateUi }>({
  name: 'cgwDateMentions',
  // Before the block keys, whose Enter splits the block.
  priority: 1000,
  addOptions: () => ({ ui: () => ({ openDatePicker: null }) }),
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'dateMention')
          return false;
        return openDatePicker(editor.view, this.options.ui(), selection.from);
      },
    };
  },
});

/** The date, drawn now in the interface language; a click opens the picker when editable. */
export function dateMentionView(
  host: () => EditorHost,
  ui: () => DateUi,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = document.createElement('span');
    dom.className = 'cgw-date-mention';
    dom.contentEditable = 'false';
    // Isolated: a date in the interface's script inside text of the other direction.
    dom.dir = 'auto';
    let drawn = '';
    const draw = () => {
      // Editable, it opens the date picker.
      if (editor.isEditable) dom.setAttribute('aria-haspopup', 'dialog');
      else dom.removeAttribute('aria-haspopup');
      const locale = localeOf(host());
      const key = `${String(node.attrs.date)}|${String(node.attrs.end)}|${locale ?? ''}`;
      if (key === drawn) return;
      drawn = key;
      const text = formatDateMention(node.attrs, locale);
      dom.textContent = text ?? host().strings?.dateInvalid ?? '';
      dom.dataset.invalid = String(text === null);
      if (isDateValue(node.attrs.date)) dom.dataset.date = node.attrs.date;
      else delete dom.dataset.date;
    };
    dom.addEventListener('click', (event) => {
      if (!editor.isEditable || typeof getPos !== 'function') return;
      const pos = getPos();
      if (pos === undefined) return;
      event.preventDefault();
      openDatePicker(editor.view, ui(), pos);
    });
    // Another host: perhaps another interface language (drawn again only if it is).
    const unsubscribe = onHostChange(draw);
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
      destroy: unsubscribe,
    };
  };
}
