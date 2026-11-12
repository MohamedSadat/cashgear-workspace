// A relation's settings (the database it points into, and whether the other side shows it too,
// under what name) and a rollup's (which relation, which property of the related rows, and what
// to calculate). Saving writes the property, and for a two-way relation its reverse property in
// the related database as well.
import { CgButton, CgSwitch } from '@cashgear/ui';
import { useId, useState } from 'react';
import {
  newPropertyId,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyType,
  type RollupFunction,
} from '../core';
import type { DatabaseHost } from '../host';
import { useDbT } from '../i18n';
import { isDateType, liveProperties } from '../model/properties';

export interface RelationSave {
  def: PropertyDef;
  /** The property kept in step on the other side, when the relation is two-way. */
  reverse: { databaseId: string; def: PropertyDef } | null;
}

export function RelationSetup({
  host,
  database,
  def,
  onSave,
}: {
  host: DatabaseHost;
  database: DatabaseRecord;
  def: PropertyDef;
  onSave(save: RelationSave): void;
}) {
  const { t } = useDbT();
  const id = useId();
  const current = def.type === 'relation' ? def.relation : undefined;
  const [target, setTarget] = useState(current?.databaseId || '');
  const [twoWay, setTwoWay] = useState(Boolean(current?.reversePropertyId) || !current);
  const thisTitle = host.pageTitle(database.id) || t('untitledDatabase');
  const existingReverse =
    current?.reversePropertyId && target
      ? host.database(target)?.properties.find((p) => p.id === current.reversePropertyId)
      : undefined;
  const [reverseName, setReverseName] = useState(
    existingReverse?.name ?? t('relation.reverseDefault', { name: thisTitle }),
  );
  const databases = host.databases();

  const save = () => {
    if (!target) return;
    const reverseId = twoWay ? (current?.reversePropertyId ?? newPropertyId()) : null;
    const next: PropertyDef = {
      id: def.id,
      name: def.name,
      type: 'relation',
      relation: { databaseId: target, reversePropertyId: reverseId },
      ...(def.trashedAt !== undefined ? { trashedAt: def.trashedAt } : {}),
    };
    const reverse =
      reverseId === null
        ? null
        : {
            databaseId: target,
            def: {
              ...(existingReverse ?? {}),
              id: reverseId,
              name: reverseName.trim() || t('relation.reverseDefault', { name: thisTitle }),
              type: 'relation' as PropertyType,
              relation: { databaseId: database.id, reversePropertyId: def.id },
            },
          };
    onSave({ def: next, reverse });
  };

  return (
    <div className="cgw-setup">
      <label className="cgw-label" htmlFor={`${id}-db`}>
        {t('relation.database')}
      </label>
      <select
        id={`${id}-db`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      >
        <option value="">{t('relation.pickDatabase')}</option>
        {databases.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id === database.id
              ? t('relation.thisDatabase', { name: d.title || t('untitledDatabase') })
              : d.title || t('untitledDatabase')}
          </option>
        ))}
      </select>
      <CgSwitch
        checked={twoWay}
        label={t('relation.reverse')}
        onCheckedChange={(on) => setTwoWay(on)}
      />
      {twoWay ? (
        <>
          <label className="cgw-label" htmlFor={`${id}-name`}>
            {t('relation.reverseName')}
          </label>
          <input
            id={`${id}-name`}
            className="cgw-text-input"
            dir="auto"
            value={reverseName}
            onChange={(event) => setReverseName(event.target.value)}
          />
        </>
      ) : null}
      {!target ? <p className="cgw-picker-note">{t('relation.noTarget')}</p> : null}
      <div className="cgw-panel-actions">
        <CgButton intent="primary" size="small" disabled={!target} onClick={save}>
          {t('done')}
        </CgButton>
      </div>
    </div>
  );
}

const ALWAYS: RollupFunction[] = [
  'count',
  'countValues',
  'countUnique',
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'showOriginal',
];

/** The functions that make sense for a related property's type. */
export function rollupFunctionsFor(type: PropertyType | undefined): RollupFunction[] {
  if (type === 'number' || type === 'formula' || type === 'rollup')
    return [...ALWAYS, 'sum', 'average', 'median', 'min', 'max', 'range'];
  if (type && isDateType(type)) return [...ALWAYS, 'earliest', 'latest', 'range'];
  if (type === 'checkbox') return [...ALWAYS, 'checked', 'unchecked', 'percentChecked'];
  return ALWAYS;
}

export function RollupSetup({
  host,
  database,
  def,
  onSave,
}: {
  host: DatabaseHost;
  database: DatabaseRecord;
  def: PropertyDef;
  onSave(def: PropertyDef): void;
}) {
  const { t } = useDbT();
  const id = useId();
  const relations = liveProperties(database).filter((p) => p.type === 'relation');
  const [relationId, setRelationId] = useState(
    def.rollup?.relationPropertyId ?? relations[0]?.id ?? '',
  );
  const relation = relations.find((p) => p.id === relationId);
  const related = relation?.relation ? host.database(relation.relation.databaseId) : null;
  const targets = related ? liveProperties(related) : [];
  const [targetId, setTargetId] = useState(def.rollup?.targetPropertyId ?? '');
  const target = targets.find((p) => p.id === targetId);
  const fns = rollupFunctionsFor(target?.type);
  const [fn, setFn] = useState<RollupFunction>(def.rollup?.fn ?? 'count');
  const chosenFn = fns.includes(fn) ? fn : 'count';

  if (!relations.length) return <p className="cgw-picker-note">{t('rollup.noRelation')}</p>;

  return (
    <div className="cgw-setup">
      <label className="cgw-label" htmlFor={`${id}-rel`}>
        {t('rollup.relation')}
      </label>
      <select
        id={`${id}-rel`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={relationId}
        onChange={(event) => {
          setRelationId(event.target.value);
          setTargetId('');
        }}
      >
        {relations.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-prop`}>
        {t('rollup.property')}
      </label>
      <select
        id={`${id}-prop`}
        className="cgw-select"
        value={targetId}
        onChange={(event) => setTargetId(event.target.value)}
      >
        <option value="">{t('rollup.pick')}</option>
        {targets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-fn`}>
        {t('rollup.fn')}
      </label>
      <select
        id={`${id}-fn`}
        className="cgw-select"
        value={chosenFn}
        onChange={(event) => setFn(event.target.value as RollupFunction)}
      >
        {fns.map((f) => (
          <option key={f} value={f}>
            {t(`rollup.fns.${f}`)}
          </option>
        ))}
      </select>
      <div className="cgw-panel-actions">
        <CgButton
          intent="primary"
          size="small"
          disabled={!relationId || !targetId}
          onClick={() =>
            onSave({
              id: def.id,
              name: def.name,
              type: 'rollup',
              rollup: { relationPropertyId: relationId, targetPropertyId: targetId, fn: chosenFn },
              ...(def.trashedAt !== undefined ? { trashedAt: def.trashedAt } : {}),
            })
          }
        >
          {t('done')}
        </CgButton>
      </div>
    </div>
  );
}
