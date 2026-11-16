// The paste's conversion vectors: the text Excel and Sheet put on the clipboard for a value of
// every property type, read through the TSV parser and the property's conversion rules (the
// conversion table's text column), with what each cell becomes or why it is left as it was. Then
// the paste's shape: a single value filling a selection, rows added past the last one and the
// 1,000-row cap, columns past the last, the tab's own copy carrying ids and exact values, the
// clear, the one batch of operations, and Undo.
import { derivedOption, type RowRecord, type Value } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import { P, PEOPLE, seed } from '../testing/fixtures';
import type { CellEnv } from '../cells/env';
import { copyCells, clipFor, forgetClip } from './copy';
import {
  PASTE_ROW_LIMIT,
  planClear,
  planOperations,
  planPaste,
  undoOf,
  undoOperations,
  type CellPlan,
  type PasteSource,
} from './paste';
import { parseTsv } from './tsv';

type Expect = Value | null | 'refused' | 'computed' | { option: string } | { options: string[] };

/** One value as each program writes it on the clipboard (one cell of TSV), and what it becomes. */
interface Vector {
  name: string;
  property: string;
  excel: string | null;
  sheet: string | null;
  expected: Expect;
}

const TITLE = 'title';
const V = (
  property: string,
  name: string,
  excel: string | null,
  sheet: string | null,
  expected: Expect,
): Vector => ({ property, name, excel, sheet, expected });

/**
 * Excel (365, English, Windows) writes what a cell shows, a cell with a line break in quotes;
 * Sheet writes what a cell shows (Latin digits), a cell with a tab, a quote or a line break in
 * quotes. Both end every row with CRLF.
 */
