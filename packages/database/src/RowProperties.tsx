// A row's properties as the shell shows them above the row page's body: each property's name
// (which opens its menu) and its value, drawn and edited by the same cells as the table (Enter or
// a click edits, Escape cancels, a commit is one write). A value is never a control around another
// (Axe's nested-interactive, WCAG 4.1.2): one that is a control of its own (a button, a checkbox)
// is that control alone; one holding controls (a link, a file's or a related row's chip) is a
// group of them and an Edit button. The title is the page's own and is left to the page.
import type { Id, RowRecord } from '@cgw/workspace';
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { renderCell } from './cells/CellDisplay';
import { useCellEnv, type CellEnv } from './cells/env';
import { InlineEditor } from './cells/InlineEditor';
import { PickerEditor } from './cells/PickerEditor';
import { DatabaseContext, useDatabase, useDatabaseContextValue, useHost } from './context';
import { newPropertyId, type PropertyDef, type PropertyType } from './core';
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
import { NewPropertySetup, SET_UP_FIRST } from './properties/NewPropertySetup';
import { PropertyMenu } from './properties/PropertyMenu';
import { TypePicker } from './properties/TypePicker';
import { CellFlyout } from './cells/CellFlyout';
import { AutomationsButton } from './automations/AutomationsButton';
import './database.css';

/** Phase 15: a row's automation runs, loaded when its automations are there. */
const RowRuns = lazy(() => import('./automations/RowRuns').then((m) => ({ default: m.RowRuns })));
/** Phase 17: the person's own reminders of the row's dates, loaded likewise. */
const RowReminders = lazy(() =>
  import('./automations/RowReminders').then((m) => ({ default: m.RowReminders })),
);

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
  const [settingUp, setSettingUp] = useState<{ def: PropertyDef; anchor: HTMLElement } | null>(
    null,
  );
  const properties = useMemo(
    () => (database ? liveProperties(database).filter((p) => p.type !== 'title') : []),
    [database],
  );
  const automations = useHost(host, () => host.automations);

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
                const anchor = adding;
                setAdding(null);
                const name = uniqueName(database, t(`type.${type}`));
                // A relation or a rollup is set up first: written without its settings it is
                // refused.
                if (SET_UP_FIRST.includes(type)) {
                  if (anchor) setSettingUp({ def: { id: newPropertyId(), name, type }, anchor });
                  return;
                }
                void context.actions.addProperty(
                  newPropertyDef(type, name, {
                    todo: t('option.defaultTodo'),
                    inProgress: t('option.defaultInProgress'),
                    complete: t('option.defaultComplete'),
                  }),
                );
              }}
            />
          </CellFlyout>
        ) : null}
        {automations && !row.isTemplate ? (
          <>
            {/* A button property's "Add an automation" opens the dialog from here too. */}
            <AutomationsButton databaseId={database.id} hidden />
            <Suspense fallback={null}>
              {automations.reminders ? (
                <RowReminders automations={automations} database={database} rowId={row.id} />
              ) : null}
              <RowRuns automations={automations} databaseId={database.id} rowId={row.id} />
            </Suspense>
          </>
        ) : null}
        {settingUp ? (
          <NewPropertySetup
            def={settingUp.def}
            database={database}
            anchor={settingUp.anchor}
            onSave={({ def, reverse }) =>
              void (def.type === 'relation'
                ? context.actions.addRelation(def, reverse)
                : context.actions.addProperty(def))
            }
            onClose={() => setSettingUp(null)}
          />
        ) : null}
      </section>
    </DatabaseContext.Provider>
  );
}

/**
 * How a property's value is drawn on a row's page: `sole`, a value that is one control of its own
 * (Phase 15's button, pressed once a press; a checkbox, toggled once); `group`, a value holding
 * controls of its own (a link; a file's or a related row's chip, each opening it), with an Edit
 * button after them; `control`, every other value, the control that edits it.
 */
