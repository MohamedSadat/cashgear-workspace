// Choosing options of a select, multi-select or status cell, and managing the property's options
// on the way: create one from what was typed, rename, recolour, regroup (status), reorder and
// delete. A local stand-in for Track U: `CgTagBox` has no creatable options or per-option
// actions. The search text filters the list as it is typed (the list is this flyout's own).
import { normaliseText } from '@cgw/workspace';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  OPTION_COLOURS,
  newOptionId,
  type OptionColour,
  type OptionId,
  type PropertyDef,
  type SelectOption,
  type StatusGroup,
  type StatusOption,
} from '../core';
import { OptionChip } from '../cells/CellDisplay';
import { useDbT } from '../i18n';
import { moveIndex, useReorder } from './reorder';

export const STATUS_GROUPS: readonly StatusGroup[] = ['todo', 'inProgress', 'complete'];
export const COLOURS: readonly OptionColour[] = ['default', ...OPTION_COLOURS];

export interface OptionPickerProps {
  def: PropertyDef;
  /** The chosen option ids. */
  selected: readonly OptionId[];
  multiple: boolean;
  /** The person may add and change options (edit on the database). */
  canManage: boolean;
  /** Typed text the search starts with. */
  seed?: string | null;
  /** The choice changed (single: the one picked, after which the cell closes). */
  onSelect(ids: OptionId[]): void;
  /** The property's options changed: written at once, as one `db.update`. */
  onDefChange(def: PropertyDef): void;
  /** Only managing the options (the property's menu): a click opens the option's editor. */
  manage?: boolean;
}

const groupOf = (o: SelectOption | StatusOption): StatusGroup =>
  'group' in o && o.group ? o.group : 'todo';

/** The colour a new option gets: the one used least so far, in palette order. */
export function nextColour(options: readonly SelectOption[]): OptionColour {
  const counts = new Map<OptionColour, number>();
  for (const o of options) counts.set(o.colour, (counts.get(o.colour) ?? 0) + 1);
  let best = OPTION_COLOURS[0];
  for (const c of OPTION_COLOURS) if ((counts.get(c) ?? 0) < (counts.get(best) ?? 0)) best = c;
  return best;
}

