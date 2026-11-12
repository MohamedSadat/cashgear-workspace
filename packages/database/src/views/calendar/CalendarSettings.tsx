// The calendar's layout setting: the date property rows are placed by (`calendarBy`). One view
// write per change.
import { useId } from 'react';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { isDateType, liveProperties } from '../../model/properties';
import type { ViewSettingsProps } from '../types';

export function CalendarSettings({ database, view }: ViewSettingsProps) {
  const { t } = useDbT();
  const { actions, editable } = useDatabaseContext();
  const id = useId();
  const candidates = liveProperties(database).filter((p) => isDateType(p.type));
  const current = view.config.calendarBy ?? '';
  return (
    <div className="cgw-setup cgw-layout-settings">
      <label className="cgw-label" htmlFor={`${id}-by`}>
        {t('layout.calendarBy')}
      </label>
      <select
        id={`${id}-by`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={candidates.some((p) => p.id === current) ? current : ''}
        disabled={!editable}
        onChange={(event) =>
          void actions.updateView(view, { ...view.config, calendarBy: event.target.value || null })
        }
      >
        <option value="">{t('calendar.pickDate')}</option>
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
