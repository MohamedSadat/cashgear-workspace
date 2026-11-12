// Text, number, URL, email and phone cells (and the title) are edited in place. The input is
// uncontrolled: typing changes nothing React draws (Phase 1's rule), and the value is written once,
// on commit: Enter, Tab or leaving the cell. Escape leaves it as it was.
import type { RowRecord } from '@cgw/workspace';
import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { parseNumberText, type PropertyDef } from '../core';
import type { CellEnv } from './env';

export type EditEnd = 'enter' | 'tab' | 'shiftTab' | 'escape' | 'blur';

/** The text an inline editor starts from. */
export function editText(def: PropertyDef, row: RowRecord): string {
  if (def.type === 'title') return row.title;
  const value = row.values[def.id];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

/**
 * The value typed text stands for, or `invalid` for a number that does not read as one. Empty
 * text clears the cell.
 */
export function parseTyped(def: PropertyDef, text: string): string | number | null | 'invalid' {
  if (def.type === 'number') {
    if (text.trim() === '') return null;
    return parseNumberText(text) ?? 'invalid';
  }
  if (def.type === 'title') return text.replace(/[\r\n]+/g, ' ');
  if (def.type === 'text') return text === '' ? null : text;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

export interface InlineEditorProps {
  def: PropertyDef;
  row: RowRecord;
  env: CellEnv;
  /** Typed text that replaces the value (a key pressed on a cell that was not being edited). */
  seed?: string | null;
  /** Called once the edit is over (after the value is written). */
  onDone(end: EditEnd): void;
  /** Writes the value; the default is the database's `setValue`. */
  commit?(value: string | number | null): void;
  className?: string;
  /** The accessible name of the input. */
  label: string;
}

export function InlineEditor({
  def,
  row,
  env,
  seed,
  onDone,
  commit,
  className,
  label,
}: InlineEditorProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  const initial = seed ?? editText(def, row);
  const multiline = def.type === 'text';

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (seed == null) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  }, [seed]);

  const finish = (end: EditEnd) => {
    if (done.current) return;
    const input = ref.current;
    if (end !== 'escape' && input) {
      const value = parseTyped(def, input.value);
      if (value === 'invalid') {
        if (end === 'enter' || end === 'tab' || end === 'shiftTab') {
          input.setAttribute('aria-invalid', 'true');
          input.title = env.t('cell.invalidNumber');
          return;
        }
      } else if (commit) commit(value);
      else void env.actions.setValue(row, def, value);
    }
    done.current = true;
    onDone(end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish('escape');
    } else if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      finish('enter');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      finish(event.shiftKey ? 'shiftTab' : 'tab');
    } else if (ref.current?.hasAttribute('aria-invalid')) {
      ref.current.removeAttribute('aria-invalid');
    }
  };

  const shared = {
    ref,
    className: `cgw-inline-editor ${className ?? ''}`,
    defaultValue: initial,
    'aria-label': label,
    // Links, addresses and numbers read left to right; text takes its first strong character's.
    dir: (def.type === 'url' || def.type === 'email' || def.type === 'phone' ? 'ltr' : 'auto') as
      'ltr' | 'auto',
    spellCheck: def.type === 'text' || def.type === 'title',
    onKeyDown,
    onBlur: () => finish('blur'),
    onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
  };
  if (multiline) return <textarea {...shared} rows={1} />;
  return (
    <input
      {...shared}
      type="text"
      inputMode={def.type === 'number' ? 'decimal' : def.type === 'phone' ? 'tel' : undefined}
      autoComplete="off"
    />
  );
}
