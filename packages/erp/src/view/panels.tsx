// An editor's settings of an ERP view: which fields, the filter (a search and conditions on
// filterable fields, lookups' items from the schema) and up to three sorts. Each change is
// written to the block's attributes at once (typing after a pause, or on Enter or leaving the
// field). What the settings name that this editor's ERP account cannot see is kept as it is.
import { CgButton } from '@cashgear/ui';
import { useEffect, useId, useRef, useState } from 'react';
import {
  LIMITS,
  type ConnectorSchema,
  type FieldSchema,
  type Language,
  type SortKey,
  type WireValue,
} from '../contract';
import { useErpT } from '../i18n';
import type { ErpViewHost } from './host';
import {
  conditionText,
  fieldsText,
  filterText,
  labelOf,
  parseConditionValue,
  sortText,
  type ViewSettings,
} from './settings';

interface PanelProps {
  host: ErpViewHost;
  schema: ConnectorSchema;
  settings: ViewSettings;
  language: Language;
}

/** How long typing pauses before a search or a typed condition is written. */
const TYPING_MS = 600;

export function FieldsPanel({ host, schema, settings, language }: PanelProps) {
  const { t } = useErpT();
  const visible = schema.fields.map((f) => f.name);
  const known = new Set(visible);
  const current = settings.fields ?? visible;
  const shown = new Set(current.filter((name) => known.has(name)));
  const hidden = current.filter((name) => !known.has(name));
  const write = (next: Set<string>) => {
    const names = [...visible.filter((name) => next.has(name)), ...hidden];
    const all = !hidden.length && names.length === visible.length;
    host.setAttrs({ fields: all ? null : fieldsText(names) });
  };
  return (
    <fieldset className="cgw-erp-fieldset" data-testid="erp-fields">
      <legend>{t('fields')}</legend>
      <ul className="cgw-erp-checks">
        {schema.fields.map((field) => {
          const on = shown.has(field.name);
          return (
            <li key={field.name}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  // At least one field stays shown.
                  disabled={on && shown.size === 1}
                  data-field={field.name}
                  onChange={() => {
                    const next = new Set(shown);
                    if (on) next.delete(field.name);
                    else next.add(field.name);
                    write(next);
                  }}
                />{' '}
                <span dir="auto">{labelOf(field, language)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {settings.fields && (
        <CgButton
          appearance="ghost"
          size="small"
          onClick={() =>
            host.setAttrs({ fields: hidden.length ? fieldsText([...visible, ...hidden]) : null })
          }
        >
          {t('allFields')}
        </CgButton>
      )}
    </fieldset>
  );
}

interface Condition {
  key: number;
  field: string;
  raw: string;
}

/** A condition's first value when it is added: a lookup's first item, yes for a checkbox. */
function firstValue(field: FieldSchema, schema: ConnectorSchema): string {
  if (field.type === 'lookup') {
    const items = field.lookup ? (schema.lookups[field.lookup] ?? []) : [];
    return items.find((item) => item.active !== false)?.code ?? '';
  }
  if (field.type === 'boolean') return 'true';
  return '';
}

export function FilterPanel({ host, schema, settings, language }: PanelProps) {
  const { t } = useErpT();
  const searchId = useId();
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const filterable = schema.fields.filter((f) => f.filterable);

  const [search, setSearch] = useState(settings.search);
  const nextKey = useRef(0);
  const fromSettings = (): Condition[] =>
    Object.entries(settings.equals)
      .filter(([name]) => byName.has(name))
      .map(([field, value]) => ({ key: nextKey.current++, field, raw: conditionText(value) }));
  const [conditions, setConditions] = useState<Condition[]>(fromSettings);
  // Conditions on fields this editor cannot see: kept unless removed here.
  const [hiddenKept, setHiddenKept] = useState(true);
  const hiddenConditions = Object.keys(settings.equals).filter((name) => !byName.has(name));

  // What this panel last wrote: a change from elsewhere (another editor) is taken in.
  const current = filterText(settings.search, settings.equals);
  const written = useRef(current);
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    // The block's filter changed: from this panel (nothing to do), or from elsewhere.
    setSeen(current);
    if (current !== written.current) {
      written.current = current;
      setSearch(settings.search);
      setConditions(fromSettings());
    }
  }

  // What a write reads: the latest render's, also from a timer set in an earlier one.
  const latest = useRef({
    search,
    conditions,
    settings,
    byName,
    hiddenConditions,
    hiddenKept,
    host,
  });
  latest.current = { search, conditions, settings, byName, hiddenConditions, hiddenKept, host };
  const commit = (nextSearch: string, nextConditions: Condition[], keepHidden: boolean) => {
    const now = latest.current;
    const equals: Record<string, WireValue> = {};
    if (keepHidden)
      for (const name of now.hiddenConditions) equals[name] = now.settings.equals[name]!;
    for (const condition of nextConditions) {
      const field = now.byName.get(condition.field);
      if (!field) continue;
      const value = parseConditionValue(field, condition.raw);
      if (value !== undefined) equals[condition.field] = value;
    }
    const text = filterText(nextSearch, equals);
    if (text === filterText(now.settings.search, now.settings.equals)) return;
    written.current = text;
    now.host.setAttrs({ filter: text });
  };

  // Typing is written after a pause; a choice at once.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    commit(latest.current.search, latest.current.conditions, latest.current.hiddenKept);
  };
  const later = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, TYPING_MS);
  };
  const now = (nextSearch = search, nextConditions = conditions, keepHidden = hiddenKept) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    commit(nextSearch, nextConditions, keepHidden);
  };
  // Leaving the panel writes what was typed.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (timer.current) flushRef.current();
    },
    [],
  );

  const used = new Set(conditions.map((c) => c.field));
  const free = filterable.filter((f) => !used.has(f.name) && !hiddenConditions.includes(f.name));
  const update = (key: number, change: Partial<Condition>, typed: boolean) => {
    const next = conditions.map((c) => (c.key === key ? { ...c, ...change } : c));
    setConditions(next);
    if (typed) later();
    else now(search, next);
  };

  return (
    <div className="cgw-erp-filter" data-testid="erp-filter">
      <div className="cgw-erp-field">
        <label htmlFor={searchId}>{t('search')}</label>
        <input
          id={searchId}
          type="search"
          className="cgw-erp-input"
          value={search}
          placeholder={t('searchPlaceholder')}
          dir="auto"
          onChange={(event) => {
            setSearch(event.target.value);
            later();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              now(event.currentTarget.value);
            }
          }}
          onBlur={(event) => now(event.currentTarget.value)}
        />
      </div>
      <fieldset className="cgw-erp-fieldset">
        <legend>{t('conditions')}</legend>
        {hiddenKept && hiddenConditions.length > 0 && (
          <div className="cgw-erp-row">
            <span className="cgw-erp-muted">{t('hiddenCondition')}</span>
            <CgButton
              appearance="ghost"
              size="small"
              onClick={() => {
                setHiddenKept(false);
                now(search, conditions, false);
              }}
            >
              {t('removeHidden')}
            </CgButton>
          </div>
        )}
        {conditions.map((condition) => {
          const field = byName.get(condition.field);
          if (!field) return null;
          return (
            <ConditionRow
              key={condition.key}
              condition={condition}
              field={field}
              options={[field, ...free]}
              schema={schema}
              language={language}
              onField={(name) => {
                const next = byName.get(name);
                if (next)
                  update(condition.key, { field: name, raw: firstValue(next, schema) }, false);
              }}
              onValue={(raw, typed) => update(condition.key, { raw }, typed)}
              onCommit={() => now()}
              onRemove={() => {
                const next = conditions.filter((c) => c.key !== condition.key);
                setConditions(next);
                now(search, next);
              }}
            />
          );
        })}
        <CgButton
          appearance="ghost"
          size="small"
          disabled={!free.length}
          onClick={() => {
            const field = free[0];
            if (!field) return;
            const next = [
              ...conditions,
              { key: nextKey.current++, field: field.name, raw: firstValue(field, schema) },
            ];
            setConditions(next);
            now(search, next);
          }}
        >
          {t('addCondition')}
        </CgButton>
      </fieldset>
    </div>
  );
}

