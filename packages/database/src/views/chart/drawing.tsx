// A chart's drawing as the chart view and the chart block put it on a page: a box (the block's
// `chart-canvas`) holding `ChartCanvas`, which loads on its own with the first chart drawn, and a
// note while it does. Its words are the chart's (`useChartT`).
import type { CgChartStrings } from '@cashgear/ui';
import { lazy, Suspense, useMemo } from 'react';
import type { ChartKind } from '../../core';
import { useDbT } from '../../i18n';
import type { ChartPoint } from './aggregate';
import { useChartT } from './words';
import './chart.css';

const ChartCanvas = lazy(() => import('./ChartCanvas'));

export interface ChartDrawingProps {
  kind: ChartKind;
  points: ChartPoint[];
  /** The chart's title: its accessible name and its series' name. */
  name: string;
  /** The box's class (the block's own, or the view's). */
  className?: string;
  height?: number;
}

export function ChartDrawing({ kind, points, name, className, height }: ChartDrawingProps) {
  const { t: ct, locale, rtl } = useChartT();
  const { t: dbT } = useDbT();
  const strings = useMemo<Partial<CgChartStrings>>(
    () => ({
      noData: ct('noRows'),
      loading: dbT('loading'),
      noValue: ct('noValue'),
      // The library's own words, which it would say in English.
      chartAriaLabel: ct('canvas.chart'),
      seriesRoleDescription: ct('canvas.series'),
      pointRoleDescription: ct('canvas.point'),
      tooSmall: ct('canvas.tooSmall'),
      dataTableSummary: ct('canvas.table'),
      dataTableToggle: ct('canvas.tableToggle'),
      argumentColumnHeader: ct('canvas.argument'),
      percentageColumnHeader: ct('canvas.percentage'),
      legendAriaLabel: ct('canvas.legend'),
      thousandSuffix: ct('canvas.thousand'),
      millionSuffix: ct('canvas.million'),
      billionSuffix: ct('canvas.billion'),
      seriesShownTemplate: ct('canvas.seriesShown'),
      seriesHiddenTemplate: ct('canvas.seriesHidden'),
      pointSelectedTemplate: ct('canvas.pointSelected'),
      selectionCleared: ct('canvas.selectionCleared'),
      pointLabelTemplate: ct('canvas.pointLabel'),
      seriesLabelTemplate: ct('canvas.seriesLabel'),
      keyboardInstructions: ct('canvas.keyboard'),
    }),
    [ct, dbT],
  );
  return (
    <div className={className ?? 'cgw-db-chart-canvas'} data-testid="chart-canvas">
      <Suspense
        fallback={
          <p className="cgw-db-chart-drawing" role="status" aria-busy="true">
            {ct('view.drawing')}
          </p>
        }
      >
        <ChartCanvas
          kind={kind}
          points={points}
          name={name}
          locale={locale}
          rtl={rtl}
          strings={strings}
          height={height}
        />
      </Suspense>
    </div>
  );
}
