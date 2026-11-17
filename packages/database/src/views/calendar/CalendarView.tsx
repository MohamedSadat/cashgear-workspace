// The calendar view: a month of the rows by the view's `calendarBy` date property (or a prompt to
// choose one), drawn by the library's `CgMonthCalendar`: spans across the days they cover (a
// zero-length row and an end on or before the start take one day; ends are inclusive), "+N more"
// where a day is full, previous, next and today, the week starting on the locale's first day
// (Saturday in Arabic, Sunday in English unless `Intl` says otherwise); and the rows with no date
// in a side list of the view's own. The grid mirrors in RTL.
//
// Its rows come by queries of its own (Phase 9; `ownRows` in the registry): the rows whose dates
// meet the month shown and a week on each side (a date window, which the server answers for a
// database it queries, so a month of a 50,000-row database fetches only that month), every page of
// it up to `LOCAL_ROW_LIMIT`; and the rows with no date (its own query, paged as the list scrolls).
//
// A row moves to another day by dragging it, or with Alt and the arrow keys on it (it keeps its
// time and its length: one `row.update`). A row with no date is dragged from the list onto a day
// (the calendar finds and marks the day under the pointer: `dayAt`, `markDropDay`) or placed on
// the selected one. A day's "+" (or Enter, or a double click, or the toolbar's New) makes a row
// there, its title typed before the row exists. The days are one grid stop: the arrows, Home,
// End, PageUp and PageDown move between them.
import {
  CgLiveAnnouncer,
  CgMonthCalendar,
  cgStartsDrag,
  cgTrackDrag,
  type CgDayOfWeek,
  type CgLiveAnnouncerHandle,
  type CgMonthCalendarHandle,
  type CgMonthCalendarItem,
  type CgMonthCalendarLabels,
} from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { CellFlyout } from '../../cells/CellFlyout';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import { TITLE_PROPERTY, type DatabaseRecord, type PropertyDef, type ViewRecord } from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { formatDatePart } from '../../model/format';
import { isDateType, liveProperties, propertyOf, uniqueName } from '../../model/properties';
import { newPropertyDef } from '../../properties/defs';
import { draftRow } from '../board/shared';
import type { ViewProps } from '../types';
import {
  dateOfDay,
  dayNumber,
  daysInMonth,
  firstOfMonth,
  monthOf,
  shiftDays,
  weekStartOf,
  type Month,
} from './dates';
import { calendarItems, type CalendarItem } from './layout';
import { undatedRequest, windowRequest } from './requests';
import { Undated } from './Undated';
import { useWindowRows } from './useWindowRows';
import '../board/card.css';
import './calendar.css';

