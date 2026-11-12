// The date picker (ui/DatePicker.tsx): `@cashgear/ui`'s calendar in a flyout at a date mention.
// Choosing a day replaces the date, keeps a later end and drops an earlier one; it follows the
// date through edits made while it is open; Escape closes it without a change.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const target = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'HTMLButtonElement',
  'HTMLSpanElement',
  'HTMLDivElement',
  'FocusEvent',
  'MouseEvent',
  'PointerEvent',
  'UIEvent',
  'CustomEvent',
  'ResizeObserver',
  'IS_REACT_ACT_ENVIRONMENT',
]) {
  const value = (window as unknown as Record<string, unknown>)[name];
  if (value !== undefined && target[name] === undefined) target[name] = value;
}
target.IS_REACT_ACT_ENVIRONMENT = true;
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

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const Y = await import('yjs');
const { build, documentSchema, writeJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { DatePicker } = await import('./ui/DatePicker');
const { openDatePicker } = await import('./dates');

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

const { docOf, paragraph, dateMention } = build;

async function setup(attrs: { date: string; end?: string | null }) {
  const doc = new Y.Doc();
  writeJSON(
    doc.getXmlFragment(CONTENT),
    documentSchema(),
    docOf(paragraph('On ', dateMention(attrs.date, attrs.end ?? null), ' then')),
  );
  const element = document.createElement('div');
  document.body.append(element);
  const host = { locale: 'en-GB', strings: { datePicker: 'Choose a date' } as never };
  const be = createBlockEditor({ element, fragment: doc.getXmlFragment(CONTENT), host });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(DatePicker, { editor: be, host })));
  cleanups.push(() => {
    root.unmount();
    be.destroy();
  });
  const editor = be.editor;
  const position = () => {
    let found = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'dateMention') found = at;
    });
    return found;
  };
  const open = async () => {
    await act(async () => {
      openDatePicker(editor.view, be.ui, position());
    });
  };
  const calendar = () => document.querySelector<HTMLElement>('.cgw-date-picker');
  /** A day of the calendar (the mention's own span has a `data-date` too). */
  const day = (iso: string) =>
    calendar()!.querySelector<HTMLButtonElement>(`button[data-date="${iso}"]`)!;
  return { be, editor, position, open, calendar, day };
}

describe('the date picker', () => {
  it('opens at the date, and the chosen day replaces it', async () => {
    const { editor, open, calendar, day, position } = await setup({
      date: '2026-12-01',
      end: '2026-12-20',
    });
    expect(calendar()).toBeNull();
    await open();
    const dialog = calendar()!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-label')).toBe('Choose a date');
    expect(day('2026-12-01').closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    await act(async () => {
      day('2026-12-15').click();
    });
    expect(editor.state.doc.nodeAt(position())?.attrs).toEqual({
      date: '2026-12-15',
      end: '2026-12-20',
    });
    expect(calendar()).toBeNull();
  });

  it('drops an end before the new day, and follows the date through edits while open', async () => {
    const { editor, open, day, position } = await setup({
      date: '2026-12-10',
      end: '2026-12-12',
    });
    await open();
    // Text typed before the date while the picker is open moves it.
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText('Starts ', 1 + 1));
    });
    await act(async () => {
      day('2026-12-14').click();
    });
    expect(editor.state.doc.nodeAt(position())?.attrs).toEqual({ date: '2026-12-14', end: null });
    expect(editor.state.doc.textContent).toContain('Starts On ');
  });

  it('Escape closes it without a change', async () => {
    const { editor, open, calendar, day, position } = await setup({ date: '2026-12-10' });
    await open();
    await act(async () => {
      day('2026-12-10').dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(calendar()).toBeNull();
    expect(editor.state.doc.nodeAt(position())?.attrs).toEqual({ date: '2026-12-10', end: null });
  });

  it('closes without a change when the date is deleted while it is open', async () => {
    const { editor, open, calendar, position } = await setup({ date: '2026-12-10' });
    await open();
    const at = position();
    await act(async () => {
      editor.view.dispatch(editor.state.tr.delete(at, at + 1));
    });
    expect(calendar()).toBeNull();
    expect(position()).toBe(-1);
  });
});
