// A button property's settings in its menu (Phase 15): the words on it, how many automations it
// starts, and "Add an automation for this button", which opens the automations on a new rule.
import { CgButton } from '@cashgear/ui';
import { useEffect, useState } from 'react';
import type { DatabaseRecord, PropertyDef } from '../core';
import { useDatabaseContext, useHost } from '../context';
import { openAutomations } from './open';
import { useAutoT } from './words';

export function ButtonSettings({
  def,
  database,
  onChange,
  onClose,
}: {
  def: PropertyDef;
  database: DatabaseRecord;
  onChange(def: PropertyDef): void;
  onClose(): void;
}) {
  const { t: at } = useAutoT();
  const { host } = useDatabaseContext();
  const automations = useHost(host, () => host.automations);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!automations?.online()) return;
    let live = true;
    automations.list(database.id).then(
      (data) => {
        if (!live) return;
        setCount(
          data.automations.filter(
            ({ rule }) => rule.trigger.kind === 'button' && rule.trigger.propertyId === def.id,
          ).length,
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [automations, database.id, def.id]);

  return (
    <div className="cgw-setup">
      <label className="cgw-label" htmlFor={`cgw-button-${def.id}`}>
        {at('buttonText')}
      </label>
      <input
        id={`cgw-button-${def.id}`}
        className="cgw-text-input"
        data-cg-initial-focus=""
        dir="auto"
        maxLength={200}
        defaultValue={def.button?.label ?? ''}
        placeholder={def.name}
        onBlur={(event) => {
          const label = event.target.value.trim() || null;
          if (label !== (def.button?.label ?? null)) onChange({ ...def, button: { label } });
        }}
      />
      {count !== null ? (
        <p className="cgw-picker-note">{count ? at('buttonRules', { count }) : at('buttonNone')}</p>
      ) : null}
      {automations ? (
        <CgButton
          appearance="outline"
          size="small"
          onClick={() => {
            onClose();
            openAutomations(database.id, { kind: 'button', propertyId: def.id });
          }}
        >
          {at('buttonAutomation')}
        </CgButton>
      ) : null}
    </div>
  );
}
