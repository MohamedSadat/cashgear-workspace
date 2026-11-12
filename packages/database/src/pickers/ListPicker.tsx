// Choosing items from a searched list, the chosen ones shown as removable chips above it: people
// for a person cell, rows of the related database for a relation cell, a value for a filter.
// Keyboard: arrows walk the list, Enter chooses, Backspace in an empty search removes the last
// chip. A local stand-in for Track U (`CgTagBox` with chips drawn by the caller and results
// supplied by the caller).
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDbT } from '../i18n';

export interface PickerItem {
  id: string;
  label: string;
  /** What the list draws for it (default: the label). */
  content?: ReactNode;
}

export interface ListPickerProps {
  items: readonly PickerItem[];
  selected: readonly string[];
  multiple: boolean;
  onSelect(ids: string[]): void;
  /** A chosen item's chip (it may not be among `items`). */
  chip(id: string): { label: string; content?: ReactNode };
  query: string;
  onQuery(query: string): void;
  searchLabel: string;
  emptyText: string;
  listLabel: string;
  loading?: boolean;
  /** A note under the list (a limit reached). */
  note?: string | null;
}

export function ListPicker({
  items,
  selected,
  multiple,
  onSelect,
  chip,
  query,
  onQuery,
  searchLabel,
  emptyText,
  listLabel,
  loading,
  note,
}: ListPickerProps) {
  const { t } = useDbT();
  const baseId = useId();
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const itemId = (i: number) => `${baseId}-i${i}`;

  const toggle = (id: string) => {
    if (!multiple) return onSelect([id]);
    onSelect(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(items.length ? (activeIndex + step + items.length) % items.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) toggle(item.id);
    } else if (event.key === 'Backspace' && query === '' && multiple && selected.length) {
      onSelect(selected.slice(0, -1));
    }
  };

  return (
    <div className="cgw-picker">
      <div className="cgw-picker-head">
        {selected.map((id) => {
          const c = chip(id);
          return (
            <span key={id} className="cgw-chip cgw-chip-removable" data-colour="default">
              {c.content ?? <span dir="auto">{c.label}</span>}
              <button
                type="button"
                className="cgw-chip-remove"
                aria-label={t('removeNamed', { name: c.label })}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(selected.filter((s) => s !== id))}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          );
        })}
        <input
          className="cgw-picker-input"
          data-cg-initial-focus=""
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={items.length ? itemId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-busy={loading || undefined}
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          dir="auto"
          autoComplete="off"
          onChange={(event) => {
            onQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={listLabel}
        aria-multiselectable={multiple || undefined}
        className="cgw-picker-list"
      >
        {items.map((item, index) => (
          <div
            key={item.id}
            id={itemId(index)}
            role="option"
            aria-selected={selected.includes(item.id)}
            data-active={index === activeIndex || undefined}
            className="cgw-picker-option"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => toggle(item.id)}
          >
            <span className="cgw-picker-check" aria-hidden="true">
              {selected.includes(item.id) ? '✓' : ''}
            </span>
            {item.content ?? <span dir="auto">{item.label}</span>}
          </div>
        ))}
        {!items.length ? (
          <div className="cgw-picker-empty">{loading ? t('loading') : emptyText}</div>
        ) : null}
      </div>
      {note ? <div className="cgw-picker-note">{note}</div> : null}
    </div>
  );
}