const VECTORS: Vector[] = [
  V(TITLE, 'a title', 'Quarter close\r\n', 'Quarter close\r\n', 'Quarter close'),
  V(TITLE, 'an Arabic title', 'إقفال الربع\r\n', 'إقفال الربع\r\n', 'إقفال الربع'),
  V(TITLE, 'an empty title', '\r\n', '\r\n', ''),
  V(
    P.notes,
    'text',
    'Checked with finance\r\n',
    'Checked with finance\r\n',
    'Checked with finance',
  ),
  V(
    P.notes,
    'text over two lines',
    '"Line one\nLine two"\r\n',
    '"Line one\nLine two"\r\n',
    'Line one\nLine two',
  ),
  V(P.notes, 'text with quotes', 'She said "yes"\r\n', '"She said ""yes"""\r\n', 'She said "yes"'),
  V(P.notes, 'text with a tab', null, '"a\tb"\r\n', 'a\tb'),
  V(P.notes, 'text starting with a quote, unquoted', '"Big" deal\r\n', null, '"Big" deal'),
  V(P.notes, 'text of spaces clears', '   \r\n', '   \r\n', null),
  V(P.amount, 'a number with thousands', '1,234.50\r\n', '1234.5\r\n', 1234.5),
  V(P.amount, 'a negative number', '-12.5\r\n', '-12.5\r\n', -12.5),
  V(P.amount, 'a number in scientific form', '1.50E+03\r\n', '1.5E+3\r\n', 1500),
  V(P.amount, 'a number in Arabic digits', '١٬٢٣٤٫٥\r\n', null, 1234.5),
  V(P.amount, 'zero', '0\r\n', '0\r\n', 0),
  V(P.amount, 'a currency (paste reading)', '$1,234.50\r\n', 'EGP 1,234.50\r\n', 1234.5),
  V(P.amount, 'a percent on a currency property is the number', '25%\r\n', '25%\r\n', 25),
  V(P.amount, 'an accounting negative', '(1,234.50)\r\n', null, -1234.5),
  V(P.amount, 'words are not a number', 'about ten\r\n', 'about ten\r\n', 'refused'),
  V(P.amount, 'an empty cell clears', '\r\n', '\r\n', null),
  V(P.due, 'an ISO date', '2026-11-16\r\n', '2026-11-16\r\n', { start: '2026-11-16' }),
  V(P.due, 'a date and time (UTC)', '2026-11-16 09:30\r\n', '2026-11-16 09:30\r\n', {
    start: '2026-11-16T09:30:00Z',
  }),
  V(P.due, 'a span', '2026-11-16 → 2026-11-20\r\n', null, {
    start: '2026-11-16',
    end: '2026-11-20',
  }),
  V(P.due, 'the device’s short date (en-US)', '11/16/2026\r\n', '11/16/2026\r\n', {
    start: '2026-11-16',
  }),
  V(P.due, 'a day-first date on an en-US device is not read', '16/11/2026\r\n', null, 'refused'),
  V(P.due, 'a date in words is not read', 'Nov 16, 2026\r\n', null, 'refused'),
  V(P.done, 'TRUE', 'TRUE\r\n', 'TRUE\r\n', true),
  V(P.done, 'FALSE unchecks', 'FALSE\r\n', 'FALSE\r\n', null),
  V(P.done, 'yes', 'yes\r\n', 'yes\r\n', true),
  V(P.done, 'نعم', 'نعم\r\n', 'نعم\r\n', true),
  V(P.done, 'a tick', '✓\r\n', '✓\r\n', true),
  V(P.done, 'another word is not read', 'maybe\r\n', 'maybe\r\n', 'refused'),
  V(P.priority, 'an option by name', 'High\r\n', 'High\r\n', 'prHigh01'),
  V(P.priority, 'an option name trimmed', ' Medium \r\n', ' Medium \r\n', 'prMed001'),
  V(P.priority, 'an Arabic option', 'منخفضة\r\n', 'منخفضة\r\n', 'prLow001'),
  V(P.priority, 'a new option is made', 'Urgent\r\n', 'Urgent\r\n', { option: 'Urgent' }),
  V(P.priority, 'names match exactly: a new option', 'high\r\n', 'high\r\n', { option: 'high' }),
  V(P.status, 'a status', 'Done\r\n', 'Done\r\n', 'stDone01'),
  V(P.status, 'a new status (to do)', 'Blocked\r\n', 'Blocked\r\n', { option: 'Blocked' }),
  V(P.tags, 'options by name', 'Finance, Legal\r\n', 'Finance, Legal\r\n', [
    'tgFin001',
    'tgLegal1',
  ]),
  V(P.tags, 'a new one among them', 'Finance,Ops\r\n', 'Finance,Ops\r\n', {
    options: ['Finance', 'Ops'],
  }),
  V(P.owner, 'a member by name', 'Mona Adel\r\n', 'Mona Adel\r\n', [PEOPLE[0].id]),
  V(P.owner, 'a member by email, any case', 'MONA@example.com\r\n', null, [PEOPLE[0].id]),
  V(P.owner, 'someone not a member is not read', 'Nobody Here\r\n', 'Nobody Here\r\n', 'refused'),
  V(P.owner, 'an empty person cell clears', '\r\n', '\r\n', null),
  V(
    P.site,
    'a URL, trimmed',
    ' https://example.com/a \r\n',
    'https://example.com/a\r\n',
    'https://example.com/a',
  ),
  V(P.email, 'an email', 'mona@example.com\r\n', 'mona@example.com\r\n', 'mona@example.com'),
  V(P.phone, 'a phone', '+20 100 000 0001\r\n', '+20 100 000 0001\r\n', '+20 100 000 0001'),
  V(P.files, 'a file has no reading from text', 'report.pdf\r\n', 'report.pdf\r\n', 'refused'),
  V(
    P.project,
    'a related row has no reading from text',
    'Project 1\r\n',
    'Project 1\r\n',
    'refused',
  ),
  V(P.double, 'a formula is computed', '42\r\n', '42\r\n', 'computed'),
  V(P.projects, 'a rollup is computed', '1\r\n', '1\r\n', 'computed'),
  V(P.created, 'created time is computed', '2026-11-16\r\n', '2026-11-16\r\n', 'computed'),
  V(P.creator, 'created by is computed', 'Mona Adel\r\n', 'Mona Adel\r\n', 'computed'),
  V(P.edited, 'edited time is computed', '2026-11-16\r\n', '2026-11-16\r\n', 'computed'),
  V(P.editor, 'edited by is computed', 'Mona Adel\r\n', 'Mona Adel\r\n', 'computed'),
];

const textSource = (text: string): PasteSource => ({
  kind: 'text',
  rows: parseTsv(text).map((row) => row.map((cell) => ({ text: cell }))),
});

/** What a plan wrote to a row's property (undefined: nothing written). */
function written(plan: CellPlan, rowId: string, propertyId: string): Value | null | undefined {
  const change = plan.updates.get(rowId);
  if (!change) return undefined;
  if (propertyId === TITLE) return change.title;
  return propertyId in change.values ? change.values[propertyId] : undefined;
}

