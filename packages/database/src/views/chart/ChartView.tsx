// The chart view (Phase 12): the view's rows grouped by its own group (the toolbar's Group, its
// dates, hidden and empty groups as every grouped view's) and filtered by its filter, drawn as the
// chart block draws them: bars, a line or a pie, one point per group in the query's group order,
// measured by a count (the query's group counts, at any size) or a sum or an average of a number,
// formula or rollup property (the rows', at most `ROW_CAP`, said when cut). Its kind, measure and
// title are its layout settings (`ChartSettings`); a reader sees the chart, never a change.
//
// A count draws from `DatabaseView`'s own query; a sum or an average reads its rows by a query of
// its own of 500 rows a page, group by group, as the block does. Either query's failure is said
// here (a share link's `chart.hidden` in the chart's words), never above the tabs (`ownErrors`).
import { useEffect, useMemo, type ReactNode } from 'react';
import { useCellEnv } from '../../cells/env';
import type { ChartMeasure } from '../../core';
import { useDatabaseContext, useRowSource } from '../../context';
import type { RowRequest } from '../../host';
import { useDbT } from '../../i18n';
import { groupText } from '../GroupLabel';
import type { ViewProps } from '../types';
import { ROW_CAP, measureProperty, needsRows, nextToLoad, pointsOf } from './aggregate';
import { chartOf, chartTitle, groupProperty } from './config';
import { ChartDrawing } from './drawing';
import { useChartT } from './words';
import './chart.css';

const COUNT: ChartMeasure = { kind: 'count' };
/** Rows a sum or an average reads a page (the block's). */
export const MEASURE_PAGE = 500;
/**
 * A share link's refusal of a chart whose group or measure is a value a link never shares (a
 * person's, a formula of one, a rollup out of the link's scope).
 */
export const CHART_HIDDEN = 'chart.hidden';

const formatNumber = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

export function ChartView({ database, view, source, snapshot, request }: ViewProps) {
  const { host, actions, editable, databaseId } = useDatabaseContext();
  const { t: ct, locale } = useChartT();
  const { t: dbT } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const chart = chartOf(view.config);
  const rule = view.config.group;
  const group = groupProperty(database, rule);
  const measured = measureProperty(database, chart.measure);
  // A sum or average of a property that is gone counts instead.
  const measureText = JSON.stringify(measured ? chart.measure : COUNT);
  const measure = useMemo(() => JSON.parse(measureText) as ChartMeasure, [measureText]);

  // A sum or an average reads the rows, 500 at a time; a count needs only the view's own query.
  const ownText =
    request && group && needsRows(measure)
      ? JSON.stringify({ ...request, pageSize: MEASURE_PAGE })
      : null;
  const ownRequest = useMemo(
    () => (ownText ? (JSON.parse(ownText) as RowRequest) : null),
    [ownText],
  );
  const own = useRowSource(host, databaseId, ownRequest);
  const rows = ownRequest ? own : { source, snapshot };
  useEffect(() => {
    const next = nextToLoad(rows.snapshot, measure);
    if (next && rows.source) rows.source.loadMore(next.group);
  }, [rows.snapshot, rows.source, measure]);

  const title = chart.title ?? chartTitle(ct, measure, group, measured);
  const current = rows.snapshot;

  let body;
  if (!group || !rule)
    body = <Message text={editable ? ct('view.chooseGroup') : ct('view.noGroup')} />;
  else if (current.error === CHART_HIDDEN) body = <Message text={ct('hidden')} error />;
  else if (current.error)
    // The chart says its query's failures itself (`ownErrors`): `DatabaseView` says none.
    body = (
      <Message text={dbT('loadFailed')} error>
        <button type="button" className="cgw-text-button" onClick={() => rows.source?.retry()}>
          {dbT('retry')}
        </button>
      </Message>
    );
  else if (current.loading && !current.groups?.length)
    body = <Message text={dbT('loading')} busy />;
  else {
    const { points, partial } = pointsOf(database, current.groups ?? [], measure, (key) =>
      groupText(group, rule, key, env),
    );
    const shown = chart.kind === 'pie' ? points.filter((p) => (p.value ?? 0) > 0) : points;
    // A query of no rows still has a group for each option: there is nothing to draw.
    body =
      shown.length && current.total > 0 ? (
        <>
          <ChartDrawing kind={chart.kind} points={shown} name={title} />
          {partial ? (
            <p className="cgw-db-chart-note">
              {ct('partial', { count: formatNumber(ROW_CAP, locale) })}
            </p>
          ) : null}
        </>
      ) : (
        <Message text={ct('noRows')} />
      );
  }

  return (
    <section className="cgw-db-chart" aria-label={ct('label', { title })} data-chart={chart.kind}>
      <div className="cgw-db-chart-title" dir="auto">
        {title}
      </div>
      <div className="cgw-db-chart-body">{body}</div>
    </section>
  );
}

function Message({
  text,
  busy,
  error,
  children,
}: {
  text: string;
  busy?: boolean;
  error?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`cgw-db-chart-message${error ? ' cgw-db-error' : ''}`}
      role={error ? 'alert' : 'status'}
      aria-busy={busy || undefined}
    >
      <span>{text}</span>
      {children}
    </div>
  );
}