function ConditionRow({
  condition,
  field,
  options,
  schema,
  language,
  onField,
  onValue,
  onCommit,
  onRemove,
}: {
  condition: Condition;
  field: FieldSchema;
  options: readonly FieldSchema[];
  schema: ConnectorSchema;
  language: Language;
  onField: (name: string) => void;
  onValue: (raw: string, typed: boolean) => void;
  onCommit: () => void;
  onRemove: () => void;
}) {
  const { t } = useErpT();
  const fieldId = useId();
  const valueId = useId();
  const errorId = useId();
  const label = labelOf(field, language);
  const invalid = condition.raw !== '' && parseConditionValue(field, condition.raw) === undefined;
  const typedProps = {
    id: valueId,
    className: 'cgw-erp-input',
    value: condition.raw,
    'aria-label': t('conditionValue', { field: label }),
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? errorId : undefined,
    onChange: (event: { target: { value: string } }) => onValue(event.target.value, true),
    onBlur: onCommit,
    onKeyDown: (event: { key: string; preventDefault(): void }) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onCommit();
      }
    },
  };
  let control;
  if (field.type === 'lookup') {
    const items = field.lookup ? (schema.lookups[field.lookup] ?? []) : [];
    control = (
      <select
        id={valueId}
        className="cgw-erp-select"
        aria-label={t('conditionValue', { field: label })}
        value={condition.raw}
        onChange={(event) => onValue(event.target.value, false)}
      >
        <option value="">{t('emptyValue')}</option>
        {items
          .filter((item) => item.active !== false || item.code === condition.raw)
          .map((item) => (
            <option key={item.code} value={item.code}>
              {item.label || item.code}
            </option>
          ))}
      </select>
    );
  } else if (field.type === 'boolean') {
    control = (
      <select
        id={valueId}
        className="cgw-erp-select"
        aria-label={t('conditionValue', { field: label })}
        value={condition.raw}
        onChange={(event) => onValue(event.target.value, false)}
      >
        <option value="true">{t('yes')}</option>
        <option value="false">{t('no')}</option>
        <option value="">{t('emptyValue')}</option>
      </select>
    );
  } else if (field.type === 'date') {
    control = <input type="date" {...typedProps} />;
  } else {
    control = (
      <input
        type="text"
        inputMode={field.type === 'integer' || field.type === 'decimal' ? 'decimal' : undefined}
        dir={field.type === 'text' ? 'auto' : 'ltr'}
        {...typedProps}
      />
    );
  }
  return (
    <div className="cgw-erp-row" data-condition={condition.field}>
      <select
        id={fieldId}
        className="cgw-erp-select"
        aria-label={t('conditionField')}
        value={condition.field}
        onChange={(event) => onField(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.name} value={option.name}>
            {labelOf(option, language)}
          </option>
        ))}
      </select>
      {control}
      <CgButton
        appearance="ghost"
        size="small"
        aria-label={t('removeCondition', { field: label })}
        onClick={onRemove}
      >
        ×
      </CgButton>
      {invalid && (
        <span id={errorId} className="cgw-erp-invalid">
          {t('invalidValue')}
        </span>
      )}
    </div>
  );
}

