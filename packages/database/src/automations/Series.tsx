// A repeating row's settings in the rule editor (Phase 17, M17.2): the template each row is made
// from, the day the series starts, its repetition (the library's recurrence fields, Track U21),
// whether a row comes on each of its days or once the last one is done, the time of day, and the
// date property its day goes into. Its summary for the list says the same in a sentence. Loaded
// with the rule editor, never with the views.
import {
  CgRecurrenceFields,
  cgSummarizeRecurrence,
  type CgRecurrenceFieldsLabels,
  type CgRecurrenceRepeat,
  type CgRecurrenceRule,
  type CgRecurrenceSummaryWords,
} from '@cashgear/ui';
import type { Id, RowRecord } from '@cgw/workspace';
import type { AutomationTrigger, DatabaseRecord, RecurrenceRule } from '../core';
import { liveProperties } from '../model/properties';
import { Field } from './StepList';
import type { AutoKey, AutoT } from './words';

type Series = Extract<AutomationTrigger, { kind: 'recurring' }>;

const REPEATS: CgRecurrenceRepeat[] = ['daily', 'weekly', 'monthly', 'yearly'];

/** The recurrence fields' words, every one the automations' own. */
export function recurrenceLabels(at: AutoT): CgRecurrenceFieldsLabels {
  return {
    legend: at('series.legend'),
    frequency: at('series.frequency'),
    frequencies: {
      daily: at('series.daily'),
      weekly: at('series.weekly'),
      monthly: at('series.monthly'),
      yearly: at('series.yearly'),
    },
    interval: at('series.interval'),
    intervalUnit: (frequency, interval) =>
      at(`series.${interval === 1 ? 'unitOne' : 'unitMany'}.${frequency}` as AutoKey),
    weekDays: at('series.weekDays'),
    weekOfMonth: at('series.weekOfMonth'),
    weeksOfMonth: {
      none: at('series.weeks.none'),
      first: at('series.weeks.first'),
      second: at('series.weeks.second'),
      third: at('series.weeks.third'),
      fourth: at('series.weeks.fourth'),
      last: at('series.weeks.last'),
    },
    dayOfMonth: at('series.dayOfMonth'),
    month: at('series.month'),
    range: at('series.range'),
    ranges: {
      noEndDate: at('series.noEndDate'),
      occurrenceCount: at('series.occurrenceCount'),
      endByDate: at('series.endByDate'),
    },
    occurrenceCount: at('series.count'),
    endDate: at('series.endDate'),
  };
}

/** The words a repetition is summed up in (names of days and months, lists and dates from Intl). */
export function summaryWords(at: AutoT): CgRecurrenceSummaryWords {
  return {
    none: at('series.none'),
    every: (frequency, interval) =>
      interval === 1
        ? at(`series.every.${frequency}` as AutoKey)
        : interval === 2
          ? at(`series.everyTwo.${frequency}` as AutoKey)
          : at(`series.everyN.${frequency}` as AutoKey, { number: interval }),
    onWeekDays: (days) => at('series.onWeekDays', { days }),
    onDayOfMonth: (day) => at('series.onDayOfMonth', { day }),
    onDate: (month, day) => at('series.onDate', { month, day }),
    onWeekOfMonth: (week, days) =>
      at('series.onWeekOfMonth', { week: at(`series.onWeek.${week}` as AutoKey), days }),
    ofMonth: (month) => at('series.ofMonth', { month }),
    times: (count) => at('series.times', { number: count }),
    until: (date) => at('series.until', { date }),
  };
}

/** What a repeating row's rule does, in a sentence for the list. */
export function seriesText(
  trigger: Series,
  at: AutoT,
  locale: string,
  templateName: (id: Id) => string | undefined,
): string {
  const when = cgSummarizeRecurrence(trigger.rule as CgRecurrenceRule, summaryWords(at), {
    locale,
    start: trigger.start,
  });
  const template = templateName(trigger.templateId) || at('series.missingTemplate');
  return at(trigger.mode === 'done' ? 'series.summaryDone' : 'series.summaryDate', {
    template,
    when,
  });
}

/** The repeating row's settings. */
export function SeriesEditor({
  database,
  trigger,
  templates,
  onChange,
  at,
  locale,
}: {
  database: DatabaseRecord;
  trigger: Series;
  templates: readonly RowRecord[];
  onChange(trigger: AutomationTrigger): void;
  at: AutoT;
  locale: string;
}) {
  const dates = liveProperties(database).filter((p) => p.type === 'date');
  const dones = liveProperties(database).filter(
    (p) => p.type === 'checkbox' || p.type === 'status',
  );
  if (!templates.length) return <p className="cgw-db-auto-note">{at('series.noTemplate')}</p>;
  return (
    <>
      <Field label={at('series.template')}>
        <select
          className="cgw-select"
          value={trigger.templateId}
          onChange={(event) => onChange({ ...trigger, templateId: event.target.value })}
        >
          {/* A template deleted since stays shown until another is chosen. */}
          {templates.some((t) => t.id === trigger.templateId) ? null : (
            <option value={trigger.templateId}>{at('series.missingTemplate')}</option>
          )}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || at('untitled')}
            </option>
          ))}
        </select>
      </Field>
      <Field label={at('series.start')}>
        <input
          type="date"
          className="cgw-text-input cgw-db-auto-short"
          value={trigger.start}
          required
          onChange={(event) =>
            event.target.value && onChange({ ...trigger, start: event.target.value })
          }
        />
      </Field>
      <CgRecurrenceFields
        className="cgw-db-auto-series"
        value={trigger.rule as CgRecurrenceRule}
        frequencies={REPEATS}
        dailyWeekDays
        start={trigger.start}
        locale={locale}
        labels={recurrenceLabels(at)}
        onChange={(rule) => onChange({ ...trigger, rule: rule as unknown as RecurrenceRule })}
      />
      <Field label={at('series.mode')}>
        <select
          className="cgw-select"
          value={trigger.mode}
          onChange={(event) => {
            const mode = event.target.value as 'date' | 'done';
            onChange({
              ...trigger,
              mode,
              doneProperty: mode === 'done' ? (trigger.doneProperty ?? dones[0]?.id ?? null) : null,
            });
          }}
        >
          <option value="date">{at('series.modeDate')}</option>
          <option value="done">{at('series.modeDone')}</option>
        </select>
      </Field>
      {trigger.mode === 'done' ? (
        dones.length ? (
          <Field label={at('series.done')}>
            <select
              className="cgw-select"
              value={trigger.doneProperty ?? ''}
              onChange={(event) => onChange({ ...trigger, doneProperty: event.target.value })}
            >
              {dones.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="cgw-db-auto-note">{at('series.noDone')}</p>
        )
      ) : (
        <Field label={at('series.at')}>
          <input
            type="time"
            className="cgw-text-input cgw-db-auto-short"
            value={trigger.at ?? '09:00'}
            onChange={(event) => onChange({ ...trigger, at: event.target.value || null })}
          />
        </Field>
      )}
      <Field label={at('series.dateProperty')}>
        <select
          className="cgw-select"
          value={trigger.dateProperty ?? ''}
          onChange={(event) => onChange({ ...trigger, dateProperty: event.target.value || null })}
        >
          <option value="">{at('series.noDateProperty')}</option>
          {dates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="cgw-db-auto-note">{at('series.help')}</p>
    </>
  );
}
