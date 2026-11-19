// The chart block (`cashgear.chart`): a database view's rows, grouped by a property and measured
// by a count, a sum or an average, drawn with the UI library's `CgChart` as a bar, line or pie
// chart, or as one number. The rows are the view's (its filter) as the reader may see them, read
// through the database host; counts come from the query itself, sums and averages from the rows
// (at most `ROW_CAP`). The settings are the block's props, written only by `setProps`.
//
// Phase 12: the drawing, the settings' controls, their words and the arithmetic are
// `@cgw/database`'s (the chart view draws by them too); this block keeps its frame, its number,
// its "Group by" and its source.
import {
  CHART_HIDDEN,
  ChartControls,
  ChartDrawing,
  GROUPABLE,
  ROW_CAP,
  chartTitle,
  createActions,
  groupText,
  measureProperty,
  needsRows,
  nextToLoad,
  pointsOf,
  totalOf,
  useCellEnv,
  useChartT,
  useRowSource,
  type ChartControlsLook,
  type ChartT,
  type DatabaseHost,
  type RowRequest,
} from '@cgw/database';
import type { DatabaseRecord, GroupRule, PropertyDef } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { usePluginT } from '../i18n';
import type { PluginViewProps } from '../types';
import {
  BlockHead,
  ChooseDatabase,
  Message,
  SelectRow,
  SourceRows,
  useDatabaseState,
  type DatabaseState,
} from '../views/common';
import { CHART_KINDS, type ChartMeasure, type ChartProps } from './props';

export default function ChartBlock(view: PluginViewProps<ChartProps>) {
  const { t } = usePluginT();
  const host = view.data.databases;
  if (!host) return <Message text={t('common.unavailable')} />;
  if (!view.props.databaseId)
    return (
      <ChooseDatabase
        editable={view.editable}
        data={view.data}
        onChosen={(databaseId, viewId) => view.setProps({ ...view.props, databaseId, viewId })}
      />
    );
  return <ChartOf {...view} host={host} databaseId={view.props.databaseId} />;
}

const live = (database: DatabaseRecord) => database.properties.filter((p) => !p.trashedAt);
const groupable = (database: DatabaseRecord) =>
  live(database).filter((p) => (GROUPABLE as readonly string[]).includes(p.type));

/** The title the chart says when the block has none: "Sum of Amount by Status". */
export function autoTitle(
  t: ChartT,
  measure: ChartMeasure,
  group: PropertyDef | undefined,
  measured: PropertyDef | undefined,
): string {
  return chartTitle(t, measure, group, measured);
}

/** The block's settings look: its own classes (`plugins.css`). */
const LOOK: ChartControlsLook = {
  field: 'cgw-plugin-field',
  label: 'cgw-plugin-field-label',
  select: 'cgw-plugin-select',
  input: 'cgw-plugin-input',
};

