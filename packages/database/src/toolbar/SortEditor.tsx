// A view's sorts: several rules, each a property and a direction, applied in turn; reordered by
// their handles (drag, or ArrowUp and ArrowDown on the handle). Each change is one view write.
import { CgButton } from '@cashgear/ui';
import type { DatabaseRecord, SortRule } from '../core';
import { useDbT } from '../i18n';
import { liveProperties, propertyOf } from '../model/properties';
import { moveIndex, useReorder } from '../pickers/reorder';

export function SortEditor({
  database,
  sorts,
  editable,
  onChange,
}: {
  database: DatabaseRecord;
  sorts: readonly SortRule[];
  editable: boolean;
  onChange(sorts: SortRule[]): void;
}) {
  const { t } = useDbT();
  const live = liveProperties(database);
  const ids = sorts.map((s) => s.propertyId);
  const { state, handleProps } = useReorder(ids, (id, to) => {
    const order = moveIndex(ids, id, to);
    onChange(order.map((p) => sorts.find((s) => s.propertyId === p)!));
  });
  const unused = live.filter((p) => !ids.includes(p.id));

  return (
    <div className="cgw-sort-editor">
      {sorts.length === 0 ? <p className="cgw-picker-note">{t('sort.empty')}</p> : null}
      <ul className="cgw-sort-list" aria-label={t('sort.title')}>
        {sorts.map((rule, i) => {
          const def = propertyOf(database, rule.propertyId);
          return (
            <li
              key={rule.propertyId}
              className="cgw-sort-rule"
              data-reorder-id={rule.propertyId}
              data-drop={state.dragging && state.over === i ? 'true' : undefined}
            >
              {editable ? (
                <button
                  type="button"
                  className="cgw-handle"
                  aria-label={t('sort.drag')}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  {...handleProps(rule.propertyId)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
              ) : null}
              <select
                className="cgw-select"
                aria-label={t('sort.property')}
                value={rule.propertyId}
                disabled={!editable}
                onChange={(event) =>
                  onChange(
                    sorts.map((s, j) => (j === i ? { ...s, propertyId: event.target.value } : s)),
                  )
                }
              >
                {!def || def.trashedAt ? (
                  <option value={rule.propertyId}>{def?.name ?? '—'}</option>
                ) : null}
                {live
                  .filter((p) => p.id === rule.propertyId || !ids.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <select
                className="cgw-select"
                aria-label={t('sort.direction')}
                value={rule.direction}
                disabled={!editable}
                onChange={(event) =>
                  onChange(
                    sorts.map((s, j) =>
                      j === i ? { ...s, direction: event.target.value as 'asc' | 'desc' } : s,
                    ),
                  )
                }
              >
                <option value="asc">{t('sort.asc')}</option>
                <option value="desc">{t('sort.desc')}</option>
              </select>
              {editable ? (
                <button
                  type="button"
                  className="cgw-icon-button"
                  aria-label={t('sort.remove')}
                  onClick={() => onChange(sorts.filter((_, j) => j !== i))}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {editable && unused.length ? (
        <CgButton
          appearance="outline"
          size="small"
          data-cg-initial-focus=""
          onClick={() => onChange([...sorts, { propertyId: unused[0].id, direction: 'asc' }])}
        >
          {t('sort.add')}
        </CgButton>
      ) : null}
    </div>
  );
}
