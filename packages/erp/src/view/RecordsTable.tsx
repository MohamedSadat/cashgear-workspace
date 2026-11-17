// A page of a query's records as a table, each value drawn by its field's type, with the range
// shown and paging by cursor. A native table: screen readers read its headers with each cell.
// Phase 7: with `edit`, the block's pending changes are drawn in place of what was read, marked,
// and an editable field's cells open an editor (`EditableCell`).
import { CgButton } from '@cashgear/ui';
import { useId } from 'react';
import type {
  ConnectorSchema,
  FieldSchema,
  Language,
  QueryResponse,
  SortKey,
  WireValue,
} from '../contract';
import type { ErpDraft } from '../drafts';
import { useErpT } from '../i18n';
import { EditableCell } from './editing';
import { cellText, formatInteger } from './format';
import { labelOf } from './settings';

/** What the table needs to show and take changes. */
export interface TableEditing {
  readonly draft: ErpDraft;
  /** Cells open an editor: the person chose "Edit data", and the draft is not locked. */
  readonly active: boolean;
}

export function RecordsTable({
  name,
  schema,
  columns,
  sort,
  response,
  language,
  from,
  canBack,
  onBack,
  onNext,
  edit,
}: {
  name: string;
  schema: ConnectorSchema;
  columns: readonly FieldSchema[];
  sort: readonly SortKey[];
  response: QueryResponse;
  language: Language;
  /** The first record's number in the whole result, from 1. */
  from: number;
  canBack: boolean;
  onBack: () => void;
  onNext: () => void;
  edit?: TableEditing;
}) {
  const { t, locale } = useErpT();
  const rangeId = useId();
  const records = response.records;
  const first = sort[0];
  const range = records.length
    ? t('range', {
        from: formatInteger(from, locale),
        to: formatInteger(from + records.length - 1, locale),
        total: formatInteger(response.total, locale),
      })
    : t('noRecords');
  return (
    <>
      <div
        className="cgw-erp-scroll"
        role="group"
        tabIndex={0}
        aria-label={t('scrollLabel', { name })}
        aria-describedby={rangeId}
      >
        <table className="cgw-erp-table" data-testid="erp-table">
          <caption className="cgw-erp-hidden">{t('tableLabel', { name })}</caption>
          <thead>
            <tr>
              {columns.map((field) => (
                <th
                  key={field.name}
                  scope="col"
                  data-field={field.name}
                  className={numeric(field) ? 'cgw-erp-num' : undefined}
                  aria-sort={
                    first?.field === field.name
                      ? first.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <span dir="auto">{labelOf(field, language)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const pending = edit?.draft.record(record.id);
              return (
                <tr
                  key={record.id}
                  data-key={record.key}
                  data-changed={pending ? 'true' : undefined}
                >
                  {columns.map((field) =>
                    edit && ((edit.active && field.editable) || pending?.changes[field.name]) ? (
                      <EditableCell
                        key={field.name}
                        field={field}
                        record={record}
                        records={records}
                        schema={schema}
                        draft={edit.draft}
                        locale={locale}
                        language={language}
                        disabled={!edit.active || !field.editable}
                        numeric={numeric(field)}
                      />
                    ) : (
                      <Cell
                        key={field.name}
                        field={field}
                        value={record.values[field.name]}
                        schema={schema}
                        locale={locale}
                      />
                    ),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cgw-erp-pager" role="group" aria-label={t('pages')}>
        <span id={rangeId} className="cgw-erp-muted" data-testid="erp-range">
          {range}
        </span>
        <CgButton appearance="ghost" size="small" disabled={!canBack} onClick={onBack}>
          {t('previousPage')}
        </CgButton>
        <CgButton appearance="ghost" size="small" disabled={!response.nextCursor} onClick={onNext}>
          {t('nextPage')}
        </CgButton>
      </div>
    </>
  );
}

export const numeric = (field: FieldSchema) => field.type === 'decimal' || field.type === 'integer';

function Cell({
  field,
  value,
  schema,
  locale,
}: {
  field: FieldSchema;
  value: WireValue | undefined;
  schema: ConnectorSchema;
  locale: string;
}) {
  return (
    <td className={numeric(field) ? 'cgw-erp-num' : undefined} data-field={field.name}>
      <CellBody field={field} value={value} schema={schema} locale={locale} />
    </td>
  );
}

/** A value as its field's type draws it, without the cell around it. */
export function CellBody({
  field,
  value,
  schema,
  locale,
}: {
  field: FieldSchema;
  value: WireValue | undefined;
  schema: ConnectorSchema;
  locale: string;
}) {
  const { t } = useErpT();
  const shown = cellText(field, value, schema, locale);
  switch (shown.kind) {
    case 'empty':
      return null;
    case 'boolean':
      return <>{t(shown.value ? 'yes' : 'no')}</>;
    case 'dateTime':
      return (
        <>
          <span>{shown.when}</span>{' '}
          <bdi dir="ltr" className="cgw-erp-offset">
            {shown.offset}
          </bdi>
        </>
      );
    case 'text':
      return shown.numeric ? <bdi>{shown.text}</bdi> : <span dir="auto">{shown.text}</span>;
  }
}
