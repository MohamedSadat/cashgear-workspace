// A formula property's expression: written with property names, `prop("Price")`, stored with ids
// (`formulaToIds`); suggestions of functions and properties for the word at the caret (Tab or
// Enter takes the chosen one, arrows choose); the error every row would give, checked as it is
// typed (after a pause), and the result on the first row.
import { CgButton } from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorKey } from '../cells/CellDisplay';
import {
  FUNCTIONS,
  checkFormula,
  evaluateFormula,
  formulaToIds,
  formulaToNames,
  type DatabaseRecord,
  type PropertyDef,
} from '../core';
import { useDbT } from '../i18n';
import { isCellError, valueText, type TextLookups } from '../model/format';
import { liveProperties } from '../model/properties';

export interface Suggestion {
  kind: 'function' | 'property';
  label: string;
  /** Text that replaces `from`..caret. */
  insert: string;
  from: number;
}

/** What to suggest for the text before the caret: a property inside `prop("…`, else functions. */
export function suggestionsAt(
  text: string,
  caret: number,
  propertyNames: readonly string[],
): Suggestion[] {
  const before = text.slice(0, caret);
  const inProp = /prop\(\s*"([^"\\]*)$/.exec(before);
  if (inProp) {
    const typed = inProp[1].toLocaleLowerCase();
    const from = caret - inProp[1].length;
    return propertyNames
      .filter((name) => name.toLocaleLowerCase().includes(typed))
      .slice(0, 8)
      .map((name) => ({
        kind: 'property',
        label: name,
        insert: `${name.replace(/(["\\])/g, '\\$1')}")`,
        from,
      }));
  }
  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
  if (!word) return [];
  const typed = word[0].toLowerCase();
  const from = caret - word[0].length;
  const out: Suggestion[] = [];
  if ('prop'.startsWith(typed))
    out.push({ kind: 'function', label: 'prop', insert: 'prop("', from });
  for (const fn of FUNCTIONS)
    if (fn.name.toLowerCase().startsWith(typed) && fn.name !== typed)
      out.push({ kind: 'function', label: fn.name, insert: `${fn.name}(`, from });
  return out.slice(0, 8);
}

export interface FormulaEditorProps {
  database: DatabaseRecord;
  def: PropertyDef;
  /** A row to show the result on (the first loaded one). */
  sample: RowRecord | null;
  lookups: TextLookups;
  onSave(expression: string): void;
}

export function FormulaEditor({ database, def, sample, lookups, onSave }: FormulaEditorProps) {
  const { t } = useDbT();
  const baseId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  // The text is taken once, when the editor opens.
  const [initial] = useState(() => formulaToNames(database, def.formula?.expression ?? ''));
  const [text, setText] = useState(initial);
  const [checked, setChecked] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [chosen, setChosen] = useState(0);
  const names = useMemo(
    () =>
      liveProperties(database)
        .filter((p) => p.id !== def.id)
        .map((p) => p.name),
    [database, def.id],
  );
  const suggestions = useMemo(() => suggestionsAt(text, caret, names), [text, caret, names]);

  // The check runs after a pause in typing, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => setChecked(text), 200);
    return () => clearTimeout(timer);
  }, [text]);

  const result = useMemo(() => {
    const expression = formulaToIds(database, checked);
    if (!expression.trim()) return null;
    const check = checkFormula(database, expression);
    if ('error' in check) return { error: check.error };
    if (!sample) return { example: null };
    const { value } = evaluateFormula(database, sample, expression);
    if (isCellError(value)) return { error: value.error };
    return { example: valueText(value, lookups) };
  }, [database, checked, sample, lookups]);

  const accept = (s: Suggestion) => {
    const next = text.slice(0, s.from) + s.insert + text.slice(caret);
    const at = s.from + s.insert.length;
    setText(next);
    setCaret(at);
    setChosen(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const save = () => onSave(formulaToIds(database, text));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setChosen((c) => (c + step + suggestions.length) % suggestions.length);
    } else if (
      suggestions.length &&
      (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))
    ) {
      event.preventDefault();
      accept(suggestions[Math.min(chosen, suggestions.length - 1)]);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };

  const listId = `${baseId}-suggestions`;
  return (
    <div className="cgw-formula">
      <label className="cgw-label" htmlFor={`${baseId}-input`}>
        {t('formula.expression')}
      </label>
      <textarea
        id={`${baseId}-input`}
        ref={area}
        className="cgw-formula-input"
        data-cg-initial-focus=""
        dir="ltr"
        spellCheck={false}
        rows={3}
        value={text}
        placeholder={t('formula.placeholder')}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          suggestions.length ? `${listId}-${Math.min(chosen, suggestions.length - 1)}` : undefined
        }
        aria-invalid={result && 'error' in result ? true : undefined}
        aria-describedby={`${baseId}-status`}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setChosen(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('formula.suggestions')}
          className="cgw-formula-suggestions"
        >
          {suggestions.map((s, i) => (
            <div
              key={`${s.kind}:${s.label}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === chosen}
              className="cgw-picker-option"
              data-active={i === chosen || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(s)}
            >
              <span className="cgw-menu-hint">
                {s.kind === 'function' ? t('formula.functions') : t('formula.properties')}
              </span>
              <code dir="auto">{s.label}</code>
            </div>
          ))}
        </div>
      ) : null}
      <p id={`${baseId}-status`} className="cgw-formula-status" role="status">
        {result === null
          ? ''
          : 'error' in result
            ? t(errorKey(result.error ?? ''))
            : result.example === null
              ? `${t('formula.valid')} ${t('formula.noExample')}`
              : `${t('formula.valid')} ${t('formula.example', { value: result.example })}`}
      </p>
      <div className="cgw-panel-actions">
        <CgButton intent="primary" size="small" onClick={save}>
          {t('formula.apply')}
        </CgButton>
      </div>
    </div>
  );
}
