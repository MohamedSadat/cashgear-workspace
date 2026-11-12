// Date mentions (schema version 3): the "@" menu's Today, Tomorrow and Pick a date, drawn in the
// interface language (Arabic included, isolated in text of the other direction), the picker opened
// by a click or Enter when the page is editable and never when it is read-only, stored as the
// date value and written as it in text.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
// jsdom lays nothing out: ProseMirror's scroll into view reads a range's rectangles.
const rangeProto = window.Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects ??= () => [];
rangeProto.getBoundingClientRect ??= () => ({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
});
const { pressKey } = await import('./testing');
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { NodeSelection, TextSelection } = await import('@tiptap/pm/state');
const { build, documentSchema, writeJSON, fragmentToJSON, CONTENT, localDate, plainText } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { chooseMention, mentionItems, mentionState } = await import('./mention');
const { formatDateMention } = await import('./dates');
const blocks = await import('./blocks');
const { tocKey } = await import('./toc');
type EditorHost = import('./host').EditorHost;

const { docOf, paragraph, heading, dateMention, block } = build;
const english = {
  mentionPages: 'Pages',
  mentionDates: 'Date',
  dateToday: 'Today',
  dateTomorrow: 'Tomorrow',
  datePick: 'Pick a date',
  dateInvalid: 'No date',
  untitled: 'Untitled',
} as never;
const arabic = {
  mentionPages: 'الصفحات',
  mentionDates: 'التاريخ',
  dateToday: 'اليوم',
  dateTomorrow: 'غدًا',
  datePick: 'اختيار تاريخ',
  dateInvalid: 'بلا تاريخ',
} as never;

const pages = [
  { id: '01936f6e-0000-7000-8000-000000000001', title: 'Today’s plan', icon: null },
  { id: '01936f6e-0000-7000-8000-000000000002', title: 'Notes', icon: '📝' },
];
const pageHost = (strings = english): EditorHost => ({
  strings,
  pages: {
    title: (id) => pages.find((p) => p.id === id)?.title,
    icon: () => null,
    exists: (id) => pages.some((p) => p.id === id),
    open: () => {},
    create: async () => null,
    search: (query) =>
      pages.filter((p) => p.title.toLowerCase().includes(query.toLowerCase().trim())),
    subscribe: () => () => {},
  },
});

function setup(json = docOf(paragraph('Due ')), host: EditorHost = pageHost()) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    schedule: () => {},
  });
  editors.push(be);
  const editor = be.editor;
  const opened: { pos: number; anchor: HTMLElement }[] = [];
  be.ui.openDatePicker = (pos, anchor) => opened.push({ pos, anchor });
  const end = (index = 0) => {
    const body = blocks.firstBody(blocks.listBlocks(editor.state.doc)[index])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, body.pos + 1 + body.node.content.size),
      ),
    );
  };
  /** Types `@` and a query as a browser would, through ProseMirror's text input. */
  const type = (text: string) => {
    for (const char of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (f) =>
        f(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
      );
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  };
  const dates = () => [...element.querySelectorAll<HTMLElement>('.cgw-date-mention')];
  return { doc, be, editor, element, opened, end, type, dates };
}

