// People in the page (Phase 6, schema version 5): the "@" menu lists the host's people first, then
// pages and dates; choosing one puts a `userMention` holding their id in the document; the mention
// draws `@` and their name from the host (or "someone"), again when the names change and never
// per transaction; copied text and Markdown name them.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, fragmentToJSON, CONTENT, build } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { chooseMention, mentionItems, mentionState } = await import('./mention');
const { EDITOR_STRING_DEFAULTS } = await import('./host');
type EditorHost = import('./host').EditorHost;
type PersonRef = import('./host').PersonRef;

const { docOf, paragraph, userMention } = build;
const opened: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of opened) editor.destroy();
});

const SARA = '01936f6e-0000-7000-8000-0000000000b1';
const OMAR = '01936f6e-0000-7000-8000-0000000000b2';
const english = {
  mentionPages: 'Pages',
  mentionDates: 'Date',
  mentionPeople: 'People',
  dateToday: 'Today',
  dateTomorrow: 'Tomorrow',
  datePick: 'Pick a date',
  untitled: 'Untitled',
  someone: 'someone',
} as never;

/** People the host knows, and what it was asked. */
function peopleHost(people: PersonRef[], strings = english) {
  let known = people;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  let names = 0;
  const host: EditorHost = {
    strings,
    people: {
      name: (id) => (names++, known.find((p) => p.id === id)?.name),
      search: (query) => {
        queries.push(query);
        return known.filter((p) => p.name.toLowerCase().startsWith(query.toLowerCase()));
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    pages: {
      title: () => 'Today’s plan',
      icon: () => null,
      exists: () => true,
      open: () => {},
      create: async () => null,
      search: () => [
        { id: '01936f6e-0000-7000-8000-000000000001', title: 'Today’s plan', icon: null },
      ],
      subscribe: () => () => {},
    },
  };
  return {
    host,
    queries,
    names: () => names,
    rename(next: PersonRef[]) {
      known = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function setup(json: import('@cgw/doc').DocJSON, host: EditorHost) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({ element, fragment: doc.getXmlFragment(CONTENT), host });
  opened.push(be);
  const editor = be.editor;
  const type = (text: string) => {
    for (const ch of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (f) =>
        f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)),
      );
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  };
  const end = () =>
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  return { doc, be, editor, type, end };
}

describe('the "@" menu', () => {
  const people = [
    { id: SARA, name: 'Sara Ali' },
    { id: OMAR, name: 'عمر' },
  ];

  it('lists people first, then pages and dates, in named groups', () => {
    const { host, queries } = peopleHost(people);
    expect(mentionItems(host, '').map((i) => [i.id, i.label, i.group])).toEqual([
      [`person:${SARA}`, 'Sara Ali', 'People'],
      [`person:${OMAR}`, 'عمر', 'People'],
      ['01936f6e-0000-7000-8000-000000000001', 'Today’s plan', 'Pages'],
      ['date:today', 'Today', 'Date'],
      ['date:tomorrow', 'Tomorrow', 'Date'],
      ['date:pick', 'Pick a date', 'Date'],
    ]);
    // A date's name typed: people still first, then the dates, then the pages.
    expect(mentionItems(host, 'to').map((i) => i.id)).toEqual([
      'date:today',
      'date:tomorrow',
      '01936f6e-0000-7000-8000-000000000001',
    ]);
    // What was typed is the host's to fold (it matches names and addresses), Arabic included.
    expect(mentionItems(host, 'عم').map((i) => i.label)[0]).toBe('عمر');
    expect(queries).toEqual(['', 'to', 'عم']);
    const withTom = peopleHost([...people, { id: 'tom', name: 'Tom Riad' }]).host;
    expect(mentionItems(withTom, 'to').map((i) => i.id)).toEqual([
      'person:tom',
      'date:today',
      'date:tomorrow',
      '01936f6e-0000-7000-8000-000000000001',
    ]);
  });

  it('lists at most eight people, and names their group in English when the catalogue lacks it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
    const { host } = peopleHost(many, { untitled: 'Untitled' } as never);
    const items = mentionItems(host, '');
    expect(items.filter((i) => i.id.startsWith('person:'))).toHaveLength(8);
    expect(items[0].group).toBe(EDITOR_STRING_DEFAULTS.mentionPeople);
    // People alone: no group names.
    const alone = mentionItems({ people: host.people }, 'person');
    expect(alone.every((i) => i.group === undefined)).toBe(true);
  });

  it('puts a chosen person in place of what was typed, as their user id', () => {
    const { host } = peopleHost(people);
    const { doc, editor, type, end } = setup(docOf(paragraph('Ask ')), host);
    end();
    type('@sa');
    expect(mentionState(editor.state)).toMatchObject({ active: true, query: 'sa' });
    chooseMention(editor.view, { openDatePicker: null }, `person:${SARA}`);
    expect(mentionState(editor.state).active).toBe(false);
    type('now');
    const json = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(json.content![0].content![0].content).toEqual([
      { type: 'text', text: 'Ask ' },
      { type: 'userMention', attrs: { userId: SARA } },
      { type: 'text', text: ' now' },
    ]);
  });
});

describe('a person’s mention', () => {
  it('draws `@` and their name, or "someone", in its own direction', () => {
    const { host } = peopleHost([{ id: SARA, name: 'Sara Ali' }]);
    const { be } = setup(
      docOf(paragraph('Ask ', userMention(SARA), ' and ', userMention(OMAR), userMention(null))),
      host,
    );
    const drawn = [...be.editor.view.dom.querySelectorAll<HTMLElement>('.cgw-user-mention')];
    expect(drawn.map((d) => d.textContent)).toEqual(['@Sara Ali', '@someone', '@someone']);
    expect(drawn.map((d) => d.dataset.unknown)).toEqual(['false', 'true', 'true']);
    expect(drawn[0].dataset.userId).toBe(SARA);
    expect(drawn[0].dir).toBe('auto');
    expect(drawn[0].contentEditable).toBe('false');
    // Without people at all: the English default after the `@`.
    const bare = setup(docOf(paragraph(userMention(SARA))), {});
    expect(bare.be.editor.view.dom.querySelector('.cgw-user-mention')!.textContent).toBe(
      `@${EDITOR_STRING_DEFAULTS.someone}`,
    );
  });

  it('is drawn again when the names change, and not per transaction', () => {
    const people = peopleHost([{ id: SARA, name: 'Sara Ali' }]);
    const { be, type, end } = setup(docOf(paragraph('Ask ', userMention(SARA), ' x')), people.host);
    const dom = () => be.editor.view.dom.querySelector('.cgw-user-mention')!;
    const before = people.names();
    end();
    type('typing more');
    expect(people.names()).toBe(before);
    people.rename([{ id: SARA, name: 'Sara A. Hassan' }]);
    expect(dom().textContent).toBe('@Sara A. Hassan');
    // Another host: its people.
    const next = peopleHost([{ id: SARA, name: 'سارة' }]);
    be.setHost(next.host);
    expect(dom().textContent).toBe('@سارة');
    next.rename([{ id: SARA, name: 'سارة علي' }]);
    expect(dom().textContent).toBe('@سارة علي');
  });

  it('is copied as `@` and the name, in plain text and in Markdown', () => {
    const { host } = peopleHost([{ id: SARA, name: 'Sara Ali' }]);
    const { be } = setup(
      docOf(paragraph('Ask ', userMention(SARA), ' now'), paragraph('and ', userMention(OMAR))),
      host,
    );
    const view = be.editor.view;
    const serialize = (from: number, to: number) =>
      view.someProp('clipboardTextSerializer', (f) => f(view.state.doc.slice(from, to), view));
    expect(serialize(2, 11)).toBe('Ask @Sara Ali now');
    expect(serialize(0, view.state.doc.content.size)).toBe('Ask @Sara Ali now\n\nand @');
  });
});
