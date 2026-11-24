// The rule editor (Phase 15, M15.3): a rule's name, what starts it, the rows it is for (the views'
// own filter editor), and its steps in order (the library's `CgSortableList`: drag a handle, or
// the arrow keys on it). It is checked as the server checks it (`checkAutomation`) before it is
// saved, and a refusal says which part is wrong.
import { CgButton, CgCheckBox, CgSortableList } from '@cashgear/ui';
import { cloneElement, isValidElement, useId, useState, type ReactNode } from 'react';
import {
  AutomationError,
  MAX_MESSAGE,
  MAX_STEPS,
  STEP_KINDS,
  TRIGGER_KINDS,
  checkAutomation,
} from '@cgw/workspace/automations';
import {
  type AutomationRecord,
  type AutomationStep,
  type AutomationTrigger,
  type DatabaseRecord,
  type FilterGroup,
  type PropertyDef,
  type StepKind,
  type StepValue,
  type TriggerKind,
} from '../core';
import { useDatabaseContext } from '../context';
import type { DatabaseAutomations, Person } from '../host';
import { liveProperties, propertyOf } from '../model/properties';
import { FilterEditor } from '../toolbar/FilterEditor';
import {
  buttonProperties,
  dateProperties,
  newStep,
  newTrigger,
  peopleProperties,
  problemKey,
  stepFits,
  weekdayName,
  writable,
} from './model';
import { useAutoT, type AutoT } from './words';

export interface RuleEditorProps {
  database: DatabaseRecord;
  rule: AutomationRecord;
  data: DatabaseAutomations;
  groups: { id: string; name: string }[];
  onSave(rule: AutomationRecord): Promise<void>;
  onDelete?(): void;
  onCancel(): void;
}

const EMPTY_GROUP: FilterGroup = { kind: 'group', op: 'and', children: [] };

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  const id = useId();
  return (
    <div className="cgw-db-auto-field">
      <label className="cgw-label" htmlFor={id}>
        {label}
      </label>
      <span className="cgw-db-auto-control" id={`${id}-wrap`}>
        {/* The control is the child; it takes the id the label names. */}
        {wire(children, id)}
      </span>
      {help ? <p className="cgw-db-auto-note">{help}</p> : null}
    </div>
  );
}

/** The first element child given the label's id (the fields hold one control each). */
function wire(children: ReactNode, id: string): ReactNode {
  return isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children;
}

/** The value a step writes into a property, with what that property's type takes. */
function ValueEditor({
  def,
  value,
  onChange,
  people,
  allowActor,
  allowRow,
  at,
}: {
  def: PropertyDef;
  value: StepValue | undefined;
  onChange(value: StepValue): void;
  people: Person[];
  allowActor: boolean;
  allowRow: boolean;
  at: AutoT;
}) {
  const label = at('set.value');
  const dynamic = value && typeof value === 'object' && 'dynamic' in value ? value.dynamic : null;
  switch (def.type) {
    case 'checkbox':
      return (
        <CgCheckBox
          label={def.name}
          checked={value === true}
          onCheckedChange={(next) => onChange(next === true)}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          className="cgw-text-input"
          aria-label={label}
          defaultValue={typeof value === 'number' ? value : ''}
          onBlur={(event) =>
            onChange(event.target.value === '' ? null : Number(event.target.value))
          }
        />
      );
    case 'select':
    case 'status':
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{at('set.clear')}</option>
          {(def.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'multiSelect': {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <span className="cgw-db-auto-choices">
          {(def.options ?? []).map((o) => (
            <CgCheckBox
              key={o.id}
              label={o.name}
              checked={chosen.includes(o.id)}
              onCheckedChange={(on) =>
                onChange(on ? [...chosen, o.id] : chosen.filter((id) => id !== o.id))
              }
            />
          ))}
        </span>
      );
    }
    case 'date': {
      const days = dynamic === 'now' ? ((value as { days?: number }).days ?? 0) : 0;
      return (
        <span className="cgw-db-auto-choices">
          <select
            className="cgw-select"
            aria-label={label}
            value={dynamic === 'now' ? 'now' : 'date'}
            onChange={(event) => onChange(event.target.value === 'now' ? { dynamic: 'now' } : null)}
          >
            <option value="now">{at('set.now')}</option>
            <option value="date">{at('set.clear')}</option>
          </select>
          {dynamic === 'now' ? (
            <input
              type="number"
              className="cgw-text-input cgw-db-auto-short"
              aria-label={at('set.nowDays')}
              defaultValue={days}
              step={1}
              onBlur={(event) => {
                const n = Math.trunc(Number(event.target.value) || 0);
                onChange(n ? { dynamic: 'now', days: n } : { dynamic: 'now' });
              }}
            />
          ) : null}
        </span>
      );
    }
    case 'person': {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={dynamic === 'actor' ? 'actor' : (chosen[0] ?? '')}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === 'actor' ? { dynamic: 'actor' } : next ? [next] : null);
          }}
        >
          <option value="">{at('set.clear')}</option>
          {allowActor ? <option value="actor">{at('set.actor')}</option> : null}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    }
    case 'relation':
    case 'files':
      return (
        <select
          className="cgw-select"
          aria-label={label}
          value={dynamic === 'row' ? 'row' : ''}
          onChange={(event) => onChange(event.target.value === 'row' ? { dynamic: 'row' } : null)}
        >
          <option value="">{at('set.clear')}</option>
          {allowRow && def.type === 'relation' ? (
            <option value="row">{at('set.thisRow')}</option>
          ) : null}
        </select>
      );
    default:
      return (
        <input
          className="cgw-text-input"
          aria-label={label}
          dir="auto"
          defaultValue={typeof value === 'string' ? value : ''}
          onBlur={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      );
  }
}

