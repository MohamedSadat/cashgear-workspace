// The timeline view (Phase 9, M9.2): a line per row with its bar across its dates (a date
// property's own range, or a start and an end property), drawn by the library's `CgTimeline`
// (Track U18); zoom by day, week, month or quarter; lanes by a select or status property, in its
// options' order, with "No value" last; the rows with no date in a list beside it. Time runs right
// to left in Arabic.
//
// Its rows come by queries of its own (`ownRows`): the rows whose dates meet the days shown and as
// many again on each side, out to whole months (a date window: the server answers it for a large
// database, so a timeline over 50,000 rows fetches only what it shows), every page up to
// `LOCAL_ROW_LIMIT`; and the rows with no start (a filter `isEmpty`, paged as the list scrolls).
//
// A bar moves by dragging its body and resizes by its edges, or by the keys (`CgTimelineProps`):
// one `row.update` a move, its dates in their own forms (`movedValues`). A row with no date is
// dragged from the list onto a day, or put on today by its button. A double click on a line's
// empty days, or the toolbar's New (today), makes a row there, its title typed first. A reader
// (`canEdit` false) moves nothing.
import {
  CgLiveAnnouncer,
  CgTimeline,
  cgStartsDrag,
  cgTrackDrag,
  type CgDayOfWeek,
  type CgLiveAnnouncerHandle,
  type CgTimelineHandle,
  type CgTimelineLabels,
  type CgTimelineRange,
} from '@cashgear/ui';
import { newOp, type RowRecord } from '@cgw/workspace';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { CellFlyout } from '../../cells/CellFlyout';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import {
  TITLE_PROPERTY,
  type DatabaseRecord,
  type PropertyDef,
  type TimelineScale,
  type ViewRecord,
} from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { formatDatePart } from '../../model/format';
import { isDateType, liveProperties, propertyOf, uniqueName } from '../../model/properties';
import { newPropertyDef } from '../../properties/defs';
import { draftRow } from '../board/shared';
import { weekStartOf } from '../calendar/dates';
import { undatedRequest, windowRequest } from '../calendar/requests';
import { Undated } from '../calendar/Undated';
import { useWindowRows } from '../calendar/useWindowRows';
import type { ViewProps } from '../types';
import {
  covers,
  fetchWindow,
  firstRange,
  movedValues,
  timelineItems,
  timelineOf,
  type TimelineRow,
} from './timeline';
import '../board/card.css';
import './timeline.css';

export { defaultTimeline } from './timeline';

