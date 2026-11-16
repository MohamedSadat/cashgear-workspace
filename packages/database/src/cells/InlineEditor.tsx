// Text, number, URL, email and phone cells (and the title) are edited in place, in the library's
// draftless editors (`CgInlineTextEditor`, `CgInlineNumberEditor`): the field is uncontrolled, so
// typing changes nothing React draws (Phase 1's rule), and the value is written once, on commit:
// Enter, Tab or leaving the cell. Escape leaves it as it was. A number that does not read as one
// is marked on Enter or Tab and the editor stays open.
import {
  CgInlineNumberEditor,
  CgInlineTextEditor,
  type CgInlineDoneDetails,
  type CgInlineEditEnd,
} from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import { parseNumberText, type PropertyDef } from '../core';
import type { CellEnv } from './env';

export type EditEnd = CgInlineEditEnd;

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
  const initial = seed ?? editText(def, row);
  const write = (value: string | number | null) => {
    if (commit) commit(value);
    else void env.actions.setValue(row, def, value);
  };
  const shared = {
    label,
    className: `cgw-inline-editor ${className ?? ''}`,
    initialSelection: seed == null ? ('all' as const) : ('end' as const),
    onDone: ({ end }: CgInlineDoneDetails) => onDone(end),
  };
  if (def.type === 'number')
    return (
      <CgInlineNumberEditor
        {...shared}
        // The editor starts from the text (a typed key, or the stored value as it was written).
        defaultValue={initial === '' ? null : 0}
        format={() => initial}
        parse={(text) => {
          const value = parseTyped(def, text);
          return value === 'invalid' ? undefined : (value as number | null);
        }}
        invalidMessage={env.t('cell.invalidNumber')}
        dir="auto"
        onCommit={(value) => write(value)}
      />
    );
  return (
    <CgInlineTextEditor
      {...shared}
      defaultValue={initial}
      multiline={def.type === 'text'}
      // Links, addresses and phone numbers read left to right; text takes its first strong
      // character's.
      dir={def.type === 'url' || def.type === 'email' || def.type === 'phone' ? 'ltr' : 'auto'}
      inputMode={def.type === 'phone' ? 'tel' : undefined}
      spellCheck={def.type === 'text' || def.type === 'title'}
      onCommit={(text) => {
        const value = parseTyped(def, text);
        if (value !== 'invalid') write(value);
      }}
    />
  );
}