describe('the conversion vectors over pasted text', () => {
  const s = seed(1);
  const database = s.host.database(s.tasksId)!;
  // A row whose every cell differs from what is pasted (so each write shows).
  const row: RowRecord = {
    ...s.host.rowsOf(s.tasksId)[0],
    title: 'Before',
    values: {
      [P.notes]: 'before',
      [P.amount]: 7,
      [P.due]: { start: '2020-01-01' },
      [P.done]: true,
      [P.priority]: 'prMed001',
      [P.status]: 'stTodo01',
      [P.tags]: ['tgOps001'],
      [P.owner]: [PEOPLE[1].id],
      [P.site]: 'https://before.example',
      [P.email]: 'before@example.com',
      [P.phone]: '0',
    },
  };
  // A row with no values, for a vector whose value the first row already holds.
  const blank: RowRecord = { ...s.host.rowsOf(s.tasksId)[0], title: 'Blank', values: {} };
  const def = (id: string) => database.properties.find((p) => p.id === id)!;
  const holds = (r: RowRecord, id: string, value: Expect) =>
    JSON.stringify((id === TITLE ? r.title : r.values[id]) ?? null) === JSON.stringify(value);

  for (const vector of VECTORS)
    for (const program of ['excel', 'sheet'] as const) {
      const text = vector[program];
      if (text === null) continue;
      it(`${program}: ${vector.name}`, () => {
        const target = def(vector.property);
        const into = holds(row, vector.property, vector.expected) ? blank : row;
        const plan = planPaste({
          database,
          columns: [target],
          rows: [into],
          source: textSource(text),
          fill: null,
          maxNewRows: 0,
          reading: { locale: 'en-US', people: PEOPLE },
        });
        const got = written(plan, into.id, vector.property);
        const { expected } = vector;
        if (expected === 'refused') {
          expect(plan.counts.refused).toBe(1);
          expect(got).toBeUndefined();
        } else if (expected === 'computed') {
          expect(plan.counts.computed).toBe(1);
          expect(plan.updates.size).toBe(0);
        } else if (expected && typeof expected === 'object' && 'option' in expected) {
          const made = plan.defs.find((d) => d.id === target.id)!;
          const option = made.options!.find((o) => o.name === expected.option)!;
          // The id a type change would make for that name, so every device makes the same one.
          const taken = new Set((target.options ?? []).map((o) => o.id));
          expect(option.id).toBe(derivedOption(database.id, target.id, option.name, taken).id);
          if (target.type === 'status') expect(option).toMatchObject({ group: 'todo' });
          expect(got).toBe(option.id);
        } else if (expected && typeof expected === 'object' && 'options' in expected) {
          const made = plan.defs.find((d) => d.id === target.id)!;
          const ids = expected.options.map(
            (name) => made.options!.find((o) => o.name === name)!.id,
          );
          expect(got).toEqual(ids);
        } else {
          expect(got).toEqual(expected);
          expect(plan.counts.refused + plan.counts.computed).toBe(0);
        }
      });
    }
});

