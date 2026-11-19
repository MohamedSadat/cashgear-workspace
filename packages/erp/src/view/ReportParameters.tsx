// A report's parameters above its table (Phase 12, INTEGRATIONS.md, "Workspace's block"): a date
// picker, a choice or a lookup as a list, a switch, each named by its label. An editor's change is
// written to the block's `parameters` at once, which runs the report again; a value equal to the
// parameter's default is not held, so a date left at "Today" keeps tracking the day. A reader who
// may not edit the page sees the same controls read-only, and the report runs with what is held.
import { CgDateEdit, CgSelect, CgSwitch, type CgSelectOption } from '@cashgear/ui';
import { useId, type ReactNode } from 'react';
import {
  PARAMETER_DATES,
  type ConnectorSchema,
  type Language,
  type ParameterValue,
  type ReportParameter,
} from '../contract';
import { useErpT, type ErpT } from '../i18n';
import { formatDate } from './format';
import type { ErpViewHost } from './host';
import { labelOf, parameterDefault, parametersText, parameterValueValid } from './settings';

export function ReportParameters({
  host,
  schema,
  held,
  language,
}: {
  host: ErpViewHost;
  schema: ConnectorSchema;
  /** What the block holds, names the schema does not list included. */
  held: Readonly<Record<string, ParameterValue>>;
  language: Language;
}) {
  const { t } = useErpT();
  const heading = useId();
  const parameters = schema.parameters ?? [];
  if (!parameters.length) return null;
  const readOnly = !host.editable;
  const write = (parameter: ReportParameter, value: ParameterValue | undefined) => {
    if (readOnly) return;
    const next = parametersText(held, parameter, value);
    if (next !== parametersText(held, parameter, held[parameter.name])) {
      host.setAttrs({ parameters: next });
    }
  };
  return (
    <div
      className="cgw-erp-parameters"
      role="group"
      aria-labelledby={heading}
      data-testid="erp-parameters"
    >
      <span id={heading} className="cgw-erp-hidden">
        {t('reportSettings')}
      </span>
      {parameters.map((parameter) => (
        <Parameter
          key={parameter.name}
          parameter={parameter}
          schema={schema}
          value={shownValue(parameter, held)}
          held={Object.prototype.hasOwnProperty.call(held, parameter.name)}
          language={language}
          readOnly={readOnly}
          onChange={(value) => write(parameter, value)}
        />
      ))}
    </div>
  );
}

/** The value a control shows: what the block holds when its type takes it, else the default. */
function shownValue(
  parameter: ReportParameter,
  held: Readonly<Record<string, ParameterValue>>,
): ParameterValue {
  const value = held[parameter.name];
  if (value !== undefined && parameterValueValid(parameter, value)) return value;
  return parameterDefault(parameter);
}

/** What an absent date shows in its place: its default read as words, or as a date. */
function datePlaceholder(parameter: ReportParameter, t: ErpT, locale: string): string | undefined {
  const fallback = parameter.default;
  if (fallback === 'today') return t('defaultToday');
  if (fallback === 'monthStart') return t('defaultMonthStart');
  if (typeof fallback === 'string') return formatDate(fallback, locale);
  return parameter.required ? t('parameterChoose') : t('parameterNotSet');
}

function Parameter({
  parameter,
  schema,
  value,
  held,
  language,
  readOnly,
  onChange,
}: {
  parameter: ReportParameter;
  schema: ConnectorSchema;
  value: ParameterValue;
  /** Whether the block holds a value for it (a date otherwise shows its default as words). */
  held: boolean;
  language: Language;
  readOnly: boolean;
  /** Undefined: back to the default. */
  onChange: (value: ParameterValue | undefined) => void;
}) {
  const { t, locale } = useErpT();
  const id = useId();
  const label = labelOf(parameter, language);
  const labelled = (control: ReactNode) => (
    <span className="cgw-erp-field cgw-erp-parameter" data-parameter={parameter.name}>
      <label htmlFor={id} dir="auto">
        {label}
      </label>
      {control}
    </span>
  );

  switch (parameter.type) {
    case 'date': {
      // A date the person set; else the default (today, a month's start) as words, not a day.
      const date = held && typeof value === 'string' ? value : null;
      return labelled(
        <CgDateEdit
          id={id}
          value={date}
          locale={locale}
          size="small"
          readOnly={readOnly}
          required={parameter.required && parameter.default === undefined}
          minDate={PARAMETER_DATES.min}
          maxDate={PARAMETER_DATES.max}
          placeholder={datePlaceholder(parameter, t, locale)}
          invalidFormatMessage={t('dateInvalid')}
          outOfRangeMessage={t('dateRange')}
          labels={{
            calendarDialog: t('dateCalendar'),
            openCalendar: t('dateOpen'),
            clearDate: t('dateClear'),
            previousPeriod: t('datePrevious'),
            nextPeriod: t('dateNext'),
            chooseMonthAndYear: t('dateMonthYear'),
            chooseYear: t('dateYear'),
            today: t('dateToday'),
            clear: t('dateClearButton'),
            selected: t('dateSelected'),
            unavailable: t('dateUnavailable'),
          }}
          onValueChange={(next) => onChange(next ?? undefined)}
        />,
      );
    }
    case 'choice': {
      const options: CgSelectOption[] = (parameter.options ?? []).map((option) => ({
        value: option.value,
        label: option.label[language] || option.label.en,
      }));
      const empty = parameter.default === undefined;
      return labelled(
        <CgSelect
          id={id}
          size="small"
          options={options}
          value={typeof value === 'string' ? value : null}
          readOnly={readOnly}
          required={parameter.required}
          {...(empty
            ? { placeholder: parameter.required ? t('parameterChoose') : t('parameterNotSet') }
            : {})}
          onValueChange={(next) => onChange(next)}
        />,
      );
    }
    case 'lookup': {
      const items = parameter.lookup ? (schema.lookups[parameter.lookup] ?? []) : [];
      const options: CgSelectOption[] = items
        .filter((item) => item.active !== false || item.code === value)
        .map((item) => ({ value: item.code, label: item.label || item.code }));
      return labelled(
        <CgSelect
          id={id}
          size="small"
          options={options}
          value={typeof value === 'string' ? value : null}
          readOnly={readOnly}
          required={parameter.required}
          // Not required: the first entry is "All" (no value), as the ERP's own page offers it.
          placeholder={parameter.required ? t('parameterChoose') : t('parameterAll')}
          onValueChange={(next) => onChange(next)}
        />,
      );
    }
    case 'boolean':
      return (
        <span className="cgw-erp-field cgw-erp-parameter" data-parameter={parameter.name}>
          <CgSwitch
            id={id}
            size="small"
            checked={value === true}
            readOnly={readOnly}
            label={<span dir="auto">{label}</span>}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </span>
      );
  }
}
