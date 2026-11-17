// The timeline's layout settings (`ViewConfig.timeline`): the date property its bars start at,
// the one they end at (or the start's own range), the lanes' select or status property, the zoom,
// and the list of rows with no date beside it. One view write per change.
import { useId } from 'react';
import type { TimelineConfig } from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { isDateType, liveProperties } from '../../model/properties';
import type { ViewSettingsProps } from '../types';
import { SCALES, timelineOf } from './timeline';

export function TimelineSettings({ database, view }: ViewSettingsProps) {
  const { t } = useDbT();
  const { actions, editable } = useDatabaseContext();
  const id = useId();
  const current = timelineOf(view.config);
  const live = liveProperties(database);
  const dates = live.filter((p) => isDateType(p.type));
  const lanes = live.filter((p) => p.type === 'select' || p.type === 'status');
  const set = (change: Partial<TimelineConfig>) => {
    const next: TimelineConfig = { ...current, ...change };
    // A new start with no sort yet: earliest first.
    const sorts =
      change.start && !view.config.sorts.length
        ? [{ propertyId: change.start, direction: 'asc' as const }]
        : view.config.sorts;
    void actions.updateView(view, { ...view.config, sorts, timeline: next });
  };
  const valueOf = (value: string | null, among: { id: string }[]) =>
    value && among.some((p) => p.id === value) ? value : '';
  const scaleNames = {
    day: t('timeline.scaleDay'),
    week: t('timeline.scaleWeek'),
    month: t('timeline.scaleMonth'),
    quarter: t('timeline.scaleQuarter'),
  };
  return (
    <div className="cgw-setup cgw-layout-settings">
      <label className="cgw-label" htmlFor={`${id}-start`}>
        {t('layout.timelineStart')}
      </label>
      <select
        id={`${id}-start`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={valueOf(current.start, dates)}
        disabled={!editable}
        onChange={(event) => set({ start: event.target.value || null })}
      >
        <option value="">{t('calendar.pickDate')}</option>
        {dates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-end`}>
        {t('layout.timelineEnd')}
      </label>
      <select
        id={`${id}-end`}
        className="cgw-select"
        value={valueOf(current.end, dates)}
        disabled={!editable}
        onChange={(event) => set({ end: event.target.value || null })}
      >
        <option value="">{t('layout.timelineOwnEnd')}</option>
        {dates
          .filter((p) => p.id !== current.start)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-lane`}>
        {t('layout.timelineLane')}
      </label>
      <select
        id={`${id}-lane`}
        className="cgw-select"
        value={valueOf(current.lane, lanes)}
        disabled={!editable}
        onChange={(event) => set({ lane: event.target.value || null })}
      >
        <option value="">{t('layout.timelineNoLanes')}</option>
        {lanes.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-scale`}>
        {t('layout.timelineScale')}
      </label>
      <select
        id={`${id}-scale`}
        className="cgw-select"
        value={current.scale}
        disabled={!editable}
        onChange={(event) => set({ scale: event.target.value as TimelineConfig['scale'] })}
      >
        {SCALES.map((scale) => (
          <option key={scale} value={scale}>
            {scaleNames[scale]}
          </option>
        ))}
      </select>
      <label className="cgw-db-tl-check">
        <input
          type="checkbox"
          checked={current.undated}
          disabled={!editable}
          onChange={(event) => set({ undated: event.target.checked })}
        />
        <span>{t('layout.timelineUndated')}</span>
      </label>
    </div>
  );
}
