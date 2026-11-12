// A row's properties as the shell shows them above the row page's body: each property's name
// (which opens its menu) and its value, drawn and edited by the same cells as the table (Enter or
// a click edits, Escape cancels, a commit is one write). The title is the page's own and is left
// to the page.
import type { Id, RowRecord } from '@cgw/workspace';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { renderCell } from './cells/CellDisplay';
import { useCellEnv, type CellEnv } from './cells/env';
import { InlineEditor } from './cells/InlineEditor';
import { PickerEditor } from './cells/PickerEditor';
import { DatabaseContext, useDatabase, useDatabaseContextValue, useHost } from './context';
import type { PropertyDef } from './core';
import type { DatabaseHost } from './host';
import { useDbT } from './i18n';
import {
  TYPE_GLYPH,
  editKind,
  isEditableType,
  liveProperties,
  uniqueName,
} from './model/properties';
import { newPropertyDef } from './properties/defs';
import { PropertyMenu } from './properties/PropertyMenu';
import { TypePicker } from './properties/TypePicker';
import { CellFlyout } from './cells/CellFlyout';
import './database.css';

export interface RowPropertiesProps {
  host: DatabaseHost;
  /** The row's page id; its record is read live from `host.page`. */
  rowId: Id;
  /** False when the page around it is read-only; the host's `canEdit` decides the rest. */
  editable?: boolean;
}

export function RowProperties({ host, rowId, editable: pageEditable = true }: RowPropertiesProps) {
  const { t } = useDbT();
  const page = useHost(host, () => host.page(rowId));
  const row = page && page.kind === 'row' ? (page as RowRecord) : null;
  const databaseId = row?.databaseId ?? page?.parentPageId ?? '';
  const database = useDatabase(host, databaseId);
  const canEdit = useHost(host, () => (databaseId ? host.canEdit(databaseId) : false));
  const editable = pageEditable && canEdit;
  const context = useDatabaseContextValue(host, databaseId, editable);
  const env = useCellEnv(host, context.actions, editable);
  const [editing, setEditing] = useState<{ id: string; seed: string | null } | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const properties = useMemo(
    () => (database ? liveProperties(database).filter((p) => p.type !== 'title') : []),
    [database],
  );

  if (!row || !database) return null;
  const menuDef = menu ? properties.find((p) => p.id === menu.id) : undefined;
  const title = row.title || t('untitled');

  return (
    <DatabaseContext.Provider value={context}>
      <section className="cgw-row-props" aria-label={t('row.properties', { title })}>
        <dl className="cgw-row-props-list">
          {properties.map((def) => (
            <PropertyLine
              key={def.id}
              def={def}
              row={row}
              env={env}
              editable={editable}
              editing={editing?.id === def.id ? editing : null}
              onEdit={(seed) => setEditing({ id: def.id, seed })}
              onDone={() => setEditing(null)}
              onMenu={(anchor) => setMenu({ id: def.id, anchor })}
            />
          ))}
        </dl>
        {editable ? (
          <button
            type="button"
            className="cgw-text-button cgw-row-props-add"
            onClick={(event) => setAdding(event.currentTarget)}
          >
            <span aria-hidden="true">＋ </span>
            {t('row.addProperty')}
          </button>
        ) : null}
        {menu && menuDef ? (
          <PropertyMenu
            def={menuDef}
            database={database}
            view={null}
            rows={[row]}
            anchor={menu.anchor}
            onClose={() => setMenu(null)}
          />
        ) : null}
        {adding ? (
          <CellFlyout
            anchor={adding}
            label={t('property.addLabel')}
            width={240}
            onClose={() => setAdding(null)}
          >
            <TypePicker
              label={t('property.addLabel')}
              onPick={(type) => {
                setAdding(null);
                void context.actions.addProperty(
                  newPropertyDef(type, uniqueName(database, t(`type.${type}`)), {
                    todo: t('option.defaultTodo'),
                    inProgress: t('option.defaultInProgress'),
                    complete: t('option.defaultComplete'),
                  }),
                );
              }}
            />
          </CellFlyout>
        ) : null}
      </section>
    </DatabaseContext.Provider>
  );
}

function PropertyLine({
  def,
  row,
  env,
  editable,
  editing,
  onEdit,
  onDone,
  onMenu,
}: {
  def: PropertyDef;
  row: RowRecord;
  env: CellEnv;
  editable: boolean;
  editing: { seed: string | null } | null;
  onEdit(seed: string | null): void;
  onDone(): void;
  onMenu(anchor: HTMLElement): void;
}) {
  const { t } = env;
  const [cell, setCell] = useState<HTMLDivElement | null>(null);
  const kind = editKind(def.type);
  const canEditValue = editable && isEditableType(def.type);
  const start = (seed: string | null = null) => {
    if (!canEditValue) return;
    if (kind === 'toggle') void env.actions.setValue(row, def, row.values[def.id] !== true);
    else if (kind !== 'none') onEdit(seed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === 'F2' || (event.key === ' ' && kind === 'toggle')) {
      event.preventDefault();
      start();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && canEditValue) {
      event.preventDefault();
      void env.actions.setValue(row, def, null);
    }
  };
  const done = () => {
    onDone();
    requestAnimationFrame(() => cell?.focus());
  };
  const content = renderCell(def, row, env);
  return (
    <div className="cgw-row-prop">
      <dt>
        <button
          type="button"
          className="cgw-row-prop-name"
          aria-haspopup="dialog"
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <span className="cgw-th-glyph" aria-hidden="true">
            {TYPE_GLYPH[def.type]}
          </span>
          <span dir="auto">{def.name}</span>
        </button>
      </dt>
      <dd>
        <div
          ref={setCell}
          className={`cgw-row-prop-value cgw-type-${def.type}`}
          tabIndex={0}
          role="button"
          aria-label={t('cell.edit', { name: def.name })}
          aria-readonly={!canEditValue || undefined}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a, button, input, textarea')) return;
            start();
          }}
        >
          {editing && kind === 'inline' ? (
            <InlineEditor
              def={def}
              row={row}
              env={env}
              seed={editing.seed}
              onDone={done}
              label={def.name}
            />
          ) : (
            (content ?? <span className="cgw-placeholder">{t('cell.empty')}</span>)
          )}
          {editing && kind === 'picker' && cell ? (
            <PickerEditor def={def} row={row} env={env} anchor={cell} onDone={done} />
          ) : null}
        </div>
      </dd>
    </div>
  );
}