/** The values a step writes: a property and its value per line. */
function ValuesEditor({
  database,
  values,
  onChange,
  people,
  allowActor,
  allowRow,
  at,
}: {
  database: DatabaseRecord;
  values: Record<string, StepValue>;
  onChange(values: Record<string, StepValue>): void;
  people: Person[];
  allowActor: boolean;
  allowRow: boolean;
  at: AutoT;
}) {
  const choices = writable(database).filter((p) => !(p.id in values));
  return (
    <div className="cgw-db-auto-values">
      {Object.entries(values).map(([id, value]) => {
        const def = propertyOf(database, id);
        if (!def) return null;
        return (
          <div key={id} className="cgw-db-auto-value">
            <span className="cgw-db-auto-value-name" dir="auto">
              {def.name}
            </span>
            <ValueEditor
              def={def}
              value={value}
              onChange={(next) => onChange({ ...values, [id]: next })}
              people={people}
              allowActor={allowActor}
              allowRow={allowRow}
              at={at}
            />
            <button
              type="button"
              className="cgw-icon-button"
              aria-label={at('set.remove', { name: def.name })}
              onClick={() => {
                const { [id]: _, ...rest } = values;
                void _;
                onChange(rest);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
      {choices.length ? (
        <select
          className="cgw-select"
          aria-label={at('set.add')}
          value=""
          onChange={(event) => {
            const def = propertyOf(database, event.target.value);
            if (!def) return;
            onChange({
              ...values,
              [def.id]: def.type === 'checkbox' ? true : def.type === 'title' ? '' : null,
            });
          }}
        >
          <option value="">{at('set.add')}</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function TriggerEditor({
  database,
  trigger,
  onChange,
  at,
  locale,
}: {
  database: DatabaseRecord;
  trigger: AutomationTrigger;
  onChange(trigger: AutomationTrigger): void;
  at: AutoT;
  locale: string;
}) {
  const kind = (
    <Field label={at('trigger')}>
      <select
        className="cgw-select"
        value={trigger.kind}
        onChange={(event) => onChange(newTrigger(event.target.value as TriggerKind, database))}
      >
        {TRIGGER_KINDS.map((k) => (
          <option key={k} value={k}>
            {at(`triggers.${k}`)}
          </option>
        ))}
      </select>
    </Field>
  );
  switch (trigger.kind) {
    case 'rowAdded':
      return kind;
    case 'propertyChanged': {
      const def = trigger.propertyId ? propertyOf(database, trigger.propertyId) : undefined;
      const options = def?.type === 'select' || def?.type === 'status' ? (def.options ?? []) : null;
      return (
        <>
          {kind}
          <Field label={at('trigger_.property')}>
            <select
              className="cgw-select"
              value={trigger.propertyId ?? ''}
              onChange={(event) =>
                onChange({
                  ...trigger,
                  propertyId: event.target.value || null,
                  from: null,
                  to: null,
                })
              }
            >
              <option value="">{at('trigger_.anyProperty')}</option>
              {writable(database).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {options ? (
            <Field label={at('trigger_.to')}>
              <select
                className="cgw-select"
                value={typeof trigger.to?.value === 'string' ? trigger.to.value : ''}
                onChange={(event) =>
                  onChange({
                    ...trigger,
                    to: event.target.value ? { operator: 'is', value: event.target.value } : null,
                  })
                }
              >
                <option value="">{at('trigger_.anyValue')}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : def?.type === 'checkbox' ? (
            <Field label={at('trigger_.to')}>
              <select
                className="cgw-select"
                value={trigger.to?.value === true ? 'yes' : trigger.to?.value === false ? 'no' : ''}
                onChange={(event) =>
                  onChange({
                    ...trigger,
                    to: event.target.value
                      ? { operator: 'is', value: event.target.value === 'yes' }
                      : null,
                  })
                }
              >
                <option value="">{at('trigger_.anyValue')}</option>
                <option value="yes">✓</option>
                <option value="no">✗</option>
              </select>
            </Field>
          ) : null}
        </>
      );
    }
    case 'date': {
      const dates = dateProperties(database);
      if (!dates.length)
        return (
          <>
            {kind}
            <p>{at('trigger_.noDate')}</p>
          </>
        );
      const minutes = trigger.offsetMinutes;
      const unit = minutes % 1440 === 0 && minutes ? 1440 : minutes % 60 === 0 && minutes ? 60 : 1;
      const side = minutes < 0 ? 'before' : minutes > 0 ? 'after' : 'at';
      const set = (amount: number, nextUnit: number, nextSide: string) =>
        onChange({
          ...trigger,
          offsetMinutes:
            nextSide === 'at' ? 0 : Math.abs(amount) * nextUnit * (nextSide === 'before' ? -1 : 1),
        });
      return (
        <>
          {kind}
          <Field label={at('trigger_.dateProperty')}>
            <select
              className="cgw-select"
              value={trigger.propertyId}
              onChange={(event) => onChange({ ...trigger, propertyId: event.target.value })}
            >
              {dates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={at('trigger_.offset')}>
            <select
              className="cgw-select"
              value={side}
              onChange={(event) => set(Math.abs(minutes / unit) || 1, unit, event.target.value)}
            >
              <option value="at">{at('trigger_.offsetAt')}</option>
              <option value="before">{at('trigger_.offsetBefore')}</option>
              <option value="after">{at('trigger_.offsetAfter')}</option>
            </select>
          </Field>
          {side !== 'at' ? (
            <div className="cgw-db-auto-row">
              <Field label={at('trigger_.amount')}>
                <input
                  type="number"
                  min={1}
                  className="cgw-text-input cgw-db-auto-short"
                  defaultValue={Math.abs(minutes / unit)}
                  onBlur={(event) =>
                    set(Math.max(1, Math.trunc(Number(event.target.value) || 1)), unit, side)
                  }
                />
              </Field>
              <Field label={at('trigger_.unit')}>
                <select
                  className="cgw-select"
                  value={unit}
                  onChange={(event) =>
                    set(Math.abs(minutes / unit) || 1, Number(event.target.value), side)
                  }
                >
                  <option value={1}>{at('trigger_.minutes')}</option>
                  <option value={60}>{at('trigger_.hours')}</option>
                  <option value={1440}>{at('trigger_.days')}</option>
                </select>
              </Field>
            </div>
          ) : null}
          <Field label={at('trigger_.at')}>
            <input
              type="time"
              className="cgw-text-input cgw-db-auto-short"
              value={trigger.at ?? '09:00'}
              onChange={(event) => onChange({ ...trigger, at: event.target.value || null })}
            />
          </Field>
        </>
      );
    }
    case 'schedule':
      return (
        <>
          {kind}
          <Field label={at('trigger_.every')}>
            <select
              className="cgw-select"
              value={trigger.every}
              onChange={(event) => {
                const every = event.target.value as 'day' | 'week' | 'month';
                onChange({
                  ...trigger,
                  every,
                  weekday: every === 'week' ? (trigger.weekday ?? 1) : null,
                  day: every === 'month' ? (trigger.day ?? 1) : null,
                });
              }}
            >
              <option value="day">{at('trigger_.everyDay')}</option>
              <option value="week">{at('trigger_.everyWeek')}</option>
              <option value="month">{at('trigger_.everyMonth')}</option>
            </select>
          </Field>
          {trigger.every === 'week' ? (
            <Field label={at('trigger_.weekday')}>
              <select
                className="cgw-select"
                value={trigger.weekday ?? 1}
                onChange={(event) => onChange({ ...trigger, weekday: Number(event.target.value) })}
              >
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>
                    {weekdayName(d, locale)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {trigger.every === 'month' ? (
            <Field label={at('trigger_.monthDay')} help={at('trigger_.monthDayHelp')}>
              <input
                type="number"
                min={1}
                max={31}
                className="cgw-text-input cgw-db-auto-short"
                defaultValue={trigger.day ?? 1}
                onBlur={(event) =>
                  onChange({
                    ...trigger,
                    day: Math.min(31, Math.max(1, Math.trunc(Number(event.target.value) || 1))),
                  })
                }
              />
            </Field>
          ) : null}
          <Field label={at('trigger_.time')}>
            <input
              type="time"
              className="cgw-text-input cgw-db-auto-short"
              value={trigger.at}
              onChange={(event) => onChange({ ...trigger, at: event.target.value || '09:00' })}
            />
          </Field>
        </>
      );
    case 'button': {
      const buttons = buttonProperties(database);
      if (!buttons.length)
        return (
          <>
            {kind}
            <p>{at('trigger_.noButton')}</p>
          </>
        );
      return (
        <>
          {kind}
          <Field label={at('trigger_.buttonProperty')}>
            <select
              className="cgw-select"
              value={trigger.propertyId}
              onChange={(event) => onChange({ ...trigger, propertyId: event.target.value })}
            >
              {buttons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      );
    }
  }
}

function StepBody({
  database,
  step,
  rowTrigger,
  data,
  groups,
  onChange,
  at,
}: {
  database: DatabaseRecord;
  step: AutomationStep;
  rowTrigger: boolean;
  data: DatabaseAutomations;
  groups: { id: string; name: string }[];
  onChange(step: AutomationStep): void;
  at: AutoT;
}) {
  const { host } = useDatabaseContext();
  const people = host.people();
  switch (step.kind) {
    case 'set':
      return (
        <ValuesEditor
          database={database}
          values={step.values}
          onChange={(values) => onChange({ ...step, values })}
          people={people}
          allowActor={rowTrigger}
          allowRow={false}
          at={at}
        />
      );
    case 'addRow': {
      const target = host.database(step.databaseId);
      const templates = host.rowTemplates(step.databaseId);
      return (
        <>
          <Field label={at('addRow.database')}>
            <select
              className="cgw-select"
              value={step.databaseId}
              onChange={(event) =>
                onChange({ ...step, databaseId: event.target.value, templateId: null, values: {} })
              }
            >
              {host.databases().map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || d.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label={at('addRow.template')}>
            <select
              className="cgw-select"
              value={step.templateId ?? ''}
              onChange={(event) => onChange({ ...step, templateId: event.target.value || null })}
            >
              <option value="">{at('addRow.noTemplate')}</option>
              {templates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title || r.id}
                </option>
              ))}
            </select>
          </Field>
          {target ? (
            <ValuesEditor
              database={target}
              values={step.values}
              onChange={(values) => onChange({ ...step, values })}
              people={people}
              allowActor={rowTrigger}
              allowRow={rowTrigger}
              at={at}
            />
          ) : (
            <p className="cgw-db-auto-note">{at('addRow.notHeld')}</p>
          )}
        </>
      );
    }
    case 'notify': {
      const toggle = (list: string[], id: string, on: boolean) =>
        on ? [...list, id] : list.filter((x) => x !== id);
      return (
        <>
          <fieldset className="cgw-db-auto-set">
            <legend>{at('notify.people')}</legend>
            {people.map((p) => (
              <CgCheckBox
                key={p.id}
                label={p.name}
                checked={step.people.includes(p.id)}
                onCheckedChange={(on) =>
                  onChange({ ...step, people: toggle(step.people, p.id, on === true) })
                }
              />
            ))}
          </fieldset>
          {groups.length ? (
            <fieldset className="cgw-db-auto-set">
              <legend>{at('notify.groups')}</legend>
              {groups.map((g) => (
                <CgCheckBox
                  key={g.id}
                  label={g.name}
                  checked={step.groups.includes(g.id)}
                  onCheckedChange={(on) =>
                    onChange({ ...step, groups: toggle(step.groups, g.id, on === true) })
                  }
                />
              ))}
            </fieldset>
          ) : null}
          {rowTrigger && peopleProperties(database).length ? (
            <fieldset className="cgw-db-auto-set">
              <legend>{at('notify.properties')}</legend>
              {peopleProperties(database).map((p) => (
                <CgCheckBox
                  key={p.id}
                  label={p.name}
                  checked={step.personProperties.includes(p.id)}
                  onCheckedChange={(on) =>
                    onChange({
                      ...step,
                      personProperties: toggle(step.personProperties, p.id, on === true),
                    })
                  }
                />
              ))}
            </fieldset>
          ) : null}
          <Field label={at('notify.message')} help={at('notify.messageHelp')}>
            <textarea
              className="cgw-text-input cgw-db-auto-message"
              dir="auto"
              maxLength={MAX_MESSAGE}
              value={step.message}
              onChange={(event) => onChange({ ...step, message: event.target.value })}
            />
          </Field>
        </>
      );
    }
    case 'webhook':
      if (!data.canCallWebhooks || !data.webhooks.length)
        return <p className="cgw-db-auto-note">{at('webhook.none')}</p>;
      return (
        <>
          <Field label={at('webhook.webhook')}>
            <select
              className="cgw-select"
              value={step.webhookId}
              onChange={(event) => onChange({ ...step, webhookId: event.target.value })}
            >
              <option value="">{at('webhook.pick')}</option>
              {data.webhooks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {rowTrigger ? (
            <fieldset className="cgw-db-auto-set">
              <legend>{at('webhook.properties')}</legend>
              {liveProperties(database)
                .filter((p) => p.type !== 'button')
                .map((p) => (
                  <CgCheckBox
                    key={p.id}
                    label={p.name}
                    checked={step.properties.includes(p.id)}
                    onCheckedChange={(on) =>
                      onChange({
                        ...step,
                        properties: on
                          ? [...step.properties, p.id]
                          : step.properties.filter((x) => x !== p.id),
                      })
                    }
                  />
                ))}
            </fieldset>
          ) : null}
        </>
      );
  }
}

/** Steps keep a key of their own while the rule is edited (their place can change). */
type Keyed = { key: string; step: AutomationStep };

export function RuleEditor({
  database,
  rule,
  data,
  groups,
  onSave,
  onDelete,
  onCancel,
}: RuleEditorProps) {
  const { t: at, locale } = useAutoT();
  const { host } = useDatabaseContext();
  const [name, setName] = useState(rule.name);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [trigger, setTrigger] = useState<AutomationTrigger>(rule.trigger);
  const [conditions, setConditions] = useState<FilterGroup | null>(rule.conditions);
  const [steps, setSteps] = useState<Keyed[]>(() =>
    rule.steps.map((step, i) => ({ key: `s${i}`, step })),
  );
  const [nextKey, setNextKey] = useState(rule.steps.length);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rowTrigger = trigger.kind !== 'schedule';
  const canManage = data.canManage;

  const draft = (): AutomationRecord => ({
    ...rule,
    name: name.trim(),
    enabled,
    trigger,
    conditions: rowTrigger ? conditions : null,
    steps: steps.map((s) => s.step),
  });

  const save = async () => {
    setProblem(null);
    let checked: AutomationRecord;
    try {
      checked = checkAutomation(draft(), database, (id) => host.database(id));
    } catch (error) {
      if (error instanceof AutomationError) return setProblem(at(problemKey(error.reason)));
      throw error;
    }
    setSaving(true);
    try {
      await onSave(checked);
    } finally {
      setSaving(false);
    }
  };

  const stepName = (kind: StepKind) => at(`stepKinds.${kind}`);

  return (
    <form
      className="cgw-db-auto-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label={at('name')}>
        <input
          className="cgw-text-input"
          dir="auto"
          value={name}
          maxLength={200}
          placeholder={at('untitled')}
          disabled={!canManage}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <CgCheckBox
        label={at('on')}
        checked={enabled}
        disabled={!canManage}
        onCheckedChange={(on) => setEnabled(on === true)}
      />
      <fieldset className="cgw-db-auto-part" disabled={!canManage}>
        <legend className="cgw-panel-title">{at('trigger')}</legend>
        <TriggerEditor
          database={database}
          trigger={trigger}
          locale={locale}
          at={at}
          onChange={(next) => {
            setTrigger(next);
            if (next.kind === 'schedule')
              setSteps((list) => list.filter((s) => stepFits(s.step.kind, next)));
          }}
        />
      </fieldset>
      {rowTrigger ? (
        <section className="cgw-db-auto-part" aria-label={at('conditions')}>
          <h3 className="cgw-panel-title">{at('conditions')}</h3>
          {conditions ? (
            <>
              <FilterEditor
                database={database}
                filter={conditions}
                editable={canManage}
                onChange={(next) => setConditions(next)}
              />
              {canManage ? (
                <CgButton appearance="ghost" size="small" onClick={() => setConditions(null)}>
                  {at('conditionsClear')}
                </CgButton>
              ) : null}
            </>
          ) : (
            <>
              <p className="cgw-db-auto-note">{at('conditionsNone')}</p>
              {canManage ? (
                <CgButton
                  appearance="outline"
                  size="small"
                  onClick={() => setConditions(EMPTY_GROUP)}
                >
                  {at('conditionsAdd')}
                </CgButton>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      <section className="cgw-db-auto-part" aria-label={at('stepsLabel')}>
        <h3 className="cgw-panel-title">{at('steps')}</h3>
        <CgSortableList
          className="cgw-db-auto-steps"
          label={at('stepsLabel')}
          items={steps}
          getKey={(item) => item.key}
          disabled={!canManage}
          handleLabel={(_, index) => at('stepDrag', { number: index + 1 })}
          onMove={(key, to) =>
            setSteps((list) => {
              const from = list.findIndex((s) => s.key === key);
              const next = [...list];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            })
          }
          renderItem={(item, { index }) => (
            <fieldset className="cgw-db-auto-step" disabled={!canManage}>
              <legend>
                {at('stepNumber', { number: index + 1 })}: {stepName(item.step.kind)}
              </legend>
              <StepBody
                database={database}
                step={item.step}
                rowTrigger={rowTrigger}
                data={data}
                groups={groups}
                at={at}
                onChange={(step) =>
                  setSteps((list) => list.map((s) => (s.key === item.key ? { ...s, step } : s)))
                }
              />
              {rowTrigger ? (
                item.step.when ? (
                  <div className="cgw-db-auto-when">
                    <p className="cgw-db-auto-note">{at('stepWhen')}</p>
                    <FilterEditor
                      database={database}
                      filter={item.step.when}
                      editable={canManage}
                      onChange={(when) =>
                        setSteps((list) =>
                          list.map((s) =>
                            s.key === item.key ? { ...s, step: { ...s.step, when } } : s,
                          ),
                        )
                      }
                    />
                  </div>
                ) : canManage ? (
                  <CgButton
                    appearance="ghost"
                    size="small"
                    onClick={() =>
                      setSteps((list) =>
                        list.map((s) =>
                          s.key === item.key ? { ...s, step: { ...s.step, when: EMPTY_GROUP } } : s,
                        ),
                      )
                    }
                  >
                    {at('stepWhenAdd')}
                  </CgButton>
                ) : null
              ) : null}
              {canManage && steps.length > 1 ? (
                <CgButton
                  appearance="ghost"
                  size="small"
                  onClick={() => setSteps((list) => list.filter((s) => s.key !== item.key))}
                >
                  {at('stepRemove', { number: index + 1 })}
                </CgButton>
              ) : null}
            </fieldset>
          )}
        />
        {canManage && steps.length < MAX_STEPS ? (
          <select
            className="cgw-select"
            aria-label={at('addStep')}
            value=""
            onChange={(event) => {
              const kind = event.target.value as StepKind;
              if (!kind) return;
              setSteps((list) => [...list, { key: `s${nextKey}`, step: newStep(kind, database) }]);
              setNextKey((n) => n + 1);
            }}
          >
            <option value="">{at('addStep')}</option>
            {STEP_KINDS.filter((k) => stepFits(k, trigger))
              .filter((k) => k !== 'webhook' || data.canCallWebhooks)
              .map((k) => (
                <option key={k} value={k}>
                  {stepName(k)}
                </option>
              ))}
          </select>
        ) : null}
      </section>
      {problem ? (
        <p role="alert" className="cgw-db-auto-problem">
          {problem}
        </p>
      ) : null}
      <div className="cgw-db-auto-actions">
        {canManage ? (
          <CgButton intent="primary" type="submit" disabled={saving}>
            {saving ? at('saving') : at('save')}
          </CgButton>
        ) : null}
        <CgButton appearance="outline" onClick={onCancel}>
          {at('cancel')}
        </CgButton>
        {canManage && onDelete ? (
          <CgButton appearance="ghost" intent="danger" onClick={onDelete}>
            {at('delete')}
          </CgButton>
        ) : null}
      </div>
    </form>
  );
}

/** Used by the dialog: a step's name, for the run log. */
export const stepNameOf = (at: AutoT) => (kind: string) =>
  (STEP_KINDS as readonly string[]).includes(kind) ? at(`stepKinds.${kind as StepKind}`) : kind;