/** `weekStartOf`'s 1 (Monday) to 7 (Sunday). */
const WEEKDAYS: readonly CgDayOfWeek[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const isLaneType = (def: PropertyDef | undefined) =>
  !!def && !def.trashedAt && (def.type === 'select' || def.type === 'status');

export function TimelineView({ database, view, request, embedded, newRowRequest }: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t, locale } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const idPrefix = `t${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const settings = timelineOf(view.config);
  const startDef = settings.start ? propertyOf(database, settings.start) : undefined;
  const usable = !!startDef && !startDef.trashedAt && isDateType(startDef.type);
  const endCandidate = settings.end ? propertyOf(database, settings.end) : undefined;
  const endDef =
    endCandidate &&
    !endCandidate.trashedAt &&
    isDateType(endCandidate.type) &&
    endCandidate.id !== startDef?.id
      ? endCandidate
      : undefined;
  const laneCandidate = settings.lane ? propertyOf(database, settings.lane) : undefined;
  const laneDef = isLaneType(laneCandidate) ? laneCandidate : undefined;
  const writable = editable && startDef?.type === 'date' && (!endDef || endDef.type === 'date');
  const ctx = host.queryContext();
  const live = useRef<CgLiveAnnouncerHandle>(null);
  const timeline = useRef<CgTimelineHandle>(null);
  const head = useRef<HTMLDivElement>(null);

  // The zoom: the view's, changed here for everyone who may edit it, for this view only otherwise.
  const [scale, setScale] = useState<TimelineScale>(settings.scale);
  useEffect(() => setScale(settings.scale), [settings.scale]);
  const changeScale = (next: TimelineScale) => {
    setScale(next);
    if (editable)
      void actions.updateView(view, {
        ...view.config,
        timeline: { ...(view.config.timeline ?? { start: settings.start }), scale: next },
      });
  };

  // The window fetched: the days shown and as many again on each side, asked again only when the
  // days shown leave it.
  const [shownDays, setShownDays] = useState<CgTimelineRange>(() =>
    firstRange(ctx.today, settings.scale),
  );
  const [fetched, setFetched] = useState<CgTimelineRange>(() => fetchWindow(shownDays));
  const onRangeChange = useCallback((range: CgTimelineRange) => {
    setShownDays(range);
    setFetched((w) => (covers(w, range) ? w : fetchWindow(range)));
  }, []);
  const datedRequest = useMemo(
    () =>
      request && usable && startDef
        ? windowRequest(request, {
            propertyId: startDef.id,
            endPropertyId: endDef?.id ?? null,
            from: fetched.from,
            to: fetched.to,
          })
        : null,
    [request, usable, startDef, endDef, fetched],
  );
  const noDateRequest = useMemo(
    () =>
      request && usable && startDef && settings.undated
        ? undatedRequest(request, startDef.id)
        : null,
    [request, usable, startDef, settings.undated],
  );
  const dated = useWindowRows(host, database.id, datedRequest);
  const undated = useWindowRows(host, database.id, noDateRequest, Infinity);

  // The lines: the rows the days shown hold (the window's others are ready for a scroll).
  const items = useMemo(
    () =>
      usable && startDef
        ? timelineItems(
            dated.rows,
            startDef,
            endDef,
            laneDef,
            ctx.offsetMinutes,
            writable,
            shownDays,
          )
        : [],
    [dated.rows, usable, startDef, endDef, laneDef, ctx.offsetMinutes, writable, shownDays],
  );
  const lanes = useMemo(
    () =>
      laneDef ? (laneDef.options ?? []).map((o) => ({ key: o.id, title: o.name })) : undefined,
    [laneDef],
  );

  // ---- Changes --------------------------------------------------------------------------------
  const write = (row: RowRecord, values: Record<string, unknown>) =>
    actions.applyOps([
      newOp('row.update', database.workspaceId, row.id, { values: values as never }),
    ]);
  /** Puts a row with no date on a day (and in the lane it was dropped on): one `row.update`. */
  const placeRow = (row: RowRecord, date: string, lane?: string | null) => {
    if (!startDef || !writable) {
      live.current?.announce(t('calendar.fixedDate'));
      return;
    }
    const inLane = laneDef && lane && (laneDef.options ?? []).some((o) => o.id === lane);
    void write(row, {
      [startDef.id]: { start: date },
      ...(inLane && laneDef ? { [laneDef.id]: lane } : {}),
    });
    live.current?.announce(
      t('calendar.moved', {
        title: row.title || t('untitled'),
        date: formatDatePart(date, locale),
      }),
    );
  };

  const [popup, setPopup] = useState<{
    date: string;
    lane: string | null;
    anchor: HTMLElement;
  } | null>(null);
  const createOn = (date: string, lane: string | null, title: string) => {
    if (!startDef || !title.trim()) return;
    const inLane = laneDef && lane && (laneDef.options ?? []).some((o) => o.id === lane);
    void actions.createRow({
      title,
      view,
      values: { [startDef.id]: { start: date }, ...(inLane ? { [laneDef.id]: lane } : {}) },
    });
  };
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    if (!writable || !head.current) {
      void actions.createRow({ view });
      return;
    }
    timeline.current?.scrollToDate(ctx.today);
    setPopup({ date: ctx.today, lane: null, anchor: head.current });
    // Only a new press of the toolbar's New opens it: the other values are read as they are now.
  }, [newRowRequest]);

  // ---- A row with no date dragged onto a day ----------------------------------------------------
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const undatedById = useMemo(() => new Map(undated.rows.map((r) => [r.id, r])), [undated.rows]);
  const onUndatedPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !writable) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-cal-drag]');
    if (!el || !cgStartsDrag(event.target, el)) return;
    const row = undatedById.get(el.dataset.rowId ?? '');
    if (!row) return;
    let target: string | null = null;
    stopDrag.current?.();
    stopDrag.current = cgTrackDrag(event.nativeEvent, el, {
      ghostClassName: 'cgw-drag-ghost',
      onMove(x, y) {
        const date = timeline.current?.dateAt(x, y) ?? null;
        if (date === target) return;
        target = date;
        timeline.current?.markDropDate(date);
      },
      onDrop(x, y) {
        timeline.current?.markDropDate(null);
        stopDrag.current = null;
        const date = timeline.current?.dateAt(x, y) ?? target;
        if (date) placeRow(row, date, timeline.current?.laneAt(x, y)?.lane);
      },
      onCancel() {
        timeline.current?.markDropDate(null);
        stopDrag.current = null;
      },
    });
  };

  // ---- Drawing ----------------------------------------------------------------------------------
  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const formatCount = useMemo(() => {
    const format = new Intl.NumberFormat(locale);
    return (n: number) => format.format(n);
  }, [locale]);
  const labels = useMemo<CgTimelineLabels<TimelineRow>>(
    () => ({
      grid: t('timeline.label', { name }),
      previous: t('timeline.previous'),
      next: t('timeline.next'),
      today: t('timeline.today'),
      scale: t('timeline.zoom'),
      scales: {
        day: t('timeline.scaleDay'),
        week: t('timeline.scaleWeek'),
        month: t('timeline.scaleMonth'),
        quarter: t('timeline.scaleQuarter'),
      },
      quarter: (quarter) => t('timeline.quarter', { number: quarter }),
      item: (_item, info) =>
        info.end
          ? t('timeline.span', { title: info.title, start: info.start, end: info.end })
          : t('timeline.day', { title: info.title, start: info.start }),
      moveHint: t('timeline.moveHint'),
      moved: (item, info) =>
        info.end
          ? t('timeline.moved', {
              title: item.title || t('untitled'),
              start: info.start,
              end: info.end,
            })
          : t('timeline.movedDay', { title: item.title || t('untitled'), start: info.start }),
      resized: (item, info) =>
        info.end
          ? t('timeline.resized', {
              title: item.title || t('untitled'),
              start: info.start,
              end: info.end,
            })
          : t('timeline.resizedDay', { title: item.title || t('untitled'), start: info.start }),
      noLane: t('timeline.noLane', { name: laneDef?.name ?? '' }),
      lane: (title, count) => t('timeline.lane', { name: title, number: formatCount(count) }),
      untitled: t('untitled'),
    }),
    [t, name, laneDef?.name, formatCount],
  );

  if (!usable || !startDef) return <TimelineSetup database={database} view={view} env={env} />;

  const snapshot = dated.snapshot;
  const loaded = snapshot.rows.length;
  return (
    <div className={`cgw-db-tl${embedded ? ' is-embedded' : ''}`}>
      {snapshot.localOnly ? (
        <p className="cgw-db-notice" role="status">
          {t('localOnly')}
        </p>
      ) : null}
      {snapshot.error || undated.snapshot.error ? (
        <p className="cgw-db-notice cgw-db-error" role="alert">
          {t('loadFailed')}{' '}
          <button
            type="button"
            className="cgw-text-button"
            onClick={() => {
              dated.source?.retry();
              undated.source?.retry();
            }}
          >
            {t('retry')}
          </button>
        </p>
      ) : null}
      <div className="cgw-db-tl-head" ref={head}>
        <span className="cgw-db-tl-status" role="status">
          {dated.fetching
            ? t('timeline.loading', { count: loaded })
            : dated.capped
              ? t('timeline.capped', { count: loaded })
              : ''}
        </span>
      </div>
      <div className="cgw-db-tl-main">
        <CgTimeline<TimelineRow>
          className="cgw-db-tl-lines"
          actionsRef={timeline}
          items={items}
          labels={labels}
          lanes={lanes}
          scale={scale}
          onScaleChange={changeScale}
          locale={locale}
          firstDayOfWeek={WEEKDAYS[weekStartOf(locale) - 1]}
          today={ctx.today}
          // Inside a page a block's height; on the database's own page, all of its area.
          height={embedded ? 'min(60vh, 520px)' : '100%'}
          onRangeChange={onRangeChange}
          onItemOpen={(item) => host.openRow(item.data!.row.id)}
          onItemMove={
            writable
              ? (item, details) =>
                  void write(
                    item.data!.row,
                    movedValues(item.data!, startDef, endDef, details.edge, details.days),
                  )
              : undefined
          }
          onCreate={
            writable
              ? (date, lane, details) => setPopup({ date, lane, anchor: details.anchor })
              : undefined
          }
        />
        {settings.undated ? (
          <Undated
            id={`${idPrefix}-undated`}
            title={t('calendar.noDateTitle')}
            empty={t('calendar.noDateEmpty')}
            rows={undated.rows}
            total={undated.snapshot.total}
            env={env}
            writable={writable}
            placeLabel={t('timeline.placeToday')}
            onPointerDown={onUndatedPointerDown}
            onOpen={(row) => host.openRow(row.id)}
            onPlace={(row) => {
              placeRow(row, ctx.today);
              timeline.current?.scrollToDate(ctx.today);
            }}
            onNearEnd={() => undated.source?.loadMore()}
          />
        ) : null}
      </div>
      <CgLiveAnnouncer ref={live} />
      {popup ? (
        <CellFlyout
          anchor={popup.anchor}
          label={t('timeline.newOn', { date: formatDatePart(popup.date, locale) })}
          width={260}
          onClose={() => setPopup(null)}
        >
          <div className="cgw-db-tl-new">
            <span className="cgw-db-tl-new-date">{formatDatePart(popup.date, locale)}</span>
            <NewTitle
              database={database}
              env={env}
              onCommit={(title) => createOn(popup.date, popup.lane, title)}
              onDone={() => setPopup(null)}
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

/** A timeline without a usable date property: choose one, or add one. */
function TimelineSetup({
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
  const candidates = liveProperties(database).filter((p) => isDateType(p.type));
  const choose = (propertyId: string) => {
    if (!propertyId) return;
    const current = timelineOf(view.config);
    void actions.updateView(view, {
      ...view.config,
      sorts: view.config.sorts.length ? view.config.sorts : [{ propertyId, direction: 'asc' }],
      timeline: { ...current, start: propertyId },
    });
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
      <p>{candidates.length ? t('timeline.chooseStart') : t('calendar.noDateProperty')}</p>
      {candidates.length ? (
        <label className="cgw-view-setup-field">
          <span>{t('layout.timelineStart')}</span>
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
