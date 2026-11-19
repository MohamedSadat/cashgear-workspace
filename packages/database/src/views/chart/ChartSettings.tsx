// The chart view's layout settings (`ViewConfig.chart`): its kind (bars, a line or a pie), what it
// measures and its title, the chart block's own controls (`ChartControls`). Its group is the
// view's, set by Group in the toolbar. One view write per change, its properties kept to what the
// chart draws (`withChart`); a reader sees them and can change none.
import type { ChartConfig } from '../../core';
import { useDatabaseContext } from '../../context';
import type { ViewSettingsProps } from '../types';
import { ChartControls } from './ChartControls';
import { CHART_VIEW_KINDS, chartOf, withChart } from './config';
import { useChartT } from './words';
import './chart.css';

export function ChartSettings({ database, view }: ViewSettingsProps) {
  const { t: ct } = useChartT();
  const { actions, editable } = useDatabaseContext();
  const current = chartOf(view.config);
  const set = (change: Partial<ChartConfig>) =>
    void actions.updateView(view, withChart(database, view.config, change));
  return (
    <div className="cgw-setup cgw-layout-settings">
      <ChartControls
        database={database}
        kinds={CHART_VIEW_KINDS}
        kind={current.kind}
        measure={current.measure}
        title={current.title}
        disabled={!editable}
        initialFocus
        onKind={(kind) => set({ kind })}
        onMeasure={(measure) => set({ measure })}
        onTitle={(title) => set({ title })}
      />
      <p className="cgw-db-chart-hint">{ct('view.groupHint')}</p>
    </div>
  );
}
