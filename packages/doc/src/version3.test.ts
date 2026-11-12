// Schema version 3 (contracts, section 5): the `databaseView` body and the `dateMention` inline
// atom, their attributes and defaults, how they are stored in Yjs, and what plain text writes.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, writeJSON, type DocJSON } from './binding';
import { build, remapRefs } from './index';
import { dateMentionText, isDateValue, localDate } from './dates';
import { CONTENT } from './names';
import { ATOM_BODIES, documentSchema } from './schema';
import { plainText, toMarkdown } from './text';

const { docOf, paragraph, databaseView, dateMention } = build;
const DATABASE = '01936f6e-0000-7000-8000-0000000000d1';
const VIEW = '01936f6e-0000-7000-8000-0000000000d2';

describe('the version-3 nodes', () => {
  const schema = documentSchema();

  it('are an atom body and an inline atom, every attribute optional with a default of null', () => {
    const view = schema.nodes.databaseView;
    expect(view.spec.group).toBe('body');
    expect(view.isAtom && view.isLeaf).toBe(true);
    expect(ATOM_BODIES).toContain('databaseView');
    expect(view.create().attrs).toEqual({ databaseId: null, viewId: null });
    const date = schema.nodes.dateMention;
    expect(date.spec.group).toBe('inline');
    expect(date.isInline && date.isAtom).toBe(true);
    expect(date.create().attrs).toEqual({ date: null, end: null });
    // A block holds the view as its body; a text body holds the date with text around it.
    expect(() =>
      schema
        .nodeFromJSON(
          docOf(databaseView(DATABASE), paragraph('Due ', dateMention('2026-12-01'), '.')),
        )
        .check(),
    ).not.toThrow();
  });

  it('are stored in Yjs with their attributes, and read back the same', () => {
    const json = docOf(
      databaseView(DATABASE, VIEW),
      databaseView(DATABASE),
      paragraph('From ', dateMention('2026-12-01', '2026-12-05'), ' on'),
      paragraph(dateMention('2026-11-12T09:30:00Z')),
    );
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), schema, json);
    const xml = doc.getXmlFragment(CONTENT).toString();
    // (Yjs writes element names in lower case in its text form.)
    expect(xml).toContain(
      `<databaseview databaseId="${DATABASE}" viewId="${VIEW}"></databaseview>`,
    );
    expect(xml).toContain('<datemention date="2026-12-01" end="2026-12-05"></datemention>');
    const back = fragmentToJSON(doc.getXmlFragment(CONTENT));
    const bodies = back.content!.map((b) => b.content![0]);
    expect(bodies[0]).toEqual({
      type: 'databaseView',
      attrs: { databaseId: DATABASE, viewId: VIEW },
    });
    // A null attribute is not stored: it reads back as absent and takes its default.
    expect(bodies[1]).toEqual({ type: 'databaseView', attrs: { databaseId: DATABASE } });
    expect(schema.nodeFromJSON(bodies[1]).attrs.viewId).toBeNull();
    expect(bodies[2].content![1]).toEqual({
      type: 'dateMention',
      attrs: { date: '2026-12-01', end: '2026-12-05' },
    });
    expect(bodies[3].content![0]).toEqual({
      type: 'dateMention',
      attrs: { date: '2026-11-12T09:30:00Z' },
    });
  });

  it('write their text: a date as stored, a database view nothing', () => {
    const json = docOf(
      paragraph('Before'),
      databaseView(DATABASE),
      paragraph('Due ', dateMention('2026-12-01'), ' or ', dateMention('2026-12-01', '2026-12-03')),
    );
    expect(plainText(json)).toBe('Before\nDue 2026-12-01 or 2026-12-01 → 2026-12-03');
    expect(toMarkdown(json)).toBe('Before\n\nDue 2026-12-01 or 2026-12-01 → 2026-12-03\n');
  });

  it('a copied database view keeps its database unless the copy made a new one', () => {
    const copy = '01936f6e-0000-7000-8000-0000000000e1';
    const copiedView = '01936f6e-0000-7000-8000-0000000000e2';
    const json = docOf(databaseView(DATABASE, VIEW));
    const body = (d: DocJSON) => d.content![0].content![0].attrs;
    expect(body(remapRefs(json, new Map()))).toEqual({ databaseId: DATABASE, viewId: VIEW });
    expect(body(remapRefs(json, new Map([[DATABASE, copy]])))).toEqual({
      databaseId: copy,
      viewId: VIEW,
    });
    expect(
      body(
        remapRefs(
          json,
          new Map([
            [DATABASE, copy],
            [VIEW, copiedView],
          ]),
        ),
      ),
    ).toEqual({ databaseId: copy, viewId: copiedView });
  });
});

describe('date values', () => {
  it('are a calendar date or a UTC instant, in ASCII digits', () => {
    for (const ok of ['2026-12-01', '0001-01-01', '2026-11-12T09:30:00Z'])
      expect(isDateValue(ok), ok).toBe(true);
    for (const bad of [
      '2026-12-1',
      '12/01/2026',
      '2026-12-01T09:30Z',
      '2026-12-01T09:30:00',
      '2026-12-01T09:30:00.000Z',
      '2026-12-01 ',
      '٢٠٢٦-١٢-٠١',
      '',
      null,
      20261201,
    ])
      expect(isDateValue(bad), String(bad)).toBe(false);
  });

  it('write nothing without a valid date, and an end only when it is valid', () => {
    expect(dateMentionText({ date: '2026-12-01' })).toBe('2026-12-01');
    expect(dateMentionText({ date: '2026-12-01', end: '2026-12-02' })).toBe(
      '2026-12-01 → 2026-12-02',
    );
    expect(dateMentionText({ date: '2026-12-01', end: 'soon' })).toBe('2026-12-01');
    expect(dateMentionText({ end: '2026-12-02' })).toBe('');
    expect(dateMentionText(null)).toBe('');
  });

  it("today and tomorrow are this device's calendar dates", () => {
    const evening = new Date(2026, 11, 31, 23, 30);
    expect(localDate(0, evening)).toBe('2026-12-31');
    expect(localDate(1, evening)).toBe('2027-01-01');
    expect(localDate(-1, new Date(2026, 2, 1, 0, 5))).toBe('2026-02-28');
  });
});