export function SortPanel({ host, schema, settings, language }: PanelProps) {
  const { t } = useErpT();
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const sortable = schema.fields.filter((f) => f.sortable);
  const shown = settings.sort.filter((key) => byName.get(key.field)?.sortable);
  // Sorts on fields this editor cannot sort by stay, after the others.
  const kept = settings.sort.filter((key) => !byName.get(key.field)?.sortable);
  const write = (next: SortKey[]) => host.setAttrs({ sort: sortText([...next, ...kept]) });
  const used = new Set(shown.map((key) => key.field));
  const free = sortable.filter((f) => !used.has(f.name));
  return (
    <fieldset className="cgw-erp-fieldset" data-testid="erp-sort">
      <legend>{t('sort')}</legend>
      {shown.map((key, i) => (
        <SortRow
          key={key.field}
          n={i + 1}
          sortKey={key}
          options={[byName.get(key.field)!, ...free]}
          language={language}
          onChange={(next) => write(shown.map((k, j) => (j === i ? next : k)))}
          onRemove={() => write(shown.filter((_, j) => j !== i))}
        />
      ))}
      <CgButton
        appearance="ghost"
        size="small"
        disabled={!free.length || shown.length + kept.length >= LIMITS.maxSort}
        onClick={() => {
          const field = free[0];
          if (field) write([...shown, { field: field.name, direction: 'asc' }]);
        }}
      >
        {t('addSort')}
      </CgButton>
    </fieldset>
  );
}

function SortRow({
  n,
  sortKey,
  options,
  language,
  onChange,
  onRemove,
}: {
  n: number;
  sortKey: SortKey;
  options: readonly FieldSchema[];
  language: Language;
  onChange: (key: SortKey) => void;
  onRemove: () => void;
}) {
  const { t } = useErpT();
  return (
    <div className="cgw-erp-row" data-sort={sortKey.field}>
      <select
        className="cgw-erp-select"
        aria-label={t('sortField', { n })}
        value={sortKey.field}
        onChange={(event) => onChange({ ...sortKey, field: event.target.value })}
      >
        {options.map((option) => (
          <option key={option.name} value={option.name}>
            {labelOf(option, language)}
          </option>
        ))}
      </select>
      <select
        className="cgw-erp-select"
        aria-label={t('sortDirection', { n })}
        value={sortKey.direction}
        onChange={(event) =>
          onChange({ ...sortKey, direction: event.target.value === 'desc' ? 'desc' : 'asc' })
        }
      >
        <option value="asc">{t('ascending')}</option>
        <option value="desc">{t('descending')}</option>
      </select>
      <CgButton
        appearance="ghost"
        size="small"
        aria-label={t('removeSort', { n })}
        onClick={onRemove}
      >
        ×
      </CgButton>
    </div>
  );
}