export function valueShape(type: PropertyType): 'sole' | 'group' | 'control' {
  switch (type) {
    case 'button':
    case 'checkbox':
      return 'sole';
    case 'url':
    case 'email':
    case 'phone':
    case 'files':
    case 'relation':
      return 'group';
    default:
      return 'control';
  }
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
  const edit = useRef<HTMLButtonElement>(null);
  const kind = editKind(def.type);
  const shape = valueShape(def.type);
  const canEditValue = editable && isEditableType(def.type);
  const start = (seed: string | null = null) => {
    if (!canEditValue) return;
    if (kind === 'toggle') void env.actions.setValue(row, def, row.values[def.id] !== true);
    else if (kind !== 'none') onEdit(seed);
  };
  // Enter and F2 edit (a checkbox: toggle it), and Space where the key is not the control's own;
  // Delete and Backspace empty the value.
  const keys = (event: KeyboardEvent<HTMLElement>, space: boolean) => {
    if (event.key === 'Enter' || event.key === 'F2' || (space && event.key === ' ')) {
      event.preventDefault();
      start();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && canEditValue) {
      event.preventDefault();
      void env.actions.setValue(row, def, null);
    }
  };
  // A click in the value edits it, unless it lands on one of the value's own controls. A click in
  // the picker's flyout bubbles here through React's portal: the option chosen there closes the
  // picker, and must not open it again.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest('a, button, input, textarea, label')) return;
    start();
  };
  const done = () => {
    onDone();
    requestAnimationFrame(() => (shape === 'group' ? edit.current : cell)?.focus());
  };
  const content = renderCell(def, row, env, { tabStops: shape !== 'control' });
  // A value that edits is named by the property and its value, as they are shown (the value's text
  // is part of the name); what a press does is its description.
  const nameId = useId();
  const valueId = `${nameId}-value`;
  const className = `cgw-row-prop-value cgw-type-${def.type}`;
  const inline =
    editing && kind === 'inline' ? (
      <InlineEditor
        def={def}
        row={row}
        env={env}
        seed={editing.seed}
        onDone={done}
        label={def.name}
      />
    ) : null;
  const picker =
    editing && kind === 'picker' && cell ? (
      <PickerEditor def={def} row={row} env={env} anchor={cell} onDone={done} />
    ) : null;
  const shown = (id?: string) => (
    <span id={id} className="cgw-row-prop-text">
      {content ?? <span className="cgw-placeholder">{t('cell.empty')}</span>}
    </span>
  );
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
          <span id={nameId} dir="auto">
            {def.name}
          </span>
        </button>
      </dt>
      <dd>
        {shape === 'sole' ? (
          // The value's control is the line's own (named by the property, or by its words). A
          // checkbox's keys are its own, and Enter toggles it too; a click beside it toggles it.
          def.type === 'checkbox' ? (
            <div
              className={className}
              onClick={onClick}
              onKeyDown={(event) => {
                if ((event.target as HTMLElement).matches('input[type="checkbox"]'))
                  keys(event, false);
              }}
            >
              {content}
            </div>
          ) : (
            <div className={className}>{content}</div>
          )
        ) : shape === 'group' ? (
          // The value's controls are stops of their own, named by what they open; the group is
          // named by the property, and its Edit button edits the value.
          <div className="cgw-row-prop-group" role="group" aria-labelledby={nameId}>
            <div ref={setCell} className={className} onClick={onClick}>
              {inline ?? shown()}
              {picker}
            </div>
            {canEditValue && !inline ? (
              <button
                ref={edit}
                type="button"
                className="cgw-text-button cgw-row-prop-edit"
                aria-label={t('cell.edit', { name: def.name })}
                aria-haspopup={kind === 'picker' ? 'dialog' : undefined}
                onKeyDown={(event) => keys(event, false)}
                onClick={() => start()}
              >
                {t('cell.editValue')}
              </button>
            ) : null}
          </div>
        ) : (
          <div
            ref={setCell}
            className={className}
            tabIndex={0}
            role="button"
            aria-labelledby={`${nameId} ${valueId}`}
            aria-description={canEditValue ? t('cell.edit', { name: def.name }) : undefined}
            aria-disabled={!canEditValue || undefined}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget) keys(event, true);
            }}
            onClick={onClick}
          >
            {inline ?? shown(valueId)}
            {picker}
          </div>
        )}
      </dd>
    </div>
  );
}