function ChartOf({
  props,
  editable,
  setProps,
  data,
  host,
  databaseId,
  newer,
}: PluginViewProps<ChartProps> & { host: DatabaseHost; databaseId: string }) {
  const { t } = usePluginT();
  const { t: chartT, locale } = useChartT();
  const state = useDatabaseState(host, databaseId, props.viewId);
  const [settings, setSettings] = useState(false);
  const { database, view } = state;
  const group = database ? groupable(database).find((p) => p.id === props.groupBy) : undefined;
  const measured = database ? measureProperty(database, props.measure) : undefined;
  // A sum or average of a property that is gone counts instead.
  const measure: ChartMeasure = measured ? props.measure : { kind: 'count' };
  const grouped = props.chart !== 'number' && !!group;
  const rule: GroupRule | null = grouped ? { propertyId: group!.id } : null;
  // The query changes with these only: a new object for the same query is the same request.
  const requestText = view
    ? JSON.stringify({
        viewId: view.id,
        spec: { filter: view.config.filter, sorts: view.config.sorts, group: rule },
        pageSize: needsRows(measure) ? 500 : 1,
      })
    : null;
  const request = useMemo<RowRequest | null>(
    () => (requestText ? (JSON.parse(requestText) as RowRequest) : null),
    [requestText],
  );
  const { source, snapshot } = useRowSource(host, databaseId, request);
  // A sum or average reads the rows of each group, page by page, up to the cap.
  useEffect(() => {
    const next = nextToLoad(snapshot, measure);
    if (next && source) source.loadMore(next.group);
  }, [snapshot, measure, source]);

  const actions = useMemo(() => createActions(host, databaseId), [host, databaseId]);
  const env = useCellEnv(host, actions, false);
  const title = props.title ?? autoTitle(chartT, measure, grouped ? group : undefined, measured);
  const change = (next: Partial<ChartProps>) => setProps({ ...props, ...next });

  let body;
  if (!database || !view)
    body = (
      <Message text={database ? t('common.loading') : t('common.missing')} busy={!!database} />
    );
  else if (snapshot.error === CHART_HIDDEN)
    // Phase 12: a share link's refusal of a chart view that reads a property it hides.
    body = <Message text={chartT('hidden')} error />;
  else if (snapshot.error)
    body = (
      <Message text={t('common.loadFailed')} error>
        <button type="button" className="cgw-plugin-link" onClick={() => source?.retry()}>
          {t('common.retry')}
        </button>
      </Message>
    );
  else if (props.chart !== 'number' && !group) body = <Message text={chartT('chooseGroup')} />;
  else if (snapshot.loading && !snapshot.rows.length && !snapshot.groups?.length)
    body = <Message text={t('common.loading')} busy />;
  else if (props.chart === 'number') {
    const total = totalOf(database, snapshot, measure);
    body = (
      <div className="cgw-plugin-number" data-testid="chart-number">
        <span className="cgw-plugin-number-value">
          {total.value === null ? chartT('noValue') : formatNumber(total.value, locale)}
        </span>
        <span className="cgw-plugin-number-label" dir="auto">
          {title}
        </span>
        {total.partial ? <Partial /> : null}
      </div>
    );
  } else {
    const { points, partial } = pointsOf(database, snapshot.groups ?? [], measure, (key) =>
      groupText(group, rule!, key, env),
    );
    const shown = props.chart === 'pie' ? points.filter((p) => (p.value ?? 0) > 0) : points;
    body = shown.length ? (
      <>
        <ChartDrawing
          kind={props.chart}
          points={shown}
          name={title}
          className="cgw-plugin-chart-canvas"
        />
        {partial ? <Partial /> : null}
      </>
    ) : (
      <Message text={chartT('noRows')} />
    );
  }

  return (
    <section
      className="cgw-plugin cgw-plugin-chart"
      aria-label={chartT('label', { title })}
      data-chart={props.chart}
    >
      <BlockHead
        title={title}
        editable={editable}
        newer={newer}
        settingsOpen={settings}
        onSettings={() => setSettings((open) => !open)}
        onOpenDatabase={() => host.openPage(databaseId)}
      />
      {editable && settings && database ? (
        <ChartSettings
          props={props}
          database={database}
          state={state}
          data={data}
          change={change}
        />
      ) : null}
      {snapshot.localOnly ? <p className="cgw-plugin-note">{t('common.localOnly')}</p> : null}
      <div className="cgw-plugin-body">{body}</div>
    </section>
  );
}

function Partial() {
  const { t, locale } = useChartT();
  return (
    <p className="cgw-plugin-note">{t('partial', { count: formatNumber(ROW_CAP, locale) })}</p>
  );
}

const formatNumber = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

function ChartSettings({
  props,
  database,
  state,
  data,
  change,
}: {
  props: ChartProps;
  database: DatabaseRecord;
  state: DatabaseState;
  data: PluginViewProps<ChartProps>['data'];
  change(next: Partial<ChartProps>): void;
}) {
  const { t } = usePluginT();
  const { t: chartT } = useChartT();
  const NONE = '';
  return (
    <div className="cgw-plugin-settings" role="group" aria-label={t('common.settings')}>
      <ChartControls
        database={database}
        kinds={CHART_KINDS}
        kind={props.chart}
        measure={props.measure}
        title={props.title}
        look={LOOK}
        onKind={(chart) => change({ chart })}
        onMeasure={(measure) => change({ measure })}
        onTitle={(title) => change({ title })}
        between={
          <SelectRow
            label={chartT('groupBy')}
            value={props.groupBy ?? NONE}
            options={[
              { value: NONE, label: chartT('groupNone') },
              ...groupable(database).map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(groupBy) =>
              change(
                groupBy === NONE
                  ? { groupBy: null, chart: 'number' }
                  : { groupBy, chart: props.chart === 'number' ? 'bar' : props.chart },
              )
            }
          />
        }
      />
      <SourceRows
        state={state}
        viewId={props.viewId}
        data={data}
        onView={(viewId) => change({ viewId })}
        onDatabase={(databaseId, viewId) =>
          change({ databaseId, viewId, groupBy: null, measure: { kind: 'count' } })
        }
      />
    </div>
  );
}