/** Days fetched on each side of the month shown. */
export const CALENDAR_MARGIN = 7;
/** `weekStartOf`'s 1 (Monday) to 7 (Sunday), as the calendar names them. */
const WEEKDAYS: readonly CgDayOfWeek[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const pad = (n: number) => String(n).padStart(2, '0');
const monthText = (month: Month) => `${String(month.year).padStart(4, '0')}-${pad(month.month)}`;

export function CalendarView({ database, view, request, embedded, newRowRequest }: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t, locale } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const idPrefix = `c${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const def = view.config.calendarBy ? propertyOf(database, view.config.calendarBy) : undefined;
  const usable = !!def && !def.trashedAt && isDateType(def.type);
  const writable = editable && def?.type === 'date';
  const ctx = host.queryContext();
  const today = dayNumber(ctx.today);
  const weekStart = useMemo(() => weekStartOf(locale), [locale]);

  const [month, setMonth] = useState<Month>(() => monthOf(ctx.today));
  const [activeDay, setActiveDay] = useState(today);
  const [popup, setPopup] = useState<{ day: number; anchor: HTMLElement } | null>(null);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const live = useRef<CgLiveAnnouncerHandle>(null);
  const calendar = useRef<CgMonthCalendarHandle>(null);
  const first = dayNumber(firstOfMonth(month));
  const last = first + daysInMonth(month.year, month.month) - 1;

  // The month and a week on each side, every page of it; and the rows with no date, paged.
  const datedRequest = useMemo(
    () =>
      request && usable && def
        ? windowRequest(request, {
            propertyId: def.id,
            from: dateOfDay(first - CALENDAR_MARGIN),
            to: dateOfDay(last + CALENDAR_MARGIN),
          })
        : null,
    [request, usable, def, first, last],
  );
  const noDateRequest = useMemo(
    () => (request && usable && def ? undatedRequest(request, def.id) : null),
    [request, usable, def],
  );
  const dated = useWindowRows(host, database.id, datedRequest);
  const undatedRows = useWindowRows(host, database.id, noDateRequest, Infinity);
  const undated = undatedRows.rows;
  const snapshot = dated.snapshot;

  const items = useMemo(
    () => (usable && def ? calendarItems(dated.rows, def, ctx.offsetMinutes).items : []),
    [dated.rows, def, usable, ctx.offsetMinutes],
  );
  // The rows as the calendar takes them: their days on the person's own calendar (a date-time
  // with its time there), so the grid places them as the cells do.
  const entries = useMemo<CgMonthCalendarItem<CalendarItem>[]>(
    () =>
      items.map((item) => ({
        key: item.row.id,
        title: item.row.title,
        start: item.time ? `${dateOfDay(item.start)}T${item.time}` : dateOfDay(item.start),
        end: item.end > item.start ? dateOfDay(item.end) : null,
        movable: writable,
        data: item,
      })),
    [items, writable],
  );

  // ---- Changes --------------------------------------------------------------------------------
  /** Puts a row with no date on a day: one `row.update`, said aloud. */
  const placeRow = (row: RowRecord, day: number) => {
    if (!def || !writable) {
      live.current?.announce(t('calendar.fixedDate'));
      return;
    }
    const start = dateOfDay(day);
    void actions.setValue(row, def, { start });
    live.current?.announce(
      t('calendar.moved', {
        title: row.title || t('untitled'),
        date: formatDatePart(start, locale),
      }),
    );
  };
  const createOn = (day: number, title: string) => {
    if (!def || !title.trim()) return;
    void actions.createRow({ title, view, values: { [def.id]: { start: dateOfDay(day) } } });
  };

  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    if (!writable) {
      void actions.createRow({ view });
      return;
    }
    const day = activeDay >= first && activeDay <= last ? activeDay : today;
    calendar.current?.startCreate(dateOfDay(day));
    // Only a new press of the toolbar's New opens it: the other values are read as they are now.
  }, [newRowRequest]);

  // ---- A row with no date dragged onto a day --------------------------------------------------------
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const rowsById = useMemo(() => new Map(undated.map((r) => [r.id, r])), [undated]);
  const onUndatedPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !writable) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-cal-drag]');
    if (!el || !cgStartsDrag(event.target, el)) return;
    const row = rowsById.get(el.dataset.rowId ?? '');
    if (!row) return;
    let target: string | null = null;
    stopDrag.current?.();
    stopDrag.current = cgTrackDrag(event.nativeEvent, el, {
      ghostClassName: 'cgw-drag-ghost',
      onMove(x, y) {
        const day = calendar.current?.dayAt(x, y) ?? null;
        if (day === target) return;
        target = day;
        calendar.current?.markDropDay(day);
      },
      onDrop(x, y) {
        calendar.current?.markDropDay(null);
        stopDrag.current = null;
        // Where the pointer was let go, not where the last frame saw it.
        const day = calendar.current?.dayAt(x, y) ?? target;
        if (day) placeRow(row, dayNumber(day));
      },
      onCancel() {
        calendar.current?.markDropDay(null);
        stopDrag.current = null;
      },
    });
  };

  // ---- Drawing -------------------------------------------------------------------------------------
  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const labels = useMemo<CgMonthCalendarLabels<CalendarItem>>(
    () => ({
      grid: t('calendar.label', { name }),
      previousMonth: t('calendar.previous'),
      nextMonth: t('calendar.next'),
      today: t('calendar.today'),
      more: (count) => t('calendar.more', { count }),
      moreLabel: (count, date) => t('calendar.moreLabel', { count, date }),
      dayItems: (date) => t('calendar.dayItems', { date }),
      create: (date) => t('calendar.newOn', { date }),
      moved: (item, date) => t('calendar.moved', { title: item.title || t('untitled'), date }),
      item: (_item, info) =>
        info.end
          ? t('calendar.span', { title: info.title, start: info.start, end: info.end })
          : info.time
            ? t('calendar.timed', { time: info.time, title: info.title })
            : info.title,
      moveHint: t('calendar.moveHint'),
      // The week's cell is named by the rows it shows; this describes it (`aria-describedby`).
      weekItems: (start, end) => t('calendar.weekItems', { start, end }),
      untitled: t('untitled'),
    }),
    [t, name],
  );

  if (!usable || !def) return <CalendarSetup database={database} view={view} env={env} />;

  const loaded = snapshot.rows.length;
  return (
    <div className={`cgw-cal${embedded ? ' is-embedded' : ''}`}>
      {snapshot.localOnly ? (
        <p className="cgw-db-notice" role="status">
          {t('localOnly')}
        </p>
      ) : null}
      {snapshot.error || undatedRows.snapshot.error ? (
        <p className="cgw-db-notice cgw-db-error" role="alert">
          {t('loadFailed')}{' '}
          <button
            type="button"
            className="cgw-text-button"
            onClick={() => {
              dated.source?.retry();
              undatedRows.source?.retry();
            }}
          >
            {t('retry')}
          </button>
        </p>
      ) : null}
      <div className="cgw-cal-head">
        <span className="cgw-cal-status" role="status">
          {dated.fetching
            ? t('calendar.loadingAll', { count: loaded })
            : dated.capped
              ? t('calendar.capped', { count: loaded })
              : ''}
        </span>
        <button
          type="button"
          className="cgw-text-button cgw-cal-undated-toggle"
          aria-pressed={undatedOpen}
          // Only while the list is there: an id that names nothing is an error to a screen reader.
          aria-controls={undatedOpen ? `${idPrefix}-undated` : undefined}
          onClick={() => setUndatedOpen((open) => !open)}
        >
          {t('calendar.noDate', { count: undatedRows.snapshot.total })}
        </button>
      </div>
      <div className="cgw-cal-main">
        <CgMonthCalendar<CalendarItem>
          className="cgw-cal-month-view"
          actionsRef={calendar}
          items={entries}
          labels={labels}
          locale={locale}
          firstDayOfWeek={WEEKDAYS[weekStart - 1]}
          today={ctx.today}
          month={monthText(month)}
          onMonthChange={(next) => setMonth(monthOf(`${next}-01`))}
          selectedDay={dateOfDay(activeDay)}
          onSelectedDayChange={(date) => setActiveDay(dayNumber(date))}
          maxItemRows={embedded ? 2 : 3}
          aria-readonly={!writable || undefined}
          onItemOpen={(item) => host.openRow(item.data!.row.id)}
          onCreate={
            writable
              ? (date, details) => setPopup({ day: dayNumber(date), anchor: details.anchor })
              : undefined
          }
          onItemMove={
            writable
              ? (item, details) => {
                  const { row, value } = item.data!;
                  void actions.setValue(row, def, shiftDays(value, details.days));
                }
              : undefined
          }
        />
        {undatedOpen ? (
          <Undated
            id={`${idPrefix}-undated`}
            title={t('calendar.noDateTitle')}
            empty={t('calendar.noDateEmpty')}
            rows={undated}
            total={undatedRows.snapshot.total}
            env={env}
            writable={writable}
            placeLabel={t('calendar.placeOn', {
              date: formatDatePart(dateOfDay(activeDay), locale),
            })}
            onPointerDown={onUndatedPointerDown}
            onOpen={(row) => host.openRow(row.id)}
            onPlace={(row) => placeRow(row, activeDay)}
            onNearEnd={() => undatedRows.source?.loadMore()}
          />
        ) : null}
      </div>
      <CgLiveAnnouncer ref={live} />
      {popup ? (
        <CellFlyout
          anchor={popup.anchor}
          label={t('calendar.newOn', { date: formatDatePart(dateOfDay(popup.day), locale) })}
          width={260}
          onClose={() => setPopup(null)}
        >
          <div className="cgw-cal-new">
            <span className="cgw-cal-new-date">{formatDatePart(dateOfDay(popup.day), locale)}</span>
            <NewTitle
              database={database}
              env={env}
              onCommit={(title) => createOn(popup.day, title)}
              onDone={() => {
                calendar.current?.getDayElement(dateOfDay(popup.day))?.focus();
                setPopup(null);
              }}
            />
          </div>
        </CellFlyout>
      ) : null}
    </div>
  );
}

/** The title of a row made on a day, typed before the row exists. */
function NewTitle({
  database,
  env,
  onCommit,
  onDone,
}: {
  database: DatabaseRecord;
  env: CellEnv;
  onCommit(title: string): void;
  onDone(): void;
}) {
  const titleDef = database.properties.find((p) => p.id === TITLE_PROPERTY);
  if (!titleDef) return null;
  return (
    <InlineEditor
      def={titleDef}
      row={draftRow(database)}
      env={env}
      label={env.t('card.newLabel')}
      className="cgw-text-input"
      commit={(value) => onCommit(typeof value === 'string' ? value : '')}
      onDone={onDone}
    />
  );
}

/** A calendar without a usable date property: choose one, or add one. */
function CalendarSetup({
  database,
  view,
  env,
}: {
  database: DatabaseRecord;
  view: ViewRecord;
  env: CellEnv;
}) {
  const { actions, editable } = useDatabaseContext();
  const { t } = env;
  const candidates: PropertyDef[] = liveProperties(database).filter((p) => isDateType(p.type));
  const choose = (propertyId: string) => {
    if (propertyId) void actions.updateView(view, { ...view.config, calendarBy: propertyId });
  };
  const addDate = () => {
    const def = newPropertyDef('date', uniqueName(database, t('calendar.dateName')), {
      todo: t('option.defaultTodo'),
      inProgress: t('option.defaultInProgress'),
      complete: t('option.defaultComplete'),
    });
    void actions.addProperty(def).then(() => choose(def.id));
  };
  return (
    <div className="cgw-view-setup" role="note">
      <p>{candidates.length ? t('calendar.chooseDate') : t('calendar.noDateProperty')}</p>
      {candidates.length ? (
        <label className="cgw-view-setup-field">
          <span>{t('calendar.showBy')}</span>
          <select
            className="cgw-select"
            value=""
            disabled={!editable}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{t('calendar.pickDate')}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {editable ? (
        <button type="button" className="cgw-text-button" onClick={addDate}>
          {t('calendar.addDate')}
        </button>
      ) : null}
    </div>
  );
}
