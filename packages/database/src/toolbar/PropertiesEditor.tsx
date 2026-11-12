// The view's properties: each shown or hidden (the title always shown), in the view's order
// (drag a handle, or ArrowUp and ArrowDown on it); Show all and Hide all; adding a property; and
// the deleted properties, each of which can be restored.
import { CgButton, CgSwitch } from '@cashgear/ui';
import { useState } from 'react';
import { TITLE_PROPERTY, type DatabaseRecord, type PropertyType, type ViewRecord } from '../core';
import { useDatabaseContext } from '../context';
import { useDbT } from '../i18n';
import { TYPE_GLYPH, orderedProperties, uniqueName } from '../model/properties';
import { moveProperty, withAllHidden, withHidden } from '../model/viewConfig';
import { useReorder } from '../pickers/reorder';
import { newPropertyDef } from '../properties/defs';
import { TypePicker } from '../properties/TypePicker';

export function PropertiesEditor({
  database,
  view,
  titleFirst = true,
}: {
  database: DatabaseRecord;
  view: ViewRecord;
  /** Tables and lists always show the title first. */
  titleFirst?: boolean;
}) {
  const { t } = useDbT();
  const { actions, editable } = useDatabaseContext();
  const [adding, setAdding] = useState(false);
  const ordered = orderedProperties(database, view.config);
  const hidden = new Set(view.config.properties.hidden);
  const ids = ordered.map((p) => p.id);
  const { state, handleProps } = useReorder(
    ids,
    (id, to) => void actions.updateView(view, moveProperty(view.config, database, id, to)),
  );
  const deleted = database.properties.filter((p) => p.trashedAt);

  if (adding)
    return (
      <div className="cgw-panel">
        <div className="cgw-panel-head">
          <button
            type="button"
            className="cgw-icon-button"
            aria-label={t('back')}
            onClick={() => setAdding(false)}
          >
            <span aria-hidden="true" className="cgw-back-glyph">
              ‹
            </span>
          </button>
          <span className="cgw-panel-title">{t('property.addLabel')}</span>
        </div>
        <TypePicker
          label={t('property.addLabel')}
          onPick={(type: PropertyType) => {
            const def = newPropertyDef(type, uniqueName(database, t(`type.${type}`)), {
              todo: t('option.defaultTodo'),
              inProgress: t('option.defaultInProgress'),
              complete: t('option.defaultComplete'),
            });
            const last = ordered[ordered.length - 1];
            void actions.addProperty(
              def,
              last ? { view, anchor: last.id, side: 'after' } : undefined,
            );
            setAdding(false);
          }}
        />
      </div>
    );

  return (
    <div className="cgw-properties-editor">
      {editable ? (
        <div className="cgw-filter-actions">
          <CgButton
            appearance="ghost"
            size="small"
            onClick={() =>
              void actions.updateView(view, withAllHidden(view.config, database, false))
            }
          >
            {t('properties.showAll')}
          </CgButton>
          <CgButton
            appearance="ghost"
            size="small"
            onClick={() =>
              void actions.updateView(view, withAllHidden(view.config, database, true))
            }
          >
            {t('properties.hideAll')}
          </CgButton>
        </div>
      ) : null}
      <ul className="cgw-props-list" aria-label={t('properties.title')}>
        {ordered.map((def, i) => {
          const fixed = titleFirst && def.id === TITLE_PROPERTY;
          const isShown = fixed || !hidden.has(def.id);
          return (
            <li
              key={def.id}
              className="cgw-props-item"
              data-reorder-id={def.id}
              data-drop={state.dragging && state.over === i ? 'true' : undefined}
            >
              {editable ? (
                <button
                  type="button"
                  className="cgw-handle"
                  aria-label={t('properties.drag', { name: def.name })}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  {...handleProps(def.id)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
              ) : null}
              <span className="cgw-th-glyph" aria-hidden="true">
                {TYPE_GLYPH[def.type]}
              </span>
              <span className="cgw-props-name" dir="auto">
                {def.name}
              </span>
              <CgSwitch
                checked={isShown}
                disabled={fixed || !editable}
                aria-label={t(isShown ? 'properties.hide' : 'properties.show', { name: def.name })}
                onCheckedChange={(on) =>
                  void actions.updateView(view, withHidden(view.config, def.id, !on))
                }
              />
            </li>
          );
        })}
      </ul>
      {editable ? (
        <CgButton appearance="outline" size="small" onClick={() => setAdding(true)}>
          {t('property.add')}
        </CgButton>
      ) : null}
      {deleted.length ? (
        <section className="cgw-props-deleted" aria-label={t('properties.deleted')}>
          <h3 className="cgw-panel-title">{t('properties.deleted')}</h3>
          <ul className="cgw-props-list">
            {deleted.map((def) => (
              <li key={def.id} className="cgw-props-item">
                <span className="cgw-th-glyph" aria-hidden="true">
                  {TYPE_GLYPH[def.type]}
                </span>
                <span className="cgw-props-name" dir="auto">
                  {def.name}
                </span>
                {editable ? (
                  <CgButton
                    appearance="ghost"
                    size="small"
                    aria-label={t('properties.restore', { name: def.name })}
                    onClick={() => void actions.restoreProperty(def)}
                  >
                    {t('properties.restoreShort')}
                  </CgButton>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
