// The calendar view: a month grid of the rows by the view's `calendarBy` date property (or a
// prompt to choose one), spans drawn across the days they cover, "+N more" where a day is full,
// previous, next and today, the week starting on the locale's first day (Saturday in Arabic,
// Sunday in English unless `Intl` says otherwise), and the rows with no date in a side list. The
// grid is a CSS grid, so RTL mirrors it.
//
// A row moves to another day by dragging it (it keeps its time and its length: one `row.update`),
// or with Alt and the arrow keys on it; a row with no date is dragged onto a day or placed on the
// selected one. A day's "+" (or Enter on it) makes a row there. The days are one grid stop: the
// arrows, Home, End, PageUp and PageDown move between them.
import type { RowRecord } from '@cgw/workspace';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { CellFlyout } from '../../cells/CellFlyout';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import {
  LOCAL_ROW_LIMIT,
  TITLE_PROPERTY,
  type DatabaseRecord,
  type DateValue,
  type PropertyDef,
  type ViewRecord,
} from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { formatDatePart } from '../../model/format';
import { isDateType, liveProperties, propertyOf, uniqueName } from '../../model/properties';
import { newPropertyDef } from '../../properties/defs';
import { layoutOf, sameRange, visibleRange, type Range } from '../../table/windowing';
import { startsDrag, trackDrag } from '../board/drag';
import { draftRow, Live, type LiveHandle } from '../board/shared';
import type { ViewProps } from '../types';
import { dateOfDay, dayNumber, monthOf, shiftDays, weekStartOf, type Month } from './dates';
import {
  calendarItems,
  dayMove,
  hiddenPerDay,
  itemsOn,
  lanesFor,
  layoutWeeks,
  monthGrid,
  type CalendarItem,
  type Segment,
} from './layout';
import '../board/card.css';
import './calendar.css';

const DAY_HEAD = 26;
const LANE = 22;
const MORE = 20;
const UNDATED_ITEM = 34;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options })));
  return f;
}
const dayDate = (day: number) => new Date(day * 86_400_000);

type Popup =
  | { kind: 'new'; day: number; anchor: HTMLElement }
  | { kind: 'more'; day: number; anchor: HTMLElement; items: CalendarItem[] };

