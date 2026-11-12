// A view's grouping: the property (select, status, multi-select, checkbox, person, dates and the
// automatic ones), dates by day, week, month or year, hiding empty groups, and showing or hiding
// each group. Each change is one view write.
import { CgSwitch } from '@cashgear/ui';
import { useId } from 'react';
import { DEFAULT_DATE_BY, type DatabaseRecord, type GroupRule } from '../core';
import type { CellEnv } from '../cells/env';
import { useDbT } from '../i18n';
import { isDateType, isGroupable, liveProperties, propertyOf } from '../model/properties';
import { groupText } from '../views/GroupLabel';

const DATE_BY = ['day', 'week', 'month', 'year'] as const;

export function GroupEditor({
  database,
  group,
  /** Keys of the groups the view shows now (the snapshot's), for show and hide. */
  shownKeys,
  required,
  editable,
  env,
  onChange,
}: {
  database: DatabaseRecord;
  group: GroupRule | null;
  shownKeys: readonly string[];
  /** A board must be grouped: "No grouping" is not offered. */
  required?: boolean;
  editable: boolean;
  env: CellEnv;
  onChange(group: GroupRule | null): void;
}) {
  const { t } = useDbT();
  const id = useId();
  const candidates = liveProperties(database).filter((p) => isGroupable(p.type));
  const def = group ? propertyOf(database, group.propertyId) : undefined;
  const hidden = group?.hidden ?? [];
  const keys = [...new Set([...shownKeys, ...hidden])];

  return (
    <div className="cgw-setup cgw-group-editor">
      <label className="cgw-label" htmlFor={`${id}-by`}>
        {t('group.by')}
      </label>
      <select
        id={`${id}-by`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={group?.propertyId ?? ''}
        disabled={!editable}
        onChange={(event) => {
          const next = event.target.value;
          if (!next) return onChange(null);
          const nextDef = propertyOf(database, next);
          onChange({
            propertyId: next,
            ...(nextDef && isDateType(nextDef.type) ? { dateBy: DEFAULT_DATE_BY } : {}),
          });
        }}
      >
        {!required ? <option value="">{t('group.none')}</option> : null}
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {group && def && isDateType(def.type) ? (
        <>
          <label className="cgw-label" htmlFor={`${id}-date`}>
            {t('group.dateBy')}
          </label>
          <select
            id={`${id}-date`}
            className="cgw-select"
            value={group.dateBy ?? DEFAULT_DATE_BY}
            disabled={!editable}
            onChange={(event) =>
              onChange({ ...group, dateBy: event.target.value as GroupRule['dateBy'] })
            }
          >
            {DATE_BY.map((d) => (
              <option key={d} value={d}>
                {t(`group.${d}`)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {group ? (
        <>
          <CgSwitch
            checked={group.hideEmpty === true}
            disabled={!editable}
            label={t('group.hideEmpty')}
            onCheckedChange={(on) => onChange({ ...group, hideEmpty: on })}
          />
          {keys.length ? (
            <ul className="cgw-group-keys" aria-label={t('group.hiddenGroups')}>
              {keys.map((key) => {
                const name = groupText(def, group, key, env);
                const isHidden = hidden.includes(key);
                return (
                  <li key={key} className="cgw-group-key">
                    <CgSwitch
                      checked={!isHidden}
                      disabled={!editable}
                      label={name}
                      aria-label={t(isHidden ? 'group.showGroup' : 'group.hideGroup', { name })}
                      onCheckedChange={(on) =>
                        onChange({
                          ...group,
                          hidden: on ? hidden.filter((k) => k !== key) : [...hidden, key],
                        })
                      }
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
