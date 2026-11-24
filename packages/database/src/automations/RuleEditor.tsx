// The rule editor (Phase 15, M15.3): a rule's name, what starts it, the rows it is for (the views'
// own filter editor), and its steps in order (the library's `CgSortableList`: drag a handle, or
// the arrow keys on it). It is checked as the server checks it (`checkAutomation`) before it is
// saved, and a refusal says which part is wrong.
import { CgButton, CgCheckBox } from '@cashgear/ui';
import { useState } from 'react';
import {
  AutomationError,
  STEP_KINDS,
  TRIGGER_KINDS,
  allSteps,
  checkAutomation,
} from '@cgw/workspace/automations';
import {
  type AutomationRecord,
  type AutomationStep,
  type AutomationTrigger,
  type DatabaseRecord,
  type FilterGroup,
  type StepKind,
  type TriggerKind,
} from '../core';
import { useDatabaseContext, useViews } from '../context';
import type { DatabaseAutomations } from '../host';
import { propertyOf } from '../model/properties';
import { FilterEditor } from '../toolbar/FilterEditor';
import {
  buttonProperties,
  dateProperties,
  formViews,
  newTrigger,
  problemKey,
  stepFits,
  weekdayName,
  writable,
} from './model';
import { Field, StepList } from './StepList';
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
  const { host } = useDatabaseContext();
  const forms = formViews(useViews(host, database.id));
  const kind = (
    <Field label={at('trigger')}>
      <select
        className="cgw-select"
        value={trigger.kind}
        onChange={(event) =>
          onChange(newTrigger(event.target.value as TriggerKind, database, forms))
        }
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
    case 'formAnswered':
      if (!forms.length)
        return (
          <>
            {kind}
            <p>{at('trigger_.noForm')}</p>
          </>
        );
      return (
        <>
          {kind}
          <Field label={at('trigger_.form')}>
            <select
              className="cgw-select"
              value={trigger.viewId}
              onChange={(event) => onChange({ ...trigger, viewId: event.target.value })}
            >
              {/* A form deleted since stays shown until another is chosen. */}
              {forms.some((f) => f.id === trigger.viewId) ? null : (
                <option value={trigger.viewId}>{at('summary.missingForm')}</option>
              )}
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      );
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
  const [steps, setSteps] = useState<AutomationStep[]>(rule.steps);
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
    steps,
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
              setSteps((list) => list.filter((s) => stepFits(s.kind, next)));
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
        <StepList
          steps={steps}
          onChange={setSteps}
          level={1}
          answered={false}
          label={at('stepsLabel')}
          ctx={{
            database,
            trigger,
            rowTrigger,
            data,
            groups,
            canManage,
            at,
            total: [...allSteps(steps)].length,
          }}
        />
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
