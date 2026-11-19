// A chart's points drawn with the UI library's `CgChart` as bars, a line or a pie: the chart block's
// drawing, moved here in Phase 12 so the chart view draws the same. Loaded on its own, with the
// first chart on screen (`ChartDrawing`): `CgChart` stays out of the initial JavaScript and out of
// the database views' common chunk.
import { CgChart, type CgChartSeriesDescriptor, type CgChartStrings } from '@cashgear/ui';
import { useMemo } from 'react';
import type { ChartKind } from '../../core';
import type { ChartPoint } from './aggregate';

export interface ChartCanvasProps {
  kind: ChartKind;
  points: ChartPoint[];
  /** The chart's title: its series' name and its accessible name. */
  name: string;
  locale: string;
  rtl: boolean;
  strings: Partial<CgChartStrings>;
  height?: number;
}

export default function ChartCanvas({
  kind,
  points,
  name,
  locale,
  rtl,
  strings,
  height = 280,
}: ChartCanvasProps) {
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
    <CgChart<ChartPoint>
      data={points}
      series={series}
      height={height}
      ariaLabel={name}
      locale={locale}
      direction={rtl ? 'rtl' : 'ltr'}
      strings={strings}
      legend={{ visible: kind === 'pie' }}
      argumentAxis={{ categorySort: 'dataOrder' }}
      animation="none"
    />
  );
}