describe('a paste', () => {
  const s = seed(6);
  const database = s.host.database(s.tasksId)!;
  const rows = s.host.rowsOf(s.tasksId);
  const def = (id: string) => database.properties.find((p) => p.id === id)!;
  const columns = [def(TITLE), def(P.amount), def(P.done), def(P.double), def(P.priority)];

  it('reads a whole Excel range: CRLF rows, a quoted cell over two lines, refused and computed cells', () => {
    const excel =
      'Close the books\t1,250.00\tTRUE\t2500\tHigh\r\n' +
      '"Pay\nsuppliers"\tabout thirty\tFALSE\t60\tNew one\r\n' +
      'Order stock\t($30.00)\tTRUE\t-60\tHigh\r\n';
    const plan = planPaste({
      database,
      columns,
      rows,
      source: textSource(excel),
      fill: null,
      maxNewRows: 0,
    });
    expect(written(plan, rows[0].id, TITLE)).toBe('Close the books');
    expect(written(plan, rows[0].id, P.amount)).toBe(1250);
    expect(written(plan, rows[1].id, TITLE)).toBe('Pay\nsuppliers');
    expect(written(plan, rows[1].id, P.amount)).toBeUndefined();
    // Excel's accounting negative, read by the paste.
    expect(written(plan, rows[2].id, P.amount)).toBe(-30);
    expect(plan.counts.refused).toBe(1);
    expect(plan.counts.computed).toBe(3);
    expect(plan.defs).toHaveLength(1);
    expect(plan.defs[0].options!.map((o) => o.name)).toContain('New one');
    expect(plan.size).toEqual({ rows: 3, cols: 5 });
  });

  it('fills a larger selection with a single value', () => {
    const plan = planPaste({
      database,
      columns: [def(P.notes), def(P.site)],
      rows,
      source: textSource('Same\r\n'),
      fill: { rows: 3, cols: 2 },
      maxNewRows: 0,
    });
    for (const row of rows.slice(0, 3)) {
      expect(written(plan, row.id, P.notes) ?? row.values[P.notes]).toBe('Same');
      expect(written(plan, row.id, P.site) ?? row.values[P.site]).toBe('Same');
    }
    expect(plan.updates.has(rows[3].id)).toBe(false);
    expect(plan.counts.changed + plan.counts.unchanged).toBe(6);
  });

  it('adds rows past the last one, counts cells past the last column', () => {
    const text = Array.from({ length: 8 }, (_, i) => `Row ${i}\t${i}\textra`).join('\r\n');
    const plan = planPaste({
      database,
      columns: [def(TITLE), def(P.amount)],
      rows: rows.slice(4),
      source: textSource(text),
      fill: null,
      maxNewRows: PASTE_ROW_LIMIT,
    });
    expect(plan.updates.size).toBe(2);
    expect(plan.added).toHaveLength(6);
    expect(plan.added[0]).toEqual({ title: 'Row 2', values: { [P.amount]: 2 } });
    expect(plan.counts.outside).toBe(8);
    expect(plan.size).toEqual({ rows: 8, cols: 2 });
  });

  it('adds at most 1,000 rows a paste and counts the rest', () => {
    const text = Array.from({ length: 1205 }, (_, i) => `Row ${i}`).join('\n');
    const plan = planPaste({
      database,
      columns: [def(TITLE)],
      rows,
      source: textSource(text),
      fill: null,
      maxNewRows: PASTE_ROW_LIMIT,
    });
    expect(plan.added).toHaveLength(PASTE_ROW_LIMIT);
    expect(plan.counts.rowsLeftOut).toBe(1205 - rows.length - PASTE_ROW_LIMIT);
  });

  it('adds no rows while the view has rows still to load', () => {
    const plan = planPaste({
      database,
      columns: [def(TITLE)],
      rows: rows.slice(0, 2),
      source: textSource('a\nb\nc'),
      fill: null,
      maxNewRows: 0,
    });
    expect(plan.added).toHaveLength(0);
    expect(plan.counts.rowsLeftOut).toBe(1);
  });

  it('of the tab’s own copy carries dates, people, related rows and option ids', () => {
    forgetClip();
    const source = rows.find((r) => r.values[P.owner] && r.values[P.due])!;
    const withProject = {
      ...source,
      values: { ...source.values, [P.project]: [s.projectRows[0]] },
    };
    const env = {
      locale: 'en',
      rtl: false,
      people: new Map(PEOPLE.map((p) => [p.id, p])),
      t: (key: string) => key,
      host: s.host,
    } as unknown as CellEnv;
    const copied = copyCells(
      database.id,
      [withProject],
      [def(P.due), def(P.owner), def(P.project), def(P.priority)],
      env,
    );
    // What was shown: a person by name, the related row by its title.
    const owner = PEOPLE.find((p) => p.id === (source.values[P.owner] as string[])[0])!;
    expect(copied.text).toContain(owner.name);
    expect(copied.text).toContain(s.host.pageTitle(s.projectRows[0])!);
    const clip = clipFor(copied.text.replace(/\r\n/g, '\n'))!;
    expect(clip).not.toBeNull();
    const target = rows.find((r) => r.id !== source.id)!;
    const plan = planPaste({
      database,
      columns: [def(P.due), def(P.owner), def(P.project), def(P.priority)],
      rows: [target],
      source: { kind: 'clip', clip },
      fill: null,
      maxNewRows: 0,
    });
    const value = (id: string) => written(plan, target.id, id) ?? target.values[id] ?? null;
    expect(value(P.due)).toEqual(source.values[P.due]);
    expect(value(P.owner)).toEqual(source.values[P.owner]);
    expect(value(P.project)).toEqual([s.projectRows[0]]);
    expect(value(P.priority)).toEqual(source.values[P.priority] ?? null);
    expect(plan.counts.refused).toBe(0);
    // The same text from elsewhere (another tab) is only text: the person is refused.
    forgetClip();
    expect(clipFor(copied.text)).toBeNull();
  });
});

