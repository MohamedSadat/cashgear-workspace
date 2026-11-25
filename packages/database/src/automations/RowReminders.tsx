// A row's "Remind me" (Phase 17, M17.2): under the row's properties, for whoever can read it, a
// choice for each of its date properties of when to be reminded (at the time, or 15 minutes, an
// hour, a day or a week before), only for this person, sent by the server to their inbox and by
// mail as they chose. Read when opened and set online only; offline it says so.
import type { Id } from '@cgw/workspace';
import { useEffect, useId, useState } from 'react';
import type { DatabaseRecord } from '../core';
import type { AutomationsHost, RowReminder } from '../host';
import { liveProperties } from '../model/properties';
import { useAutoT, type AutoKey } from './words';
import './automations.css';

const BEFORES = [0, 15, 60, 1440, 10080];

export function RowReminders({
  automations,
  database,
  rowId,
}: {
  automations: AutomationsHost;
  database: DatabaseRecord;
  rowId: Id;
}) {
  const { t: at } = useAutoT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<RowReminder[] | null>(null);
  const [state, setState] = useState<'idle' | 'failed'>('idle');
  const reminders = automations.reminders;
  const dates = liveProperties(database).filter((p) => p.type === 'date');

  useEffect(() => {
    if (!open || !reminders || !automations.online()) return;
    let live = true;
    reminders.list(database.id, rowId).then(
      (answer) => live && setList(answer),
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [open, reminders, automations, database.id, rowId]);

  if (!reminders || !dates.length) return null;

  const choose = async (propertyId: string, value: string) => {
    setState('idle');
    try {
      setList(
        value === ''
          ? await reminders.remove(database.id, rowId, propertyId)
          : await reminders.set(database.id, rowId, propertyId, Number(value)),
      );
    } catch {
      setState('failed');
    }
  };

  return (
    <details
      className="cgw-db-auto-row-runs cgw-db-remind"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{at('remind.title')}</summary>
      {open ? (
        !automations.online() ? (
          <p className="cgw-db-auto-note">{at('remind.offline')}</p>
        ) : (
          <>
            {dates.map((def) => {
              const current = list?.find((r) => r.propertyId === def.id);
              return (
                <div key={def.id} className="cgw-db-remind-line">
                  <label className="cgw-label" htmlFor={`${id}-${def.id}`}>
                    {at('remind.of', { property: def.name })}
                  </label>
                  <select
                    id={`${id}-${def.id}`}
                    className="cgw-select"
                    disabled={!list}
                    value={current ? String(current.beforeMinutes) : ''}
                    onChange={(event) => void choose(def.id, event.target.value)}
                  >
                    <option value="">{at('remind.off')}</option>
                    {BEFORES.map((b) => (
                      <option key={b} value={b}>
                        {at(`remind.before${b}` as AutoKey)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <p className="cgw-db-auto-note">{at('remind.help')}</p>
            {state === 'failed' ? (
              <p role="alert" className="cgw-db-auto-problem">
                {at('remind.failed')}
              </p>
            ) : null}
          </>
        )
      ) : null}
    </details>
  );
}
