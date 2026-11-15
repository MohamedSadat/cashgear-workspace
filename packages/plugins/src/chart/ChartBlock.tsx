// The chart block (`cashgear.chart`): a database view's rows, grouped by a property and measured
// by a count, a sum or an average, drawn with the UI library's `CgChart` as a bar, line or pie
// chart, or as one number. The rows are the view's (its filter) as the reader may see them, read
// through the database host; counts come from the query itself, sums and averages from the rows
// (at most `ROW_CAP`). The settings are the block's props, written only by `setProps`.
import { CgChart, type CgChartSeriesDescriptor, type CgChartStrings } from '@cashgear/ui';
import {
  createActions,
  groupText,
  useCellEnv,
  useRowSource,
  type DatabaseHost,
  type RowRequest,
} from '@cgw/database';
import type { DatabaseRecord, GroupRule, PropertyDef } from '@cgw/workspace';
import { useEffect, useId, useMemo, useState } from 'react';
import { usePluginT, type PluginT } from '../i18n';
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
import {
  GROUPABLE,
  MEASURABLE,
  ROW_CAP,
  measureProperty,
  needsRows,
  nextToLoad,
  pointsOf,
  totalOf,
  type ChartPoint,
} from './aggregate';
import { CHART_KINDS, type ChartKind, type ChartMeasure, type ChartProps } from './props';

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
const measurable = (database: DatabaseRecord) =>
  live(database).filter((p) => (MEASURABLE as readonly string[]).includes(p.type));

/** The title the chart says when the block has none: "Sum of Amount by Status". */
export function autoTitle(
  t: PluginT,
  measure: ChartMeasure,
  group: PropertyDef | undefined,
  measured: PropertyDef | undefined,
): string {
  const kind = measure.kind === 'count' || !measured ? 'count' : measure.kind;
  const values = { group: group?.name ?? '', measure: measured?.name ?? '' };
  return group
    ? t(`chart.titles.${kind}`, values)
    : t(`chart.titles.${kind}All` as 'chart.titles.countAll', values);
}

function ChartOf({
  props,
  editable,
  setProps,
  data,
  host,
  databaseId,
  newer,
}: PluginViewProps<ChartProps> & { host: DatabaseHost; databaseId: string }) {
  const { t, locale, rtl } = usePluginT();
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
  const title = props.title ?? autoTitle(t, measure, grouped ? group : undefined, measured);
  const change = (next: Partial<ChartProps>) => setProps({ ...props, ...next });

  let body;
  if (!database || !view)
    body = (
      <Message text={database ? t('common.loading') : t('common.missing')} busy={!!database} />
    );
  else if (snapshot.error)
    body = (
      <Message text={t('common.loadFailed')} error>
        <button type="button" className="cgw-plugin-link" onClick={() => source?.retry()}>
          {t('common.retry')}
        </button>
      </Message>
    );
  else if (props.chart !== 'number' && !group) body = <Message text={t('chart.chooseGroup')} />;
  else if (snapshot.loading && !snapshot.rows.length && !snapshot.groups?.length)
    body = <Message text={t('common.loading')} busy />;
  else if (props.chart === 'number') {
    const total = totalOf(database, snapshot, measure);
    body = (
      <div className="cgw-plugin-number" data-testid="chart-number">
        <span className="cgw-plugin-number-value">
          {total.value === null ? t('chart.noValue') : formatNumber(total.value, locale)}
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
        <PointChart
          kind={props.chart}
          points={shown}
          name={title}
          locale={locale}
          rtl={rtl}
          strings={chartStrings(t)}
        />
        {partial ? <Partial /> : null}
      </>
    ) : (
      <Message text={t('chart.noRows')} />
    );
  }

  return (
    <section
      className="cgw-plugin cgw-plugin-chart"
      aria-label={t('chart.label', { title })}
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
  const { t, locale } = usePluginT();
  return (
    <p className="cgw-plugin-note">
      {t('chart.partial', { count: formatNumber(ROW_CAP, locale) })}
    </p>
  );
}

const formatNumber = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

function chartStrings(t: PluginT): Partial<CgChartStrings> {
  return {
    noData: t('chart.noRows'),
    loading: t('common.loading'),
    noValue: t('chart.noValue'),
  };
}

function PointChart({
  kind,
  points,
  name,
  locale,
  rtl,
  strings,
}: {
  kind: Exclude<ChartKind, 'number'>;
  points: ChartPoint[];
  name: string;
  locale: string;
  rtl: boolean;
  strings: Partial<CgChartStrings>;
}) {
  const series = useMemo<CgChartSeriesDescriptor<ChartPoint>[]>(
    () => [
      {
        type: kind,
        name,
        argument: (point) => point.label,
        value: (point) => point.value,
        ...(kind === 'pie' ? { showPercentages: true } : {}),
      } as CgChartSeriesDescriptor<ChartPoint>,
    ],
    [kind, name],
  );
  return (
    <div className="cgw-plugin-chart-canvas" data-testid="chart-canvas">
      <CgChart<ChartPoint>
        data={points}
        series={series}
        height={280}
        ariaLabel={name}
        locale={locale}
        direction={rtl ? 'rtl' : 'ltr'}
        strings={strings}
        legend={{ visible: kind === 'pie' }}
        argumentAxis={{ categorySort: 'dataOrder' }}
        animation="none"
      />
    </div>
  );
}

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
  const titleId = useId();
  const NONE = '';
  const numbers = measurable(database);
  const measureKind = props.measure.kind;
  return (
    <div className="cgw-plugin-settings" role="group" aria-label={t('common.settings')}>
      <SelectRow
        label={t('chart.kind')}
        value={props.chart}
        options={CHART_KINDS.map((kind) => ({ value: kind, label: t(`chart.kinds.${kind}`) }))}
        onChange={(chart) => change({ chart })}
      />
      <SelectRow
        label={t('chart.groupBy')}
        value={props.groupBy ?? NONE}
        options={[
          { value: NONE, label: t('chart.groupNone') },
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
      <SelectRow
        label={t('chart.measure')}
        value={measureKind}
        options={[
          { value: 'count', label: t('chart.count') },
          ...(numbers.length
            ? [
                { value: 'sum' as const, label: t('chart.sum') },
                { value: 'average' as const, label: t('chart.average') },
              ]
            : []),
        ]}
        onChange={(kind) =>
          change({
            measure:
              kind === 'count' || !numbers.length
                ? { kind: 'count' }
                : {
                    kind,
                    propertyId:
                      props.measure.kind !== 'count' &&
                      numbers.some(
                        (p) => p.id === (props.measure as { propertyId: string }).propertyId,
                      )
                        ? props.measure.propertyId
                        : numbers[0].id,
                  },
          })
        }
      />
      {props.measure.kind !== 'count' && numbers.length ? (
        <SelectRow
          label={t('chart.measureOf')}
          value={props.measure.propertyId}
          options={numbers.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(propertyId) =>
            change({
              measure: { kind: (props.measure as { kind: 'sum' | 'average' }).kind, propertyId },
            })
          }
        />
      ) : null}
      <div className="cgw-plugin-field">
        <label className="cgw-plugin-field-label" htmlFor={titleId}>
          {t('chart.title')}
        </label>
        <input
          id={titleId}
          className="cgw-plugin-input"
          dir="auto"
          defaultValue={props.title ?? ''}
          placeholder={t('chart.titlePlaceholder')}
          maxLength={200}
          onBlur={(event) => {
            const title = event.target.value.trim() || null;
            if (title !== props.title) change({ title });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
      </div>
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