export function CalendarView({
  database,
  view,
  source,
  snapshot,
  embedded,
  newRowRequest,
}: ViewProps) {
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
  const [popup, setPopup] = useState<Popup | null>(null);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const live = useRef<LiveHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<
    { kind: 'day'; day: number } | { kind: 'item'; rowId: string } | null
  >(null);

  // Every row is needed to place them: fetch the rest while some remain, up to the local limit.
  const loaded = snapshot.rows.length;
  useEffect(() => {
    if (!source || snapshot.complete || snapshot.loading || snapshot.error) return;
    if (loaded < LOCAL_ROW_LIMIT) source.loadMore();
  }, [source, snapshot.complete, snapshot.loading, snapshot.error, loaded]);

  const { items, undated } = useMemo(
    () =>
      usable && def
        ? calendarItems(snapshot.rows, def, ctx.offsetMinutes)
        : { items: [], undated: [] },
    [snapshot.rows, def, usable, ctx.offsetMinutes],
  );
  const grid = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);
  const weeks = useMemo(() => layoutWeeks(items, grid), [items, grid]);
  const weekHeight = embedded ? 104 : 124;
  const lanes = lanesFor(weekHeight, DAY_HEAD, LANE, MORE);

  // The selected day stays in the month shown: moving out of it turns the page.
  const goToDay = (day: number, focus = true) => {
    setActiveDay(day);
    const target = monthOf(dateOfDay(day));
    if (target.year !== month.year || target.month !== month.month) setMonth(target);
    if (focus) pendingFocus.current = { kind: 'day', day };
  };
  const turn = (n: number) => {
    const total = month.year * 12 + month.month - 1 + n;
    const next = { year: Math.floor(total / 12), month: (total % 12) + 1 };
    setMonth(next);
    const first = dayNumber(
      `${String(next.year).padStart(4, '0')}-${String(next.month).padStart(2, '0')}-01`,
    );
    setActiveDay(first);
  };
  const goToday = () => goToDay(today, false);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !root.current) return;
    const el =
      pending.kind === 'day'
        ? root.current.querySelector<HTMLElement>(`[data-day="${pending.day}"]`)
        : root.current.querySelector<HTMLElement>(
            `[data-cal-item][data-row-id="${pending.rowId}"]`,
          );
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  // ---- Changes --------------------------------------------------------------------------------
  /** Moves a dated row by whole days, or puts a row with no date on a day: one `row.update`. */
  const moveRow = (row: RowRecord, value: DateValue | null, daysOrDay: number) => {
    if (!def || !writable) {
      live.current?.say(t('calendar.fixedDate'));
      return;
    }
    const next = value ? shiftDays(value, daysOrDay) : { start: dateOfDay(daysOrDay) };
    void actions.setValue(row, def, next);
    live.current?.say(
      t('calendar.moved', {
        title: row.title || t('untitled'),
        date: formatDatePart(next.start, locale),
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
    const day = activeDay >= grid.first && activeDay <= grid.last ? activeDay : today;
    goToDay(day, false);
    requestAnimationFrame(() => {
      const anchor = root.current?.querySelector<HTMLElement>(`[data-day="${day}"]`);
      if (anchor) setPopup({ kind: 'new', day, anchor });
    });
    // Only a new press of the toolbar's New opens it: the other values are read as they are now.
  }, [newRowRequest]);

  // ---- Pointer drag: a row onto another day -------------------------------------------------------
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const marked = useRef<HTMLElement[]>([]);
  const mark = (cells: HTMLElement[]) => {
    for (const el of marked.current) if (!cells.includes(el)) el.removeAttribute('data-drop');
    for (const el of cells) if (!marked.current.includes(el)) el.setAttribute('data-drop', '');
    marked.current = cells;
  };

  const rowsById = useMemo(() => new Map(snapshot.rows.map((r) => [r.id, r])), [snapshot.rows]);
  const itemsById = useMemo(() => new Map(items.map((i) => [i.row.id, i])), [items]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !writable) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-cal-drag]');
    if (!el || !startsDrag(event.target, el)) return;
    const rowId = el.dataset.rowId!;
    const row = rowsById.get(rowId);
    if (!row) return;
    const item = itemsById.get(rowId) ?? null;
    let cells: { day: number; el: HTMLElement; rect: DOMRect }[] = [];
    let grab: number | null = null;
    let target: number | null = null;
    const scroller = root.current?.querySelector<HTMLElement>('.cgw-cal-scroll') ?? null;
    let start = { left: 0, top: 0 };
    const dayAt = (x: number, y: number) => {
      const dx = (scroller?.scrollLeft ?? 0) - start.left;
      const dy = (scroller?.scrollTop ?? 0) - start.top;
      return cells.find(
        (c) =>
          x >= c.rect.left - dx &&
          x < c.rect.right - dx &&
          y >= c.rect.top - dy &&
          y < c.rect.bottom - dy,
      );
    };
    const press = { x: event.clientX, y: event.clientY };
    stopDrag.current?.();
    stopDrag.current = trackDrag(event.nativeEvent, el, scroller, {
      onStart() {
        start = { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
        cells = [...(root.current?.querySelectorAll<HTMLElement>('[data-day]') ?? [])].map((c) => ({
          day: Number(c.dataset.day),
          el: c,
          rect: c.getBoundingClientRect(),
        }));
        grab = dayAt(press.x, press.y)?.day ?? item?.start ?? null;
      },
      onMove(x, y) {
        const cell = dayAt(x, y);
        target = cell?.day ?? null;
        if (target === null) return mark([]);
        const from = item ? target - ((grab ?? item.start) - item.start) : target;
        const length = item ? item.end - item.start : 0;
        mark(cells.filter((c) => c.day >= from && c.day <= from + length).map((c) => c.el));
      },
      onDrop() {
        mark([]);
        stopDrag.current = null;
        if (target === null) return;
        if (item) {
          const days = target - (grab ?? item.start);
          if (days) moveRow(row, item.value, days);
        } else moveRow(row, null, target);
      },
      onCancel() {
        mark([]);
        stopDrag.current = null;
      },
    });
  };

  // ---- Keyboard ------------------------------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const dirRtl = getComputedStyle(target).direction === 'rtl';
    if (target.matches('[data-cal-item]')) {
      const rowId = target.dataset.rowId ?? '';
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        host.openRow(rowId);
        return;
      }
      const item = itemsById.get(rowId);
      if (item && event.altKey && writable) {
        const step =
          event.key === 'ArrowLeft'
            ? dirRtl
              ? 1
              : -1
            : event.key === 'ArrowRight'
              ? dirRtl
                ? -1
                : 1
              : event.key === 'ArrowUp'
                ? -7
                : event.key === 'ArrowDown'
                  ? 7
                  : 0;
        if (!step) return;
        event.preventDefault();
        moveRow(item.row, item.value, step);
        pendingFocus.current = { kind: 'item', rowId: item.row.id };
        const target = monthOf(dateOfDay(item.start + step));
        if (target.year !== month.year || target.month !== month.month) setMonth(target);
        setActiveDay(item.start + step);
      }
      return;
    }
    if (!target.matches('[data-day]')) return;
    const day = Number(target.dataset.day);
    if (event.key === 'Enter' && writable) {
      event.preventDefault();
      setPopup({ kind: 'new', day, anchor: target });
      return;
    }
    const next = dayMove(day, event.key, dirRtl, weekStart, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    goToDay(next);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-cal-item]');
    if (item?.dataset.rowId) {
      host.openRow(item.dataset.rowId);
      return;
    }
    const day = target.closest<HTMLElement>('[data-day]');
    if (day && !target.closest('button')) setActiveDay(Number(day.dataset.day));
  };
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const day = target.closest<HTMLElement>('[data-day]');
    if (day && writable && !target.closest('button, [data-cal-item]'))
      setPopup({ kind: 'new', day: Number(day.dataset.day), anchor: day });
  };

  // ---- Drawing -------------------------------------------------------------------------------------
  if (!usable || !def) return <CalendarSetup database={database} view={view} env={env} />;

  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const monthName = format(locale, { month: 'long', year: 'numeric' }).format(dayDate(grid.first));
  const weekdays = Array.from({ length: 7 }, (_, i) => grid.start + i);
  const capped = !snapshot.complete && loaded >= LOCAL_ROW_LIMIT;
  const fetching = !snapshot.complete && !capped && !snapshot.error;
  const dateLabel = (day: number) => format(locale, { dateStyle: 'full' }).format(dayDate(day));

  return (
    <div ref={root} className={`cgw-cal${embedded ? ' is-embedded' : ''}`}>
      <div className="cgw-cal-head">
        <h3 className="cgw-cal-month" id={`${idPrefix}-month`}>
          {monthName}
        </h3>
        <button
          type="button"
          className="cgw-icon-button cgw-cal-turn"
          aria-label={t('calendar.previous')}
          title={t('calendar.previous')}
          onClick={() => turn(-1)}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <button type="button" className="cgw-text-button" onClick={goToday}>
          {t('calendar.today')}
        </button>
        <button
          type="button"
          className="cgw-icon-button cgw-cal-turn"
          aria-label={t('calendar.next')}
          title={t('calendar.next')}
          onClick={() => turn(1)}
        >
          <span aria-hidden="true">›</span>
        </button>
        <span className="cgw-cal-status" role="status">
          {fetching
            ? t('calendar.loadingAll', { count: loaded })
            : capped
              ? t('calendar.capped', { count: loaded })
              : ''}
        </span>
        <button
          type="button"
          className="cgw-text-button cgw-cal-undated-toggle"
          aria-pressed={undatedOpen}
          aria-controls={`${idPrefix}-undated`}
          onClick={() => setUndatedOpen((open) => !open)}
        >
          {t('calendar.noDate', { count: undated.length })}
        </button>
      </div>
      <div
        className="cgw-cal-main"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="cgw-cal-scroll">
          <div
            className="cgw-cal-grid"
            role="grid"
            aria-label={t('calendar.label', { name })}
            aria-describedby={`${idPrefix}-month`}
            aria-readonly={!writable || undefined}
          >
            <div className="cgw-cal-weekdays" role="row">
              {weekdays.map((day) => (
                <div
                  key={day}
                  role="columnheader"
                  className="cgw-cal-weekday"
                  aria-label={format(locale, { weekday: 'long' }).format(dayDate(day))}
                >
                  {format(locale, { weekday: 'short' }).format(dayDate(day))}
                </div>
              ))}
            </div>
            {weeks.map((pieces, w) => (
              <Week
                key={grid.start + w * 7}
                start={grid.start + w * 7}
                pieces={pieces}
                lanes={lanes}
                height={weekHeight}
                month={grid}
                today={today}
                activeDay={activeDay}
                writable={writable}
                env={env}
                dateLabel={dateLabel}
                onNew={(day, anchor) => setPopup({ kind: 'new', day, anchor })}
                onMore={(day, anchor, list) => setPopup({ kind: 'more', day, anchor, items: list })}
              />
            ))}
          </div>
        </div>
        {undatedOpen ? (
          <Undated
            id={`${idPrefix}-undated`}
            rows={undated}
            env={env}
            writable={writable}
            activeDay={activeDay}
            onPlace={(row) => moveRow(row, null, activeDay)}
          />
        ) : null}
      </div>
      <Live ref={live} />
      {popup?.kind === 'new' ? (
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
                pendingFocus.current = { kind: 'day', day: popup.day };
                setPopup(null);
              }}
            />
          </div>
        </CellFlyout>
      ) : null}
      {popup?.kind === 'more' ? (
        <CellFlyout
          anchor={popup.anchor}
          label={t('calendar.dayItems', { date: formatDatePart(dateOfDay(popup.day), locale) })}
          width={260}
          onClose={() => setPopup(null)}
        >
          <ul
            className="cgw-cal-more-list"
            aria-label={t('calendar.dayItems', {
              date: formatDatePart(dateOfDay(popup.day), locale),
            })}
          >
            {popup.items.map((item, i) => (
              <li key={item.row.id}>
                <button
                  type="button"
                  className="cgw-cal-more-item"
                  data-cg-initial-focus={i === 0 ? '' : undefined}
                  onClick={() => {
                    setPopup(null);
                    host.openRow(item.row.id);
                  }}
                >
                  {item.time ? <span className="cgw-cal-time">{item.time}</span> : null}
                  <span dir="auto">{item.row.title || t('untitled')}</span>
                </button>
              </li>
            ))}
          </ul>
        </CellFlyout>
      ) : null}
    </div>
  );
}

