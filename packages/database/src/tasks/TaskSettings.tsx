// Sub-items and dependencies (Phase 17), switched in a view's Properties menu: each by a two-way
// relation of the database to itself, picked from those it has or made new (Parent and Sub-items,
// Blocked by and Blocking), or off; dependencies may also move the rows a row blocks with it.
import { CgCheckBox } from '@cashgear/ui';
import { useId } from 'react';
import type { DatabaseRecord } from '../core';
import { useDatabaseContext } from '../context';
import { selfPairs, switchPair, taskPair, type TaskPair } from './model';
import { useTaskT } from './words';

function PairSwitch({
  database,
  pair,
  label,
  help,
  names,
  newLabel,
}: {
  database: DatabaseRecord;
  pair: TaskPair;
  label: string;
  help: string;
  names: { first: string; second: string };
  newLabel: string;
}) {
  const tt = useTaskT();
  const id = useId();
  const { actions, editable } = useDatabaseContext();
  const current = taskPair(database, pair);
  const shift = current?.first.relation?.shift === true;
  const pairs = selfPairs(database);
  const write = (choice: string | 'new' | null, nextShift = shift) =>
    void actions.updateProperties(switchPair(database, pair, choice, names, nextShift));
  return (
    <div className="cgw-db-task-switch">
      <label className="cgw-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="cgw-select"
        disabled={!editable}
        aria-describedby={`${id}-help`}
        value={current?.first.id ?? ''}
        onChange={(event) => write(event.target.value || null)}
      >
        <option value="">{tt('off')}</option>
        {pairs.flatMap(({ first, second }) =>
          [first, second].map((def) => (
            <option key={def.id} value={def.id}>
              {tt('pair', { name: def.name, reverse: (def === first ? second : first).name })}
            </option>
          )),
        )}
        <option value="new">{newLabel}</option>
      </select>
      <p id={`${id}-help`} className="cgw-picker-note">
        {help}
      </p>
      {pair === 'dependencies' && current ? (
        <CgCheckBox
          label={tt('shift')}
          checked={shift}
          disabled={!editable}
          onCheckedChange={(on) => write(current.first.id, on === true)}
        />
      ) : null}
    </div>
  );
}

export function TaskSettings({ database }: { database: DatabaseRecord }) {
  const tt = useTaskT();
  return (
    <section className="cgw-db-task-settings" aria-label={tt('title')}>
      <h3 className="cgw-panel-title">{tt('title')}</h3>
      <PairSwitch
        database={database}
        pair="subItems"
        label={tt('subItems')}
        help={tt('subItemsHelp')}
        names={{ first: tt('parent'), second: tt('children') }}
        newLabel={tt('newSubItems')}
      />
      <PairSwitch
        database={database}
        pair="dependencies"
        label={tt('dependencies')}
        help={tt('dependenciesHelp')}
        names={{ first: tt('blockedBy'), second: tt('blocking') }}
        newLabel={tt('newDependencies')}
      />
    </section>
  );
}
