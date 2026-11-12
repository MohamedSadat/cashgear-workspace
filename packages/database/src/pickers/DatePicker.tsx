// A date cell's editor: a calendar (one day, or a span with "End date" on), the time of day when
// the property includes it, and Clear. Dates are calendar dates; with the time they are written as
// UTC instants made from the person's own time zone, and read back into it.
import { CgCalendar, CgSwitch, CgTimeEdit } from '@cashgear/ui';
import { useState } from 'react';
import type { DateValue } from '../core';
import { useDbT } from '../i18n';
import { isInstant } from '../model/format';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** One end of a value as a local calendar date and time of day (`HH:mm`, null for none). */
export function splitPoint(point: string): { date: string; time: string | null } {
  if (!isInstant(point)) return { date: point.slice(0, 10), time: null };
  const d = new Date(point);
  if (Number.isNaN(d.getTime())) return { date: point.slice(0, 10), time: null };
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** A local date and time of day as the stored form: a UTC instant, or the date alone. */
export function joinPoint(date: string, time: string | null): string {
  if (!time) return date;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const local = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  if (Number.isNaN(local.getTime())) return date;
  return `${local.toISOString().slice(0, 19)}Z`;
}

/** Today in the person's own calendar. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface Draft {
  start: string | null;
  startTime: string | null;
  end: string | null;
  endTime: string | null;
  hasEnd: boolean;
}

function draftOf(value: DateValue | null): Draft {
  if (!value) return { start: null, startTime: null, end: null, endTime: null, hasEnd: false };
  const start = splitPoint(value.start);
  const end = value.end ? splitPoint(value.end) : null;
  return {
    start: start.date,
    startTime: start.time,
    end: end?.date ?? null,
    endTime: end?.time ?? null,
    hasEnd: Boolean(end),
  };
}

function valueOf(draft: Draft, includeTime: boolean): DateValue | null {
  if (!draft.start) return null;
  const start = joinPoint(draft.start, includeTime ? draft.startTime : null);
  if (!draft.hasEnd || !draft.end) return { start };
  return { start, end: joinPoint(draft.end, includeTime ? draft.endTime : null) };
}

const toClock = (t: string | null) => (t ? `${t}:00.000` : null);
const fromClock = (t: string | null) => (t ? t.slice(0, 5) : null);

export interface DatePickerProps {
  value: DateValue | null;
  includeTime: boolean;
  /** Every change of the draft; the cell writes the last one when it closes. */
  onChange(value: DateValue | null): void;
  /** A choice that ends the edit (a day picked without a time to set, Clear). */
  onDone(): void;
}

export function DatePicker({ value, includeTime, onChange, onDone }: DatePickerProps) {
  const { t, locale } = useDbT();
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const update = (next: Draft, done = false) => {
    setDraft(next);
    onChange(valueOf(next, includeTime));
    if (done) onDone();
  };

  return (
    <div className="cgw-date-picker">
      {draft.hasEnd ? (
        <CgCalendar
          selectionMode="range"
          locale={locale}
          today={localToday()}
          value={draft.start ? { start: draft.start, end: draft.end } : null}
          defaultVisibleDate={draft.start ?? localToday()}
          autoFocus
          onValueChange={(range) =>
            update(
              { ...draft, start: range?.start ?? null, end: range?.end ?? null },
              !includeTime && Boolean(range?.start && range?.end),
            )
          }
        />
      ) : (
        <CgCalendar
          locale={locale}
          today={localToday()}
          value={draft.start}
          defaultVisibleDate={draft.start ?? localToday()}
          autoFocus
          onValueChange={(day) => update({ ...draft, start: day }, !includeTime && Boolean(day))}
        />
      )}
      {includeTime ? (
        <div className="cgw-date-times">
          <label className="cgw-field-row">
            <span>{t('date.time')}</span>
            <CgTimeEdit
              locale={locale}
              value={toClock(draft.startTime)}
              onValueChange={(time) => update({ ...draft, startTime: fromClock(time) })}
              aria-label={t('date.time')}
            />
          </label>
          {draft.hasEnd ? (
            <label className="cgw-field-row">
              <span>{t('date.endTime')}</span>
              <CgTimeEdit
                locale={locale}
                value={toClock(draft.endTime)}
                onValueChange={(time) => update({ ...draft, endTime: fromClock(time) })}
                aria-label={t('date.endTime')}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="cgw-date-actions">
        <CgSwitch
          checked={draft.hasEnd}
          label={t('date.end')}
          onCheckedChange={(on) =>
            update({ ...draft, hasEnd: on, end: on ? (draft.end ?? draft.start) : null })
          }
        />
        <button
          type="button"
          className="cgw-text-button"
          onClick={() =>
            update({ start: null, startTime: null, end: null, endTime: null, hasEnd: false }, true)
          }
        >
          {t('date.clear')}
        </button>
      </div>
    </div>
  );
}