describe('the "@" menu', () => {
  it('lists pages, then the dates; dates first when a date is typed', () => {
    const host = pageHost();
    expect(mentionItems(host, '').map((i) => [i.label, i.group])).toEqual([
      ['Today’s plan', 'Pages'],
      ['Notes', 'Pages'],
      ['Today', 'Date'],
      ['Tomorrow', 'Date'],
      ['Pick a date', 'Date'],
    ]);
    expect(mentionItems(host, 'tod').map((i) => i.label)).toEqual(['Today', 'Today’s plan']);
    expect(mentionItems(host, 'tomorrow').map((i) => i.id)).toEqual(['date:tomorrow']);
    expect(mentionItems(host, 'date').map((i) => i.id)).toEqual([
      'date:today',
      'date:tomorrow',
      'date:pick',
    ]);
    // Pages only, when no date matches: no group headers.
    expect(mentionItems(host, 'not')).toEqual([
      { id: pages[1].id, label: 'Notes', glyph: '📝', group: undefined },
    ]);
    // Without pages from the host, the dates still show.
    expect(mentionItems({ strings: english }, '').map((i) => i.id)).toEqual([
      'date:today',
      'date:tomorrow',
      'date:pick',
    ]);
  });

  it('finds dates by their names in Arabic, with or without diacritics, and in English', () => {
    const host = pageHost(arabic);
    expect(mentionItems(host, 'غد').map((i) => i.label)).toEqual(['غدًا']);
    expect(mentionItems(host, 'غدا').map((i) => i.label)).toEqual(['غدًا']);
    expect(mentionItems(host, 'اليو').map((i) => i.label)).toEqual(['اليوم']);
    expect(mentionItems(host, 'تاريخ').map((i) => i.id)).toEqual(['date:pick']);
    expect(mentionItems(host, 'tomorrow').map((i) => i.label)).toEqual(['غدًا']);
  });

  it('puts Today and Tomorrow in place of what was typed, as dates of this device', () => {
    const { editor, end, type, doc, opened } = setup();
    end();
    type('@to');
    expect(mentionState(editor.state)).toMatchObject({ active: true, query: 'to' });
    chooseMention(editor.view, { openDatePicker: null }, 'date:today');
    expect(mentionState(editor.state).active).toBe(false);
    type('and ');
    type('@');
    chooseMention(editor.view, { openDatePicker: null }, 'date:tomorrow');
    const json = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(json.content![0].content![0].content).toEqual([
      { type: 'text', text: 'Due ' },
      { type: 'dateMention', attrs: { date: localDate(0) } },
      { type: 'text', text: ' and ' },
      { type: 'dateMention', attrs: { date: localDate(1) } },
      { type: 'text', text: ' ' },
    ]);
    expect(plainText(json)).toBe(`Due ${localDate(0)} and ${localDate(1)} `);
    expect(opened).toEqual([]);
  });

  it('"Pick a date" puts today in and opens the picker on it', () => {
    const { be, editor, end, type, dates } = setup();
    end();
    type('@');
    const opened: { pos: number; anchor: HTMLElement }[] = [];
    chooseMention(
      editor.view,
      { openDatePicker: (pos, anchor) => opened.push({ pos, anchor }) },
      'date:pick',
    );
    expect(opened).toHaveLength(1);
    expect(editor.state.doc.nodeAt(opened[0].pos)?.attrs.date).toBe(localDate(0));
    expect(opened[0].anchor).toBe(dates()[0]);
    expect(be.ui.openDatePicker).not.toBeNull();
  });
});