export function OptionPicker({
  def,
  selected,
  multiple,
  canManage,
  seed,
  onSelect,
  onDefChange,
  manage = false,
}: OptionPickerProps) {
  const { t } = useDbT();
  const baseId = useId();
  const [query, setQuery] = useState(seed ?? '');
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<OptionId | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const options = useMemo(() => def.options ?? [], [def.options]);
  const isStatus = def.type === 'status';

  const matches = useMemo(() => {
    const q = normaliseText(query.trim());
    return q ? options.filter((o) => normaliseText(o.name).includes(q)) : options;
  }, [options, query]);
  const trimmed = query.trim();
  const canCreate = canManage && trimmed !== '' && !options.some((o) => o.name === trimmed);
  // Status options are listed under their groups; the keyboard walks them in that order.
  const listed = useMemo(
    () =>
      isStatus ? STATUS_GROUPS.flatMap((g) => matches.filter((o) => groupOf(o) === g)) : matches,
    [isStatus, matches],
  );
  const total = listed.length + (canCreate ? 1 : 0);
  const activeIndex = Math.min(active, Math.max(0, total - 1));
  const optionDomId = (i: number) => `${baseId}-o${i}`;

  const toggle = (id: OptionId) => {
    if (!multiple) return onSelect([id]);
    onSelect(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const create = () => {
    if (!canCreate) return;
    const option: SelectOption | StatusOption = isStatus
      ? { id: newOptionId(), name: trimmed, colour: nextColour(options), group: 'todo' }
      : { id: newOptionId(), name: trimmed, colour: nextColour(options) };
    onDefChange({ ...def, options: [...options, option] });
    setQuery('');
    if (!manage) toggle(option.id);
  };

  const pick = (index: number) => {
    if (index >= listed.length) create();
    else if (manage) setEditing(listed[index].id);
    else toggle(listed[index].id);
  };

  const moveOption = (id: OptionId, to: number) => {
    const ids = moveIndex(
      options.map((o) => o.id),
      id,
      to,
    );
    const byId = new Map(options.map((o) => [o.id, o]));
    onDefChange({ ...def, options: ids.map((x) => byId.get(x)!) });
  };
  const { state: drag, handleProps } = useReorder(
    options.map((o) => o.id),
    moveOption,
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      if (event.altKey && canManage && activeIndex < listed.length && !trimmed) {
        const option = listed[activeIndex];
        const at = options.indexOf(option);
        if (at + step >= 0 && at + step < options.length) {
          moveOption(option.id, at + step);
          setActive(activeIndex + step);
        }
        return;
      }
      setActive(total ? (activeIndex + step + total) % total : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (total) pick(activeIndex);
    } else if (event.key === 'Backspace' && query === '' && multiple && selected.length) {
      onSelect(selected.slice(0, -1));
    }
  };

  const editingOption = editing ? options.find((o) => o.id === editing) : undefined;
  if (editingOption)
    return (
      <OptionEditor
        def={def}
        option={editingOption}
        onChange={onDefChange}
        onBack={() => {
          setEditing(null);
          requestAnimationFrame(() => input.current?.focus());
        }}
      />
    );

  const renderOption = (option: SelectOption | StatusOption) => {
    const index = listed.indexOf(option);
    const isSelected = selected.includes(option.id);
    return (
      <div
        key={option.id}
        id={optionDomId(index)}
        role="option"
        aria-selected={isSelected}
        data-reorder-id={option.id}
        data-active={index === activeIndex || undefined}
        data-drop={drag.over === options.indexOf(option) && drag.dragging ? 'true' : undefined}
        className="cgw-picker-option"
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActive(index)}
        onClick={() => pick(index)}
      >
        {canManage && !trimmed ? (
          <button
            type="button"
            className="cgw-db-handle"
            aria-label={t('option.drag', { name: option.name })}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            {...handleProps(option.id)}
          >
            <span aria-hidden="true">⠿</span>
          </button>
        ) : null}
        {manage ? null : (
          <span className="cgw-picker-check" aria-hidden="true">
            {isSelected ? '✓' : ''}
          </span>
        )}
        <OptionChip name={option.name} colour={option.colour} />
        {canManage ? (
          <button
            type="button"
            className="cgw-icon-button cgw-picker-more"
            aria-label={t('option.menu', { name: option.name })}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              setEditing(option.id);
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        ) : null}
      </div>
    );
  };

  const chosen = selected
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => Boolean(o));

  return (
    <div className="cgw-picker">
      <div className="cgw-picker-head">
        {chosen.map((o) => (
          <span key={o.id} className="cgw-chip cgw-chip-removable" data-colour={o.colour}>
            <span dir="auto">{o.name}</span>
            <button
              type="button"
              className="cgw-chip-remove"
              aria-label={t('option.remove', { name: o.name })}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(selected.filter((s) => s !== o.id))}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="cgw-picker-input"
          data-cg-initial-focus=""
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={total ? optionDomId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-label={canManage ? t('option.search') : t('option.searchOnly')}
          placeholder={canManage ? t('option.search') : t('option.searchOnly')}
          value={query}
          dir="auto"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={t('option.list')}
        aria-multiselectable={multiple || undefined}
        className="cgw-picker-list"
      >
        {isStatus
          ? STATUS_GROUPS.map((g) => {
              const inGroup = listed.filter((o) => groupOf(o) === g);
              if (!inGroup.length) return null;
              return (
                <div key={g} role="group" aria-label={t(`status.${g}`)}>
                  <div className="cgw-picker-group" aria-hidden="true">
                    {t(`status.${g}`)}
                  </div>
                  {inGroup.map(renderOption)}
                </div>
              );
            })
          : listed.map(renderOption)}
        {canCreate ? (
          <div
            id={optionDomId(listed.length)}
            role="option"
            aria-selected={false}
            data-active={activeIndex === listed.length || undefined}
            className="cgw-picker-option cgw-picker-create"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(listed.length)}
            onClick={create}
          >
            {t('option.create', { name: trimmed })}
          </div>
        ) : null}
        {!listed.length && !canCreate ? (
          <div className="cgw-picker-empty">
            {options.length ? t('option.noMatch') : t('option.none')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One option's name, colour and status group, and deleting it. */
function OptionEditor({
  def,
  option,
  onChange,
  onBack,
}: {
  def: PropertyDef;
  option: SelectOption | StatusOption;
  onChange(def: PropertyDef): void;
  onBack(): void;
}) {
  const { t } = useDbT();
  const options = def.options ?? [];
  const write = (next: SelectOption | StatusOption) =>
    onChange({ ...def, options: options.map((o) => (o.id === option.id ? next : o)) });
  const rename = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== option.name) write({ ...option, name: trimmed });
  };
  return (
    <div
      className="cgw-picker cgw-option-editor"
      role="group"
      aria-label={t('option.menu', { name: option.name })}
    >
      <div className="cgw-panel-head">
        <button type="button" className="cgw-icon-button" aria-label={t('back')} onClick={onBack}>
          <span aria-hidden="true" className="cgw-back-glyph">
            ‹
          </span>
        </button>
        <input
          className="cgw-text-input"
          data-cg-initial-focus=""
          autoFocus
          aria-label={t('option.name')}
          defaultValue={option.name}
          dir="auto"
          onBlur={(event) => rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              rename(event.currentTarget.value);
              onBack();
            }
          }}
        />
      </div>
      {def.type === 'status' ? (
        <fieldset className="cgw-fieldset">
          <legend>{t('option.group')}</legend>
          {STATUS_GROUPS.map((g) => (
            <label key={g} className="cgw-radio-row">
              <input
                type="radio"
                name={`group-${option.id}`}
                checked={groupOf(option) === g}
                onChange={() => write({ ...option, group: g })}
              />
              {t(`status.${g}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="cgw-fieldset">
        <legend>{t('option.colour')}</legend>
        {COLOURS.map((c) => (
          <label key={c} className="cgw-radio-row">
            <input
              type="radio"
              name={`colour-${option.id}`}
              checked={option.colour === c}
              onChange={() => write({ ...option, colour: c })}
            />
            <span className="cgw-db-swatch" data-colour={c} aria-hidden="true" />
            {t(`colour.${c}`)}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className="cgw-db-menu-item cgw-danger"
        onClick={() => {
          onChange({ ...def, options: options.filter((o) => o.id !== option.id) });
          onBack();
        }}
      >
        {t('option.delete')}
      </button>
    </div>
  );
}
