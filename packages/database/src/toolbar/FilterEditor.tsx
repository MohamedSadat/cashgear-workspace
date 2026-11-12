// A view's filter: conditions and one level of groups, joined by "and" or "or"; each condition a
// property, an operator its kind takes (the core's `operatorsFor`), and a value editor for that
// kind. Each change is written to the view (text and numbers when the field is left or Enter is
// pressed, not per key). A condition on a deleted property stays, marked as ignored.
import { CgButton, CgDateEdit } from '@cashgear/ui';
import { useState, type ReactNode } from 'react';
import { CellFlyout } from '../cells/CellFlyout';
import {
  TITLE_PROPERTY,
  operatorsFor,
  parseNumberText,
  propertyKind,
  type DatabaseRecord,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type FilterValue,
  type PropertyDef,
  type QueryKind,
  type RelativeDate,
} from '../core';
import { useDatabaseContext } from '../context';
import type { RowRef } from '../host';
import { useDbT } from '../i18n';
import { liveProperties, noValue, propertyOf } from '../model/properties';
import {
  appendAt,
  removeAt,
  replaceAt,
  type FilterNode,
  type FilterPath,
} from '../model/viewConfig';
import { ListPicker } from '../pickers/ListPicker';
import { STATUS_GROUPS } from '../pickers/OptionPicker';

const RELATIVE: RelativeDate[] = [
  'today',
  'tomorrow',
  'yesterday',
  'oneWeekAgo',
  'oneWeekFromNow',
  'oneMonthAgo',
  'oneMonthFromNow',
];

/** The kind a property is filtered as; text for one with none (a formula that does not work). */
export const kindOf = (database: DatabaseRecord, def: PropertyDef): QueryKind =>
  propertyKind(database, def) ?? 'text';

/** The operator a new condition on a property starts with. */
export function defaultOperator(kind: QueryKind): FilterOperator {
  if (kind === 'text') return 'contains';
  if (kind === 'list') return 'contains';
  return operatorsFor(kind)[0];
}

export function newCondition(database: DatabaseRecord, def?: PropertyDef): FilterCondition {
  const target = def ?? propertyOf(database, TITLE_PROPERTY) ?? liveProperties(database)[0];
  const kind = kindOf(database, target);
  const condition: FilterCondition = {
    kind: 'condition',
    propertyId: target.id,
    operator: defaultOperator(kind),
  };
  if (kind === 'checkbox') condition.value = true;
  return condition;
}

export interface FilterEditorProps {
  database: DatabaseRecord;
  filter: FilterGroup | null;
  onChange(filter: FilterGroup | null): void;
  editable: boolean;
}