interface WeekProps {
  start: number;
  pieces: Segment[];
  lanes: number;
  height: number;
  month: { first: number; last: number };
  today: number;
  activeDay: number;
  writable: boolean;
  env: CellEnv;
  dateLabel(day: number): string;
  onNew(day: number, anchor: HTMLElement): void;
  onMore(day: number, anchor: HTMLElement, items: CalendarItem[]): void;
}

/** One week's row: its seven days, then the rows over them in lanes. */
function Week({
  start,
  pieces,
  lanes,
  height,
  month,
  today,
  activeDay,
  writable,
  env,
  dateLabel,
  onNew,
  onMore,
}: WeekProps) {
  const { t } = env;
  const hidden = hiddenPerDay(pieces, lanes);
  const activeCol = activeDay - start;
  return (
    <div className="cgw-cal-week" role="row" style={{ blockSize: height }}>
      {Array.from({ length: 7 }, (_, col) => {
        const day = start + col;
        const active = day === activeDay;
        const date = new Date(day * 86_400_000);
        return (
          <div
            key={day}
            role="gridcell"
            className="cgw-cal-day"
            data-day={day}
            data-outside={day < month.first || day > month.last || undefined}
            data-today={day === today || undefined}
            aria-selected={active}
            aria-label={dateLabel(day)}
            tabIndex={active ? 0 : -1}
          >
            <span className="cgw-cal-num" aria-hidden="true">
              {date.getUTCDate().toLocaleString(env.locale)}
            </span>
            {writable ? (
              <button
                type="button"
                className="cgw-icon-button cgw-cal-add"
                tabIndex={active ? 0 : -1}
                aria-label={t('calendar.newOn', { date: dateLabel(day) })}
                title={t('calendar.newOn', { date: dateLabel(day) })}
                onClick={(event) =>
                  onNew(day, event.currentTarget.closest<HTMLElement>('[data-day]')!)
                }
              >
                <span aria-hidden="true">＋</span>
              </button>
            ) : null}
            {hidden[col] ? (
              <button
                type="button"
                className="cgw-cal-more"
                tabIndex={active ? 0 : -1}
                aria-label={t('calendar.moreLabel', { count: hidden[col], date: dateLabel(day) })}
                onClick={(event) =>
                  onMore(
                    day,
                    event.currentTarget.closest<HTMLElement>('[data-day]')!,
                    itemsOn(pieces, col),
                  )
                }
              >
                {t('calendar.more', { count: hidden[col] })}
              </button>
            ) : null}
          </div>
        );
      })}
      <div
        className="cgw-cal-lanes"
        role="none"
        style={{ gridTemplateRows: `repeat(${lanes}, ${LANE}px)` }}
      >
        {pieces
          .filter((p) => p.lane < lanes)
          .map((p) => {
            const { item } = p;
            const title = item.row.title || t('untitled');
            const covers = activeCol >= p.col && activeCol < p.col + p.span;
            const label =
              item.end > item.start
                ? t('calendar.span', {
                    title,
                    start: dateLabel(item.start),
                    end: dateLabel(item.end),
                  })
                : item.time
                  ? t('calendar.timed', { time: item.time, title })
                  : title;
            return (
              <div
                key={`${item.row.id}:${p.week}`}
                className="cgw-cal-item"
                role="button"
                tabIndex={covers ? 0 : -1}
                data-cal-item=""
                data-cal-drag={writable ? '' : undefined}
                data-row-id={item.row.id}
                data-before={p.before || undefined}
                data-after={p.after || undefined}
                aria-label={label}
                aria-description={writable ? t('calendar.moveHint') : undefined}
                style={{ gridColumn: `${p.col + 1} / span ${p.span}`, gridRow: p.lane + 1 }}
              >
                {item.time && !p.before ? <span className="cgw-cal-time">{item.time}</span> : null}
                <span className="cgw-cal-title" dir="auto">
                  {title}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** The rows with no date: a scrolling list beside the grid, drawn a window at a time. */
function Undated({
  id,
  rows,
  env,
  writable,
  activeDay,
  onPlace,
}: {
  id: string;
  rows: RowRecord[];
  env: CellEnv;
  writable: boolean;
  activeDay: number;
  onPlace(row: RowRecord): void;
}) {
  const { t } = env;
  const box = useRef<HTMLUListElement>(null);
  const layout = useMemo(() => layoutOf(rows.length, () => UNDATED_ITEM), [rows.length]);
  const [range, setRange] = useState<Range>({ start: 0, end: 30 });
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const next = visibleRange(layout, el.scrollTop, el.clientHeight || 480, 8);
    setRange((prev) => (sameRange(prev, next) ? prev : next));
  }, [layout]);
  useLayoutEffect(measure, [measure]);
  const day = formatDatePart(dateOfDay(activeDay), env.locale);
  const drawn = rows.slice(range.start, range.end);
  return (
    <aside id={id} className="cgw-cal-undated" aria-label={t('calendar.noDateTitle')}>
      <h4 className="cgw-cal-undated-title">{t('calendar.noDateTitle')}</h4>
      {rows.length ? (
        <ul ref={box} className="cgw-cal-undated-list" onScroll={measure}>
          <li
            aria-hidden="true"
            style={{ blockSize: layout.total }}
            className="cgw-cal-undated-space"
          />
          {drawn.map((row, i) => (
            <li
              key={row.id}
              className="cgw-cal-undated-item"
              data-cal-drag={writable ? '' : undefined}
              data-row-id={row.id}
              style={{ insetBlockStart: layout.offsets[range.start + i] }}
            >
              <span
                role="button"
                tabIndex={0}
                className="cgw-cal-undated-open"
                data-cal-item=""
                data-row-id={row.id}
                dir="auto"
              >
                {row.title || t('untitled')}
              </span>
              {writable ? (
                <button
                  type="button"
                  className="cgw-icon-button"
                  aria-label={t('calendar.placeOn', { date: day })}
                  title={t('calendar.placeOn', { date: day })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlace(row);
                  }}
                >
                  <span aria-hidden="true">↧</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cgw-cal-undated-empty">{t('calendar.noDateEmpty')}</p>
      )}
    </aside>
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