describe('a date mention', () => {
  it('is drawn in the interface language, a span in the other direction kept apart', () => {
    const json = docOf(
      paragraph(
        'On ',
        dateMention('2026-12-01'),
        ', from ',
        dateMention('2026-12-01', '2026-12-05'),
        ', at ',
        dateMention('2026-11-12T09:30:00Z'),
        ', bad ',
        { type: 'dateMention', attrs: { date: 'soon' } },
      ),
    );
    const english = setup(json, { locale: 'en-GB', strings: { dateInvalid: 'No date' } as never });
    const drawn = english.dates();
    const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
    expect(drawn[0].textContent).toBe('1 Dec 2026');
    expect(drawn[0].dir).toBe('auto');
    expect(drawn[0].dataset.date).toBe('2026-12-01');
    expect(drawn[1].textContent).toBe(
      day.formatRange(new Date(Date.UTC(2026, 11, 1)), new Date(Date.UTC(2026, 11, 5))),
    );
    expect(drawn[2].textContent).toBe(
      new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date('2026-11-12T09:30:00Z'),
      ),
    );
    expect(drawn[3].textContent).toBe('No date');
    expect(drawn[3].dataset.invalid).toBe('true');

    const arabic = setup(json, { locale: 'ar', strings: { dateInvalid: 'بلا تاريخ' } as never });
    expect(arabic.dates()[0].textContent).toBe(
      new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, 11, 1)),
      ),
    );
    expect(arabic.dates()[0].textContent).not.toBe(drawn[0].textContent);
    // The stored form never changes with the language.
    expect(fragmentToJSON(arabic.doc.getXmlFragment(CONTENT))).toEqual(
      fragmentToJSON(english.doc.getXmlFragment(CONTENT)),
    );
  });

  it('a calendar date is that day in every time zone; years below 100 stay themselves', () => {
    expect(formatDateMention({ date: '2026-01-01' }, 'en-GB')).toBe('1 Jan 2026');
    expect(formatDateMention({ date: '0050-03-04' }, 'en-GB')).toBe('4 Mar 50');
    expect(formatDateMention({ date: 'soon' }, 'en-GB')).toBeNull();
    expect(formatDateMention({ date: '2026-12-01', end: 'x' }, 'en-GB')).toBe('1 Dec 2026');
  });

  it('opens the picker on a click or Enter when the page is editable, never when it is not', () => {
    const { editor, dates, opened, be } = setup(docOf(paragraph('On ', dateMention('2026-12-01'))));
    const [date] = dates();
    expect(date.getAttribute('aria-haspopup')).toBe('dialog');
    date.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(opened).toHaveLength(1);
    expect(opened[0].anchor).toBe(date);
    const pos = opened[0].pos;
    expect(editor.state.doc.nodeAt(pos)?.type.name).toBe('dateMention');
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    expect(pressKey(editor.view, 'Enter')).toBe(true);
    expect(opened).toHaveLength(2);
    // Enter elsewhere is the editor's own.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos - 1)),
    );
    pressKey(editor.view, 'Enter');
    expect(opened).toHaveLength(2);
    expect(blocks.listBlocks(editor.state.doc)).toHaveLength(2);

    be.editor.setEditable(false);
    date.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(opened).toHaveLength(2);

    const element = document.createElement('div');
    const reader = createBlockEditor({
      element,
      readOnlyContent: docOf(paragraph('On ', dateMention('2026-12-01'))) as never,
      host: {},
    });
    editors.push(reader);
    const readerOpened: number[] = [];
    reader.ui.openDatePicker = (at) => readerOpened.push(at);
    const drawn = element.querySelector<HTMLElement>('.cgw-date-mention')!;
    expect(drawn.hasAttribute('aria-haspopup')).toBe(false);
    drawn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(readerOpened).toEqual([]);
  });

  it('is redrawn when the picker changes it, and its text is in copies and headings', () => {
    const { editor, dates } = setup(
      docOf(block({ type: 'tableOfContents' }), heading(2, 'Launch ', dateMention('2026-12-01'))),
      { locale: 'en-GB' },
    );
    const pos = (() => {
      let found = -1;
      editor.state.doc.descendants((node, at) => {
        if (node.type.name === 'dateMention') found = at;
      });
      return found;
    })();
    expect(tocKey.getState(editor.state)?.headings.map((h) => h.text)).toEqual([
      'Launch 2026-12-01',
    ]);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { date: '2026-12-24', end: null }),
    );
    expect(dates()[0].textContent).toBe('24 Dec 2026');
    const slice = editor.state.doc.slice(pos - 7, pos + 1);
    const text = editor.view.someProp('clipboardTextSerializer', (f) => f(slice, editor.view));
    expect(text).toBe('Launch 2026-12-24');
  });

  it('is drawn again in the language of a new host, and only then', () => {
    const { be, dates } = setup(docOf(paragraph('On ', dateMention('2026-12-01'))), {
      locale: 'en-GB',
    });
    const [date] = dates();
    expect(date.textContent).toBe('1 Dec 2026');
    const arabic = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 11, 1)),
    );
    be.setHost({ locale: 'ar' });
    expect(dates()[0]).toBe(date);
    expect(date.textContent).toBe(arabic);
    // The same language again: nothing to draw.
    date.textContent = 'untouched';
    be.setHost({ locale: 'ar', strings: {} as never });
    expect(date.textContent).toBe('untouched');
  });
});
