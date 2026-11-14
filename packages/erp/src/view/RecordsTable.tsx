// A page of a query's records as a table, each value drawn by its field's type, with the range
// shown and paging by cursor. A native table: screen readers read its headers with each cell.
import { CgButton } from '@cashgear/ui';
import { useId } from 'react';
import type { ConnectorSchema, FieldSchema, Language, QueryResponse, SortKey } from '../contract';
import { useErpT } from '../i18n';
import { cellText, formatInteger } from './format';
import { labelOf } from './settings';

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
            {records.map((record) => (
              <tr key={record.id}>
                {columns.map((field) => (
                  <Cell
                    key={field.name}
                    field={field}
                    value={record.values[field.name]}
                    schema={schema}
                    locale={locale}
                  />
                ))}
              </tr>
            ))}
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

const numeric = (field: FieldSchema) => field.type === 'decimal' || field.type === 'integer';

function Cell({
  field,
  value,
  schema,
  locale,
}: {
  field: FieldSchema;
  value: Parameters<typeof cellText>[1];
  schema: ConnectorSchema;
  locale: string;
}) {
  const { t } = useErpT();
  const shown = cellText(field, value, schema, locale);
  switch (shown.kind) {
    case 'empty':
      return <td />;
    case 'boolean':
      return <td>{t(shown.value ? 'yes' : 'no')}</td>;
    case 'dateTime':
      return (
        <td>
          <span>{shown.when}</span>{' '}
          <bdi dir="ltr" className="cgw-erp-offset">
            {shown.offset}
          </bdi>
        </td>
      );
    case 'text':
      return shown.numeric ? (
        <td className="cgw-erp-num">
          <bdi>{shown.text}</bdi>
        </td>
      ) : (
        <td>
          <span dir="auto">{shown.text}</span>
        </td>
      );
  }
}
