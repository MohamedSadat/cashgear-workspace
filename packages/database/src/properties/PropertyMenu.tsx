// A property's menu, opened from its column header (or its name in a row's panel): its name; its
// type, changed with the conversion stated and previewed before it happens; its settings (number
// format, time of day, options, formula, relation, rollup); and, in a view, sort, filter, hide,
// insert and move; duplicate and delete. Panels replace each other inside one flyout.
import { CgButton, CgSwitch } from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { CellFlyout } from '../cells/CellFlyout';
import {
  TITLE_PROPERTY,
  newPropertyId,
  type DatabaseRecord,
  type NumberFormat,
  type PropertyDef,
  type PropertyType,
  type ViewRecord,
} from '../core';
import { useDatabaseContext, useLookups } from '../context';
import { useDbT } from '../i18n';
import {
  TYPE_GLYPH,
  isAutomaticType,
  isComputedType,
  isDateType,
  shownProperties,
} from '../model/properties';
import { placeProperty, withHidden, withSort } from '../model/viewConfig';
import { OptionPicker } from '../pickers/OptionPicker';
import { conversionRule, previewConversion, shapeForType } from './defs';
import { FormulaEditor } from './FormulaEditor';
import { MenuItem, MenuList, MenuSeparator, menuKeys } from './MenuList';
import { RelationSetup, RollupSetup } from './RelationSetup';
import { TypePicker } from './TypePicker';

export type PropertyPanel =
  | { kind: 'main' }
  | { kind: 'type' }
  | { kind: 'convert'; to: PropertyDef }
  | { kind: 'number' }
  | { kind: 'options' }
  | { kind: 'formula' }
  | { kind: 'relation' }
  | { kind: 'rollup' };

export interface PropertyMenuProps {
  def: PropertyDef;
  database: DatabaseRecord;
  /** The view it was opened in (sort, filter, hide, insert and move need one). */
  view: ViewRecord | null;
  /** Rows at hand: the conversion preview and the formula's example. */
  rows: readonly RowRecord[];
  anchor: HTMLElement;
  onClose(): void;
  /** Adds a filter on the property and opens the filter editor. */
  onFilter?(def: PropertyDef): void;
  /** A new property was inserted next to this one (its menu opens next). */
  onInserted?(def: PropertyDef): void;
  initialPanel?: PropertyPanel;
}

export function PropertyMenu(props: PropertyMenuProps) {
  const { t } = useDbT();
  return (
    <CellFlyout
      anchor={props.anchor}
      label={t('property.menu', { name: props.def.name })}
      width={300}
      onClose={() => props.onClose()}
    >
      <PropertyMenuBody {...props} />
    </CellFlyout>
  );
}