export function FilterEditor({ database, filter, onChange, editable }: FilterEditorProps) {
  const { t } = useDbT();
  const top: FilterGroup = filter ?? { kind: 'group', op: 'and', children: [] };
  const write = (next: FilterGroup) => onChange(next.children.length ? next : null);

  const renderGroup = (group: FilterGroup, path: FilterPath, nested: boolean): ReactNode => (
    <div
      className={nested ? 'cgw-filter-group' : 'cgw-filter-top'}
      role="group"
      aria-label={nested ? t('filter.group') : t('filter.title')}
    >
      {group.children.length === 0 ? (
        <p className="cgw-picker-note">{nested ? t('filter.emptyGroup') : t('filter.empty')}</p>
      ) : null}
      {group.children.map((child, i) => {
        const childPath = [...path, i];
        return (
          <div key={i} className="cgw-filter-line">
            <span className="cgw-filter-join">
              {i === 0 ? (
                t('filter.where')
              ) : i === 1 && editable ? (
                <select
                  className="cgw-select"
                  aria-label={t('filter.join')}
                  value={group.op}
                  onChange={(event) =>
                    write(
                      replaceAt(top, path, { ...group, op: event.target.value as 'and' | 'or' }),
                    )
                  }
                >
                  <option value="and">{t('filter.and')}</option>
                  <option value="or">{t('filter.or')}</option>
                </select>
              ) : (
                t(group.op === 'and' ? 'filter.and' : 'filter.or')
              )}
            </span>
            {child.kind === 'group' ? (
              <div className="cgw-filter-nested">
                {renderGroup(child, childPath, true)}
                {editable ? (
                  <div className="cgw-filter-actions">
                    <CgButton
                      appearance="ghost"
                      size="small"
                      onClick={() => write(appendAt(top, childPath, newCondition(database)))}
                    >
                      {t('filter.add')}
                    </CgButton>
                    <CgButton
                      appearance="ghost"
                      size="small"
                      intent="danger"
                      onClick={() => write(removeAt(top, childPath))}
                    >
                      {t('filter.removeGroup')}
                    </CgButton>
                  </div>
                ) : null}
              </div>
            ) : (
              <ConditionRow
                database={database}
                condition={child}
                editable={editable}
                onChange={(next: FilterNode) => write(replaceAt(top, childPath, next))}
                onRemove={() => write(removeAt(top, childPath))}
              />
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="cgw-filter-editor">
      {renderGroup(top, [], false)}
      {editable ? (
        <div className="cgw-filter-actions">
          <CgButton
            appearance="outline"
            size="small"
            data-cg-initial-focus=""
            onClick={() => write(appendAt(top, [], newCondition(database)))}
          >
            {t('filter.add')}
          </CgButton>
          <CgButton
            appearance="ghost"
            size="small"
            onClick={() =>
              write(
                appendAt(top, [], {
                  kind: 'group',
                  op: top.op === 'and' ? 'or' : 'and',
                  children: [newCondition(database)],
                }),
              )
            }
          >
            {t('filter.addGroup')}
          </CgButton>
        </div>
      ) : null}
    </div>
  );
}

function ConditionRow({
  database,
  condition,
  editable,
  onChange,
  onRemove,
}: {
  database: DatabaseRecord;
  condition: FilterCondition;
  editable: boolean;
  onChange(condition: FilterCondition): void;
  onRemove(): void;
}) {
  const { t } = useDbT();
  const def = propertyOf(database, condition.propertyId);
  const live = liveProperties(database);
  const ignored = !def || Boolean(def.trashedAt);
  const kind = def ? kindOf(database, def) : 'text';
  const ops = operatorsFor(kind);

  return (
    <div className="cgw-filter-condition" data-ignored={ignored || undefined}>
      <select
        className="cgw-select"
        aria-label={t('filter.property')}
        value={condition.propertyId}
        disabled={!editable}
        onChange={(event) => {
          const next = propertyOf(database, event.target.value);
          if (next) onChange(newCondition(database, next));
        }}
      >
        {ignored ? <option value={condition.propertyId}>{def?.name ?? '—'}</option> : null}
        {live.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        className="cgw-select"
        aria-label={t('filter.operator')}
        value={condition.operator}
        disabled={!editable || ignored}
        onChange={(event) => {
          const operator = event.target.value as FilterOperator;
          const next: FilterCondition = { ...condition, operator };
          if (noValue(operator)) delete next.value;
          if (operator === 'group' || condition.operator === 'group') delete next.value;
          onChange(next);
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`filter.op.${op}`)}
          </option>
        ))}
      </select>
      {!noValue(condition.operator) && def && !ignored ? (
        <ValueEditor
          def={def}
          kind={kind}
          condition={condition}
          editable={editable}
          onChange={(value) => onChange({ ...condition, value })}
        />
      ) : null}
      {editable ? (
        <button
          type="button"
          className="cgw-icon-button"
          aria-label={t('filter.remove')}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
      {ignored ? <p className="cgw-picker-note">{t('filter.ignored')}</p> : null}
    </div>
  );
}

function TextValue({
  value,
  label,
  number,
  disabled,
  onCommit,
}: {
  value: string;
  label: string;
  number?: boolean;
  disabled: boolean;
  onCommit(text: string): void;
}) {
  return (
    <input
      className="cgw-text-input"
      aria-label={label}
      defaultValue={value}
      key={value}
      dir="auto"
      inputMode={number ? 'decimal' : undefined}
      disabled={disabled}
      onBlur={(event) => event.target.value !== value && onCommit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(event.currentTarget.value);
        }
      }}
    />
  );
}

function ValueEditor({
  def,
  kind,
  condition,
  editable,
  onChange,
}: {
  def: PropertyDef;
  kind: QueryKind;
  condition: FilterCondition;
  editable: boolean;
  onChange(value: FilterValue | undefined): void;
}) {
  const { t, locale } = useDbT();
  const { host } = useDatabaseContext();
  const value = condition.value;
  const label = t('filter.value');

  if (condition.operator === 'group')
    return (
      <select
        className="cgw-select"
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        disabled={!editable}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">{t('filter.pick')}</option>
        {STATUS_GROUPS.map((g) => (
          <option key={g} value={g}>
            {t(`status.${g}`)}
          </option>
        ))}
      </select>
    );

  switch (kind) {
    case 'text':
      return (
        <TextValue
          value={typeof value === 'string' ? value : ''}
          label={label}
          disabled={!editable}
          onCommit={(text) => onChange(text === '' ? undefined : text)}
        />
      );
    case 'number':
      return (
        <TextValue
          value={typeof value === 'number' ? String(value) : ''}
          label={label}
          number
          disabled={!editable}
          onCommit={(text) => onChange(parseNumberText(text))}
        />
      );
    case 'checkbox':
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={value === false ? 'false' : 'true'}
          disabled={!editable}
          onChange={(event) => onChange(event.target.value === 'true')}
        >
          <option value="true">{t('filter.checked')}</option>
          <option value="false">{t('filter.unchecked')}</option>
        </select>
      );
    case 'date': {
      const relative =
        typeof value === 'object' && value !== null && 'relative' in value ? value.relative : null;
      const exact =
        typeof value === 'object' && value !== null && 'date' in value ? value.date : null;
      return (
        <span className="cgw-filter-date">
          <select
            className="cgw-select"
            aria-label={label}
            value={relative ?? (exact !== null ? 'exact' : '')}
            disabled={!editable}
            onChange={(event) => {
              const v = event.target.value;
              if (!v) onChange(undefined);
              else if (v === 'exact')
                onChange({ date: exact ?? new Date().toISOString().slice(0, 10) });
              else onChange({ relative: v as RelativeDate });
            }}
          >
            <option value="">{t('filter.pick')}</option>
            {RELATIVE.map((r) => (
              <option key={r} value={r}>
                {t(`filter.relative.${r}`)}
              </option>
            ))}
            <option value="exact">{t('filter.exactDate')}</option>
          </select>
          {exact !== null ? (
            <CgDateEdit
              locale={locale}
              value={exact}
              aria-label={t('filter.exactDate')}
              disabled={!editable}
              onValueChange={(date) => onChange(date ? { date } : undefined)}
            />
          ) : null}
        </span>
      );
    }
    case 'select':
    case 'status':
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={!editable}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{t('filter.pick')}</option>
          {(def.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'list': {
      if (def.type === 'multiSelect' || (def.type === 'rollup' && def.options))
        return (
          <select
            className="cgw-select"
            aria-label={label}
            value={typeof value === 'string' ? value : ''}
            disabled={!editable}
            onChange={(event) => onChange(event.target.value || undefined)}
          >
            <option value="">{t('filter.pick')}</option>
            {(def.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        );
      if (def.type === 'relation')
        return (
          <RelationValue
            databaseId={def.relation?.databaseId ?? null}
            value={typeof value === 'string' ? value : null}
            disabled={!editable}
            onChange={(id) => onChange(id ?? undefined)}
          />
        );
      const me = typeof value === 'object' && value !== null && 'me' in value;
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={me ? '\u0000me' : typeof value === 'string' ? value : ''}
          disabled={!editable}
          onChange={(event) => {
            const v = event.target.value;
            onChange(v === '\u0000me' ? { me: true } : v || undefined);
          }}
        >
          <option value="">{t('filter.pick')}</option>
          <option value={'\u0000me'}>{t('filter.me')}</option>
          {host.people().map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    }
    default:
      return null;
  }
}

/** A related row chosen as a filter's value, from a search of the related database. */
function RelationValue({
  databaseId,
  value,
  disabled,
  onChange,
}: {
  databaseId: string | null;
  value: string | null;
  disabled: boolean;
  onChange(id: string | null): void;
}) {
  const { t } = useDbT();
  const { host } = useDatabaseContext();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<RowRef[]>([]);
  const title = value ? (host.pageTitle(value) ?? t('relation.unknown')) : t('filter.pick');
  const search = (q: string) => {
    setQuery(q);
    if (!databaseId) return;
    void host.searchRows(databaseId, q, { limit: 20 }).then(setRows, () => setRows([]));
  };
  return (
    <>
      <button
        type="button"
        className="cgw-select cgw-select-button"
        aria-label={t('filter.value')}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          search('');
        }}
      >
        <span dir="auto">{title || t('untitled')}</span>
      </button>
      {anchor ? (
        <CellFlyout anchor={anchor} label={t('relation.search')} onClose={() => setAnchor(null)}>
          <ListPicker
            items={rows.map((r) => ({ id: r.id, label: r.title || t('untitled') }))}
            selected={value ? [value] : []}
            multiple={false}
            onSelect={(ids) => {
              onChange(ids[0] ?? null);
              setAnchor(null);
            }}
            chip={(id) => ({ label: host.pageTitle(id) ?? t('relation.unknown') })}
            query={query}
            onQuery={search}
            searchLabel={t('relation.search')}
            emptyText={t('relation.none')}
            listLabel={t('relation.list')}
          />
        </CellFlyout>
      ) : null}
    </>
  );
}
