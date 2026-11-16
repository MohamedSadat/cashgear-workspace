// A view's sorts: several rules, each a property and a direction, applied in turn; reordered by
// their handles in the library's `CgSortableList` (drag, or ArrowUp, ArrowDown, Home and End on
// the handle). Each change is one view write.
import { CgButton, CgSortableList } from '@cashgear/ui';
import type { DatabaseRecord, SortRule } from '../core';
import { useDbT } from '../i18n';
import { liveProperties, propertyOf } from '../model/properties';

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
  /** `toIndex`: the rule's place after the move. */
  const move = (id: string, toIndex: number) => {
    const moved = sorts.find((s) => s.propertyId === id);
    if (!moved) return;
    const next = sorts.filter((s) => s !== moved);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
    onChange(next);
  };
  const unused = live.filter((p) => !ids.includes(p.id));

  return (
    <div className="cgw-sort-editor">
      {sorts.length === 0 ? <p className="cgw-picker-note">{t('sort.empty')}</p> : null}
      <CgSortableList
        className="cgw-sort-list"
        label={t('sort.title')}
        items={sorts}
        getKey={(rule) => rule.propertyId}
        handleLabel={() => t('sort.drag')}
        disabled={!editable}
        onMove={move}
        renderItem={(rule, { index: i }) => {
          const def = propertyOf(database, rule.propertyId);
          return (
            <>
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
            </>
          );
        }}
      />
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