export function PropertyMenuBody({
  def,
  database,
  view,
  rows,
  onClose,
  onFilter,
  onInserted,
  initialPanel,
}: PropertyMenuProps) {
  const { t, rtl } = useDbT();
  const { host, actions, editable } = useDatabaseContext();
  const lookups = useLookups(host);
  const [panel, setPanel] = useState<PropertyPanel>(initialPanel ?? { kind: 'main' });
  const isTitle = def.id === TITLE_PROPERTY;
  const statusNames = {
    todo: t('option.defaultTodo'),
    inProgress: t('option.defaultInProgress'),
    complete: t('option.defaultComplete'),
  };
  const back = () => setPanel({ kind: 'main' });

  const rename = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== def.name) void actions.updateProperty({ ...def, name: trimmed });
  };

  const header = (title: string) => (
    <div className="cgw-panel-head">
      <button type="button" className="cgw-icon-button" aria-label={t('back')} onClick={back}>
        <span aria-hidden="true" className="cgw-back-glyph">
          ‹
        </span>
      </button>
      <span className="cgw-panel-title">{title}</span>
    </div>
  );

  if (panel.kind === 'type')
    return (
      <div className="cgw-panel">
        {header(t('property.changeType'))}
        <TypePicker
          current={def.type}
          label={t('property.changeType')}
          onPick={(type: PropertyType) => {
            if (type === def.type) return back();
            const to = shapeForType(def, type, statusNames);
            if (type === 'relation') return setPanel({ kind: 'relation' });
            if (type === 'rollup') return setPanel({ kind: 'rollup' });
            setPanel({ kind: 'convert', to });
          }}
        />
      </div>
    );

  if (panel.kind === 'convert') {
    const preview = previewConversion(database, def, panel.to, rows, lookups);
    const empty = t('cell.empty');
    return (
      <div className="cgw-panel" role="group" aria-labelledby="cgw-convert-title">
        {header(t('property.changeType'))}
        <div className="cgw-convert">
          <p id="cgw-convert-title" className="cgw-convert-title">
            {t('convert.title', { name: def.name, type: t(`type.${panel.to.type}`) })}
          </p>
          <p>{t('convert.body')}</p>
          <p>{t(conversionRule(panel.to.type))}</p>
          {rows.length ? (
            <>
              <p>{t('convert.preview')}</p>
              <ul className="cgw-convert-counts">
                <li>{t('convert.converted', { count: preview.converted })}</li>
                <li>{t('convert.cleared', { count: preview.cleared })}</li>
                <li>{t('convert.unchanged', { count: preview.unchanged })}</li>
              </ul>
              {preview.examples.length ? (
                <ul className="cgw-convert-examples">
                  {preview.examples.map((e, i) => (
                    <li key={i} dir="auto">
                      {t('convert.example', { before: e.before || empty, after: e.after || empty })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="cgw-panel-actions">
          <CgButton appearance="ghost" size="small" onClick={back}>
            {t('cancel')}
          </CgButton>
          <CgButton
            intent="primary"
            size="small"
            data-cg-initial-focus=""
            onClick={() => {
              void actions.updateProperty(panel.to);
              setPanel(panel.to.type === 'formula' ? { kind: 'formula' } : { kind: 'main' });
            }}
          >
            {t('convert.confirm')}
          </CgButton>
        </div>
      </div>
    );
  }

  if (panel.kind === 'number')
    return (
      <div className="cgw-panel">
        {header(t('property.numberFormat'))}
        <NumberSettings def={def} onChange={(next) => void actions.updateProperty(next)} />
      </div>
    );

  if (panel.kind === 'options')
    return (
      <div className="cgw-panel">
        {header(t('property.options'))}
        <OptionPicker
          def={def}
          selected={[]}
          multiple
          canManage={editable}
          manage
          onSelect={() => undefined}
          onDefChange={(next) => void actions.updateProperty(next)}
        />
      </div>
    );

  if (panel.kind === 'formula')
    return (
      <div className="cgw-panel cgw-panel-wide">
        {header(t('formula.title'))}
        <FormulaEditor
          database={database}
          def={def}
          sample={rows[0] ?? null}
          lookups={lookups}
          onSave={(expression) => {
            void actions.updateProperty({
              ...shapeForType(def, 'formula', statusNames),
              formula: { expression },
            });
            onClose();
          }}
        />
      </div>
    );

  if (panel.kind === 'relation')
    return (
      <div className="cgw-panel">
        {header(t('property.relationSetup'))}
        {def.type !== 'relation' ? (
          <p className="cgw-picker-note">{t('convert.toRelation')}</p>
        ) : null}
        <RelationSetup
          host={host}
          database={database}
          def={def}
          onSave={({ def: next, reverse }) => {
            void actions.saveRelation(next, reverse);
            onClose();
          }}
        />
      </div>
    );

  if (panel.kind === 'rollup')
    return (
      <div className="cgw-panel">
        {header(t('property.rollupSetup'))}
        {def.type !== 'rollup' ? (
          <p className="cgw-picker-note">{t('convert.toComputed')}</p>
        ) : null}
        <RollupSetup
          host={host}
          database={database}
          def={def}
          onSave={(next) => {
            void actions.updateProperty(next);
            onClose();
          }}
        />
      </div>
    );

  // The main panel.
  const shown = view ? shownProperties(database, view.config, true) : [];
  const at = shown.findIndex((p) => p.id === def.id);
  const insert = (side: 'before' | 'after') => {
    if (!view) return;
    const name = t('type.text');
    const created: PropertyDef = { id: newPropertyId(), name, type: 'text' };
    void actions.addProperty(created, { view, anchor: def.id, side });
    onInserted?.(created);
  };
  const move = (side: 'before' | 'after') => {
    if (!view) return;
    const neighbour = shown[side === 'before' ? at - 1 : at + 1];
    if (!neighbour || neighbour.id === TITLE_PROPERTY) return;
    void actions.updateView(view, placeProperty(view.config, database, def.id, neighbour.id, side));
  };
  // Left and right as the person sees them: in RTL the left is after.
  const leftSide = rtl ? 'after' : 'before';
  const rightSide = rtl ? 'before' : 'after';
  const canMoveLeft =
    view &&
    !isTitle &&
    shown[leftSide === 'before' ? at - 1 : at + 1] &&
    shown[leftSide === 'before' ? at - 1 : at + 1].id !== TITLE_PROPERTY;
  const canMoveRight =
    view &&
    !isTitle &&
    shown[rightSide === 'before' ? at - 1 : at + 1] &&
    shown[rightSide === 'before' ? at - 1 : at + 1].id !== TITLE_PROPERTY;

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      rename(event.currentTarget.value);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.currentTarget
        .closest('.cgw-panel')
        ?.querySelector<HTMLElement>('[role="menuitem"],[role="menuitemradio"]')
        ?.focus();
    }
  };

  return (
    <div className="cgw-panel" onKeyDown={menuKeys}>
      <input
        className="cgw-text-input"
        data-cg-initial-focus=""
        aria-label={t('property.name')}
        defaultValue={def.name}
        dir="auto"
        readOnly={!editable}
        onBlur={(event) => editable && rename(event.target.value)}
        onKeyDown={onNameKey}
      />
      <MenuList label={t('property.menu', { name: def.name })}>
        {editable && !isTitle ? (
          <MenuItem
            glyph={TYPE_GLYPH[def.type]}
            hint={t(`type.${def.type}`)}
            onSelect={() => setPanel({ kind: 'type' })}
          >
            {t('property.changeType')}
          </MenuItem>
        ) : null}
        {editable && def.type === 'number' ? (
          <MenuItem glyph="#" onSelect={() => setPanel({ kind: 'number' })}>
            {t('property.numberFormat')}
          </MenuItem>
        ) : null}
        {editable &&
        (def.type === 'select' || def.type === 'multiSelect' || def.type === 'status') ? (
          <MenuItem glyph="◉" onSelect={() => setPanel({ kind: 'options' })}>
            {t('property.options')}
          </MenuItem>
        ) : null}
        {editable && def.type === 'formula' ? (
          <MenuItem glyph="ƒ" onSelect={() => setPanel({ kind: 'formula' })}>
            {t('property.editFormula')}
          </MenuItem>
        ) : null}
        {editable && def.type === 'relation' ? (
          <MenuItem glyph="↗" onSelect={() => setPanel({ kind: 'relation' })}>
            {t('property.relationSetup')}
          </MenuItem>
        ) : null}
        {editable && def.type === 'rollup' ? (
          <MenuItem glyph="∑" onSelect={() => setPanel({ kind: 'rollup' })}>
            {t('property.rollupSetup')}
          </MenuItem>
        ) : null}
        {editable && isDateType(def.type) ? (
          <div className="cgw-menu-switch">
            <CgSwitch
              checked={def.date?.includeTime === true}
              label={t('property.includeTime')}
              onCheckedChange={(on) =>
                void actions.updateProperty({ ...def, date: { includeTime: on } })
              }
            />
          </div>
        ) : null}
        {isComputedType(def.type) ? (
          <p className="cgw-picker-note">{t('property.computed')}</p>
        ) : null}
        {isAutomaticType(def.type) ? (
          <p className="cgw-picker-note">{t('property.automatic')}</p>
        ) : null}
        {view ? (
          <>
            <MenuSeparator />
            <MenuItem
              glyph="↑"
              onSelect={() => {
                void actions.updateView(
                  view,
                  withSort(view.config, { propertyId: def.id, direction: 'asc' }),
                );
                onClose();
              }}
            >
              {t('property.sortAsc')}
            </MenuItem>
            <MenuItem
              glyph="↓"
              onSelect={() => {
                void actions.updateView(
                  view,
                  withSort(view.config, { propertyId: def.id, direction: 'desc' }),
                );
                onClose();
              }}
            >
              {t('property.sortDesc')}
            </MenuItem>
            {onFilter ? (
              <MenuItem
                glyph="⏷"
                onSelect={() => {
                  onClose();
                  onFilter(def);
                }}
              >
                {t('property.filter')}
              </MenuItem>
            ) : null}
            {!isTitle ? (
              <MenuItem
                glyph="◌"
                disabled={!editable}
                onSelect={() => {
                  void actions.updateView(view, withHidden(view.config, def.id, true));
                  onClose();
                }}
              >
                {t('property.hide')}
              </MenuItem>
            ) : null}
            {editable ? (
              <>
                <MenuSeparator />
                <MenuItem
                  glyph="⇤"
                  onSelect={() => insert(leftSide)}
                  disabled={isTitle && leftSide === 'before'}
                >
                  {t('property.insertLeft')}
                </MenuItem>
                <MenuItem
                  glyph="⇥"
                  onSelect={() => insert(rightSide)}
                  disabled={isTitle && rightSide === 'before'}
                >
                  {t('property.insertRight')}
                </MenuItem>
                <MenuItem glyph="←" disabled={!canMoveLeft} onSelect={() => move(leftSide)}>
                  {t('property.moveLeft')}
                </MenuItem>
                <MenuItem glyph="→" disabled={!canMoveRight} onSelect={() => move(rightSide)}>
                  {t('property.moveRight')}
                </MenuItem>
              </>
            ) : null}
          </>
        ) : null}
        {editable && !isTitle ? (
          <>
            <MenuSeparator />
            <MenuItem
              glyph="⧉"
              onSelect={() => {
                const copy: PropertyDef = {
                  ...structuredClone(def),
                  id: newPropertyId(),
                  name: t('property.copyName', { name: def.name }),
                };
                delete copy.trashedAt;
                if (copy.relation) copy.relation = { ...copy.relation, reversePropertyId: null };
                void actions.addProperty(
                  copy,
                  view ? { view, anchor: def.id, side: 'after' } : undefined,
                );
                onClose();
              }}
            >
              {t('property.duplicate')}
            </MenuItem>
            <MenuItem
              glyph="🗑"
              danger
              onSelect={() => {
                void actions.deleteProperty(def);
                onClose();
              }}
            >
              {t('property.delete')}
            </MenuItem>
          </>
        ) : null}
        {isTitle ? <p className="cgw-picker-note">{t('property.titleFixed')}</p> : null}
      </MenuList>
    </div>
  );
}

const FORMATS: NumberFormat[] = ['number', 'integer', 'percent', 'currency'];

function NumberSettings({ def, onChange }: { def: PropertyDef; onChange(def: PropertyDef): void }) {
  const { t } = useDbT();
  const config = useMemo(
    () => def.number ?? { format: 'number' as NumberFormat, decimals: null },
    [def.number],
  );
  const write = (next: Partial<NonNullable<PropertyDef['number']>>) =>
    onChange({ ...def, number: { ...config, ...next } });
  return (
    <div className="cgw-setup">
      <fieldset className="cgw-fieldset">
        <legend>{t('property.numberFormat')}</legend>
        {FORMATS.map((f, i) => (
          <label key={f} className="cgw-radio-row">
            <input
              type="radio"
              name={`format-${def.id}`}
              checked={config.format === f}
              data-cg-initial-focus={i === 0 ? '' : undefined}
              onChange={() => write({ format: f })}
            />
            {t(`format.${f}`)}
          </label>
        ))}
      </fieldset>
      <label className="cgw-label">
        {t('property.decimals')}
        <select
          className="cgw-select"
          value={config.decimals === null ? '' : String(config.decimals)}
          onChange={(event) =>
            write({ decimals: event.target.value === '' ? null : Number(event.target.value) })
          }
        >
          <option value="">{t('property.decimalsAuto')}</option>
          {[0, 1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {config.format === 'currency' ? (
        <label className="cgw-label">
          {t('property.currency')}
          <input
            className="cgw-text-input"
            dir="ltr"
            maxLength={3}
            defaultValue={config.currency ?? 'USD'}
            onBlur={(event) => {
              const code = event.target.value.trim().toUpperCase();
              if (/^[A-Z]{3}$/.test(code)) write({ currency: code });
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