describe('a clear', () => {
  it('empties every cell it may, the title too, and counts the computed ones', () => {
    const s = seed(3);
    const database = s.host.database(s.tasksId)!;
    const rows = s.host.rowsOf(s.tasksId);
    const columns = database.properties.filter((p) =>
      [TITLE, P.amount, P.double, P.status].includes(p.id),
    );
    const plan = planClear(rows, columns);
    for (const row of rows) {
      expect(written(plan, row.id, TITLE)).toBe('');
      expect(written(plan, row.id, P.amount)).toBeNull();
      expect(written(plan, row.id, P.status)).toBeNull();
    }
    expect(plan.counts.computed).toBe(3);
  });
});

describe('the batch and Undo', () => {
  const ctx = (databaseId: string, workspaceId: string) => {
    let n = 0;
    return {
      workspaceId,
      databaseId,
      sectionId: 'sec',
      newId: () => `0190a000-0000-7000-8000-0000000ff${String(++n).padStart(3, '0')}`,
      orderKeys: (count: number) => Array.from({ length: count }, (_, i) => `z${i}`),
      preset: { title: '', values: { [P.status]: 'stTodo01' } as Record<string, Value> },
      now: '2026-11-16T10:00:00.000Z',
    };
  };

  it('writes one batch: options first, then a row.update and a page.update per row, a page.create per row added', () => {
    const s = seed(2);
    const database = s.host.database(s.tasksId)!;
    const rows = s.host.rowsOf(s.tasksId);
    const columns = database.properties.filter((p) => [TITLE, P.priority].includes(p.id));
    const plan = planPaste({
      database,
      columns,
      rows,
      source: textSource('A\tBrand new\nB\tHigh\nC\tHigh'),
      fill: null,
      maxNewRows: PASTE_ROW_LIMIT,
    });
    const { ops, created } = planOperations(plan, ctx(database.id, database.workspaceId));
    expect(ops[0].type).toBe('db.update');
    expect(ops.filter((op) => op.type === 'page.create')).toHaveLength(1);
    expect(created).toHaveLength(1);
    const made = ops.find((op) => op.type === 'page.create')!;
    expect(made.payload).toMatchObject({
      title: 'C',
      kind: 'row',
      orderKey: 'z0',
      row: { values: { [P.status]: 'stTodo01', [P.priority]: 'prHigh01' } },
    });
    expect(ops.filter((op) => op.type === 'row.update').length).toBeLessThanOrEqual(2);
  });

  it('takes back only what still holds the pasted value, and trashes the rows added', async () => {
    const s = seed(3);
    const database = s.host.database(s.tasksId)!;
    const rows = s.host.rowsOf(s.tasksId);
    const notes = database.properties.find((p) => p.id === P.notes)!;
    const before = rows.map((r) => r.values[P.notes] ?? null);
    const plan = planPaste({
      database,
      columns: [notes],
      rows,
      source: textSource('one\ntwo\nthree\nfour'),
      fill: null,
      maxNewRows: PASTE_ROW_LIMIT,
    });
    const { ops, created } = planOperations(plan, ctx(database.id, database.workspaceId));
    await s.host.apply(ops);
    // Someone changes the second row's cell after the paste: Undo keeps it.
    await s.host.apply([
      {
        opId: 'later',
        type: 'row.update',
        workspaceId: database.workspaceId,
        entityId: rows[1].id,
        baseVersion: null,
        createdAt: new Date().toISOString(),
        payload: { values: { [P.notes]: 'changed since' } },
      },
    ]);
    const undo = undoOf(plan, database.workspaceId, created);
    const back = undoOperations(undo, (id) => s.host.rowRecords.get(id) ?? null);
    expect(back.kept).toBe(1);
    await s.host.apply(back.ops);
    const now = (i: number) => s.host.rowRecords.get(rows[i].id)!.values[P.notes] ?? null;
    expect(now(0)).toEqual(before[0]);
    expect(now(1)).toBe('changed since');
    expect(now(2)).toEqual(before[2]);
    expect(s.host.rowRecords.get(created[0])!.trashedAt).not.toBeNull();
  });
});
