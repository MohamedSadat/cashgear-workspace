// A rule's steps as the editor shows them (Phase 15; Phase 17 nests them): a list in order (the
// library's `CgSortableList`: drag a handle, or the arrow keys on it), each step's settings, its
// own conditions, and, for a branch or an approval, the lists of steps it holds, three levels at
// most. The rule's own list is the first level. Checked whole by `checkAutomation` on save.
import { CgButton, CgCheckBox, CgSortableList } from '@cashgear/ui';
import { cloneElement, isValidElement, useId, useRef, type ReactNode } from 'react';
import {
  MAX_ALL_STEPS,
  MAX_BRANCHES,
  MAX_MESSAGE,
  MAX_NESTING,
  MAX_STEPS,
  MAX_WAIT_MINUTES,
  STEP_KINDS,
  STEP_KINDS_BEFORE_17,
} from '@cgw/workspace/automations';
import {
  type AutomationStep,
  type AutomationTrigger,
  type DatabaseRecord,
  type FilterGroup,
  type PropertyDef,
  type StepKind,
  type StepValue,
  type WaitFor,
} from '../core';
import { useDatabaseContext } from '../context';
import type { DatabaseAutomations, Person } from '../host';
import { liveProperties, propertyOf } from '../model/properties';
import { FilterEditor } from '../toolbar/FilterEditor';
import { dateProperties, newStep, peopleProperties, stepFits, writable } from './model';
import type { AutoT } from './words';

const EMPTY_GROUP: FilterGroup = { kind: 'group', op: 'and', children: [] };

export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: string;
}) {
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

/** What a value may be worked out from where its step sits. */
interface Allowed {
  actor: boolean;
  row: boolean;
  /** Phase 17: on an approval's answered paths, who answered and the comment. */
  answer: boolean;
}

/** The value a step writes into a property, with what that property's type takes. */
function ValueEditor({
  def,
  value,
  onChange,
  people,
  allowed,
  at,
}: {
  def: PropertyDef;
  value: StepValue | undefined;
  onChange(value: StepValue): void;
  people: Person[];
  allowed: Allowed;
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
          value={
            dynamic === 'actor' ? 'actor' : dynamic === 'approver' ? 'approver' : (chosen[0] ?? '')
          }
          onChange={(event) => {
            const next = event.target.value;
            onChange(
              next === 'actor' || next === 'approver' ? { dynamic: next } : next ? [next] : null,
            );
          }}
        >
          <option value="">{at('set.clear')}</option>
          {allowed.actor ? <option value="actor">{at('set.actor')}</option> : null}
          {allowed.answer ? <option value="approver">{at('approval.approver')}</option> : null}
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
          {allowed.row && def.type === 'relation' ? (
            <option value="row">{at('set.thisRow')}</option>
          ) : null}
        </select>
      );
    default: {
      const comment = dynamic === 'comment';
      const text = (
        <input
          className="cgw-text-input"
          aria-label={label}
          dir="auto"
          defaultValue={typeof value === 'string' ? value : ''}
          onBlur={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      );
      if (!allowed.answer || (def.type !== 'text' && def.type !== 'title')) return text;
      return (
        <span className="cgw-db-auto-choices">
          <CgCheckBox
            label={at('approval.comment')}
            checked={comment}
            onCheckedChange={(on) =>
              onChange(on === true ? { dynamic: 'comment' } : def.type === 'title' ? '' : null)
            }
          />
          {comment ? null : text}
        </span>
      );
    }
  }
}

/** The values a step writes: a property and its value per line. */
function ValuesEditor({
  database,
  values,
  onChange,
  people,
  allowed,
  at,
}: {
  database: DatabaseRecord;
  values: Record<string, StepValue>;
  onChange(values: Record<string, StepValue>): void;
  people: Person[];
  allowed: Allowed;
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
              allowed={allowed}
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

/** A length of time in its largest whole unit: an amount and minutes, hours or days. */
export function Minutes({
  label,
  minutes,
  onChange,
  at,
  max = MAX_WAIT_MINUTES,
}: {
  label: string;
  minutes: number;
  onChange(minutes: number): void;
  at: AutoT;
  max?: number;
}) {
  const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  const set = (amount: number, nextUnit: number) =>
    onChange(Math.min(max, Math.max(1, Math.trunc(amount || 1)) * nextUnit));
  return (
    <div className="cgw-db-auto-row">
      <Field label={label}>
        <input
          key={`${minutes}`}
          type="number"
          min={1}
          className="cgw-text-input cgw-db-auto-short"
          defaultValue={minutes / unit}
          onBlur={(event) => set(Number(event.target.value), unit)}
        />
      </Field>
      <Field label={at('trigger_.unit')}>
        <select
          className="cgw-select"
          value={unit}
          onChange={(event) => set(minutes / unit, Number(event.target.value))}
        >
          <option value={1}>{at('trigger_.minutes')}</option>
          <option value={60}>{at('trigger_.hours')}</option>
          <option value={1440}>{at('trigger_.days')}</option>
        </select>
      </Field>
    </div>
  );
}

/** Who a notice or an approval goes to: people, groups and a person property's people. */
function Recipients<S extends { people: string[]; groups: string[]; personProperties: string[] }>({
  step,
  onChange,
  ctx,
  people,
}: {
  step: S;
  onChange(step: S): void;
  ctx: StepsCtx;
  people: Person[];
}) {
  const { at, database, groups, rowTrigger } = ctx;
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
    </>
  );
}

/** Before, after or at a date: a signed number of minutes. */
function OffsetEditor({
  minutes,
  onChange,
  at,
}: {
  minutes: number;
  onChange(minutes: number): void;
  at: AutoT;
}) {
  const side = minutes < 0 ? 'before' : minutes > 0 ? 'after' : 'at';
  return (
    <>
      <Field label={at('trigger_.offset')}>
        <select
          className="cgw-select"
          value={side}
          onChange={(event) => {
            const next = event.target.value;
            const size = Math.abs(minutes) || 1440;
            onChange(next === 'at' ? 0 : next === 'before' ? -size : size);
          }}
        >
          <option value="at">{at('trigger_.offsetAt')}</option>
          <option value="before">{at('trigger_.offsetBefore')}</option>
          <option value="after">{at('trigger_.offsetAfter')}</option>
        </select>
      </Field>
      {side !== 'at' ? (
        <Minutes
          label={at('trigger_.amount')}
          minutes={Math.abs(minutes)}
          max={43_200}
          at={at}
          onChange={(size) => onChange(side === 'before' ? -size : size)}
        />
      ) : null}
    </>
  );
}

/** What a step list is edited within: the rule's database, trigger and what the person may do. */
export interface StepsCtx {
  database: DatabaseRecord;
  trigger: AutomationTrigger;
  rowTrigger: boolean;
  data: DatabaseAutomations;
  groups: { id: string; name: string }[];
  canManage: boolean;
  at: AutoT;
  /** Every step of the rule now, inside paths too (at most `MAX_ALL_STEPS`). */
  total: number;
}

function WaitBody({
  step,
  onChange,
  ctx,
}: {
  step: Extract<AutomationStep, { kind: 'wait' }>;
  onChange(step: AutomationStep): void;
  ctx: StepsCtx;
}) {
  const { at, database, rowTrigger, canManage } = ctx;
  const until = step.until;
  const dates = dateProperties(database);
  const set = (next: WaitFor) => onChange({ ...step, until: next });
  return (
    <>
      <Field label={at('wait.for')}>
        <select
          className="cgw-select"
          value={until.kind}
          onChange={(event) => {
            const kind = event.target.value;
            set(
              kind === 'date'
                ? { kind, propertyId: dates[0]?.id ?? '', offsetMinutes: 0, at: null }
                : kind === 'match'
                  ? { kind, conditions: EMPTY_GROUP, minutes: 10080 }
                  : { kind: 'time', minutes: 1440 },
            );
          }}
        >
          <option value="time">{at('wait.time')}</option>
          {rowTrigger && dates.length ? <option value="date">{at('wait.date')}</option> : null}
          {rowTrigger ? <option value="match">{at('wait.match')}</option> : null}
        </select>
      </Field>
      {until.kind === 'time' ? (
        <Minutes
          label={at('wait.amount')}
          minutes={until.minutes}
          at={at}
          onChange={(minutes) => set({ ...until, minutes })}
        />
      ) : null}
      {until.kind === 'date' ? (
        <>
          <Field label={at('trigger_.dateProperty')}>
            <select
              className="cgw-select"
              value={until.propertyId}
              onChange={(event) => set({ ...until, propertyId: event.target.value })}
            >
              {dates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <OffsetEditor
            minutes={until.offsetMinutes}
            at={at}
            onChange={(offsetMinutes) => set({ ...until, offsetMinutes })}
          />
          <Field label={at('trigger_.at')}>
            <input
              type="time"
              className="cgw-text-input cgw-db-auto-short"
              value={until.at ?? '09:00'}
              onChange={(event) => set({ ...until, at: event.target.value || null })}
            />
          </Field>
        </>
      ) : null}
      {until.kind === 'match' ? (
        <>
          <FilterEditor
            database={database}
            filter={until.conditions}
            editable={canManage}
            onChange={(conditions) => set({ ...until, conditions: conditions ?? EMPTY_GROUP })}
          />
          <Minutes
            label={at('wait.limit')}
            minutes={until.minutes}
            at={at}
            onChange={(minutes) => set({ ...until, minutes })}
          />
          <p className="cgw-db-auto-note">{at('wait.limitHelp')}</p>
        </>
      ) : null}
      <p className="cgw-db-auto-note">{at('wait.help')}</p>
    </>
  );
}

function BranchBody({
  step,
  onChange,
  ctx,
  level,
  answered,
}: {
  step: Extract<AutomationStep, { kind: 'branch' }>;
  onChange(step: AutomationStep): void;
  ctx: StepsCtx;
  level: number;
  answered: boolean;
}) {
  const { at, database, canManage } = ctx;
  const name = (b: number) => (b === 0 ? at('branch.if') : at('branch.elseIf'));
  return (
    <>
      {step.branches.map((path, b) => (
        <fieldset key={b} className="cgw-db-auto-path">
          <legend>{name(b)}</legend>
          <FilterEditor
            database={database}
            filter={path.when}
            editable={canManage}
            onChange={(when) =>
              onChange({
                ...step,
                branches: step.branches.map((p, i) =>
                  i === b ? { ...p, when: when ?? EMPTY_GROUP } : p,
                ),
              })
            }
          />
          <StepList
            steps={path.steps}
            ctx={ctx}
            level={level + 1}
            answered={answered}
            label={at('branch.pathSteps', { path: name(b) })}
            onChange={(steps) =>
              onChange({
                ...step,
                branches: step.branches.map((p, i) => (i === b ? { ...p, steps } : p)),
              })
            }
          />
          {canManage && step.branches.length > 1 ? (
            <CgButton
              appearance="ghost"
              size="small"
              onClick={() =>
                onChange({ ...step, branches: step.branches.filter((_, i) => i !== b) })
              }
            >
              {at('branch.removePath')}
            </CgButton>
          ) : null}
        </fieldset>
      ))}
      {canManage && step.branches.length < MAX_BRANCHES ? (
        <CgButton
          appearance="outline"
          size="small"
          onClick={() =>
            onChange({ ...step, branches: [...step.branches, { when: EMPTY_GROUP, steps: [] }] })
          }
        >
          {at('branch.addPath')}
        </CgButton>
      ) : null}
      <fieldset className="cgw-db-auto-path">
        <legend>{at('branch.otherwise')}</legend>
        <StepList
          steps={step.otherwise}
          ctx={ctx}
          level={level + 1}
          answered={answered}
          label={at('branch.pathSteps', { path: at('branch.otherwise') })}
          onChange={(otherwise) => onChange({ ...step, otherwise })}
        />
      </fieldset>
    </>
  );
}

function ApprovalBody({
  step,
  onChange,
  ctx,
  level,
  people,
}: {
  step: Extract<AutomationStep, { kind: 'approval' }>;
  onChange(step: AutomationStep): void;
  ctx: StepsCtx;
  level: number;
  people: Person[];
}) {
  const { at } = ctx;
  const paths = [
    ['approved', at('approval.approved'), true],
    ['rejected', at('approval.rejected'), true],
    ['noAnswer', at('approval.noAnswer'), false],
  ] as const;
  return (
    <>
      <Recipients step={step} onChange={(next) => onChange(next)} ctx={ctx} people={people} />
      <Field label={at('approval.mode')}>
        <select
          className="cgw-select"
          value={step.mode}
          onChange={(event) => onChange({ ...step, mode: event.target.value as 'any' | 'all' })}
        >
          <option value="any">{at('approval.any')}</option>
          <option value="all">{at('approval.all')}</option>
        </select>
      </Field>
      <Field label={at('approval.message')} help={at('approval.messageHelp')}>
        <textarea
          className="cgw-text-input cgw-db-auto-message"
          dir="auto"
          maxLength={MAX_MESSAGE}
          value={step.message}
          onChange={(event) => onChange({ ...step, message: event.target.value })}
        />
      </Field>
      <Minutes
        label={at('approval.deadline')}
        minutes={step.deadlineMinutes}
        at={at}
        onChange={(deadlineMinutes) => onChange({ ...step, deadlineMinutes })}
      />
      {paths.map(([key, name, answered]) => (
        <fieldset key={key} className="cgw-db-auto-path">
          <legend>{name}</legend>
          <StepList
            steps={step[key]}
            ctx={ctx}
            level={level + 1}
            answered={answered}
            label={at('branch.pathSteps', { path: name })}
            onChange={(list) =>
              onChange(
                key === 'approved'
                  ? { ...step, approved: list }
                  : key === 'rejected'
                    ? { ...step, rejected: list }
                    : { ...step, noAnswer: list },
              )
            }
          />
        </fieldset>
      ))}
    </>
  );
}

function StepBody({
  step,
  onChange,
  ctx,
  level,
  answered,
}: {
  step: AutomationStep;
  onChange(step: AutomationStep): void;
  ctx: StepsCtx;
  level: number;
  answered: boolean;
}) {
  const { host } = useDatabaseContext();
  const people = host.people();
  const { at, database, rowTrigger, data } = ctx;
  const allowed: Allowed = { actor: rowTrigger, row: false, answer: answered };
  switch (step.kind) {
    case 'set':
      return (
        <ValuesEditor
          database={database}
          values={step.values}
          onChange={(values) => onChange({ ...step, values })}
          people={people}
          allowed={allowed}
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
              allowed={{ ...allowed, row: rowTrigger }}
              at={at}
            />
          ) : (
            <p className="cgw-db-auto-note">{at('addRow.notHeld')}</p>
          )}
        </>
      );
    }
    case 'notify':
      return (
        <>
          <Recipients step={step} onChange={(next) => onChange(next)} ctx={ctx} people={people} />
          <Field label={at('notify.message')} help={at('notify.messageHelp')}>
            <textarea
              className="cgw-text-input cgw-db-auto-message"
              dir="auto"
              maxLength={MAX_MESSAGE}
              value={step.message}
              onChange={(event) => onChange({ ...step, message: event.target.value })}
            />
          </Field>
          {/* Phase 17: under a date trigger, a notice may be a reminder of the date reached. */}
          {ctx.trigger.kind === 'date' && (data.stepKinds ?? 4) >= 7 ? (
            <CgCheckBox
              label={at('notify.reminder')}
              description={at('notify.reminderHelp')}
              checked={step.reminder === true}
              onCheckedChange={(on) => {
                const { reminder, ...rest } = step;
                void reminder;
                onChange(on === true ? { ...rest, reminder: true } : rest);
              }}
            />
          ) : null}
        </>
      );
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
    case 'wait':
      return <WaitBody step={step} onChange={onChange} ctx={ctx} />;
    case 'branch':
      return (
        <BranchBody step={step} onChange={onChange} ctx={ctx} level={level} answered={answered} />
      );
    case 'approval':
      return (
        <ApprovalBody step={step} onChange={onChange} ctx={ctx} level={level} people={people} />
      );
    default:
      return null;
  }
}

/**
 * The step kinds offered here: those the trigger fits, webhooks for owners and admins, Phase 17's
 * only once the server keeps them (`stepKinds`), and no branch or approval at the last level.
 */
export function offeredKinds(ctx: StepsCtx, level: number): StepKind[] {
  const kept = ctx.data.stepKinds ?? STEP_KINDS_BEFORE_17;
  return STEP_KINDS.filter((_, i) => i < kept)
    .filter((k) => stepFits(k, ctx.trigger))
    .filter((k) => k !== 'webhook' || ctx.data.canCallWebhooks)
    .filter((k) => level < MAX_NESTING || (k !== 'branch' && k !== 'approval'));
}

/**
 * One list of steps: the rule's own (`level` 1, at least one step), or a branch's or an approval's
 * (0 or more). Each step keeps a key of its own while the rule is edited, as its place can change.
 */
export function StepList({
  steps,
  onChange,
  ctx,
  level,
  answered,
  label,
}: {
  steps: AutomationStep[];
  onChange(steps: AutomationStep[]): void;
  ctx: StepsCtx;
  level: number;
  answered: boolean;
  label: string;
}) {
  const { at, database, rowTrigger, canManage } = ctx;
  const keys = useRef<string[]>([]);
  const counter = useRef(0);
  if (keys.current.length !== steps.length) keys.current = steps.map(() => `s${counter.current++}`);
  // The rule's own list keeps a step; a repeating row's rule (its row made by its trigger) may keep none.
  const min = level === 1 && ctx.trigger.kind !== 'recurring' ? 1 : 0;
  const items = steps.map((step, i) => ({ key: keys.current[i], step }));
  const change = (next: { key: string; step: AutomationStep }[]) => {
    keys.current = next.map((s) => s.key);
    onChange(next.map((s) => s.step));
  };
  const stepName = (kind: StepKind) => at(`stepKinds.${kind}`);
  const kinds = offeredKinds(ctx, level);
  return (
    <div className="cgw-db-auto-list-steps">
      {steps.length ? (
        <CgSortableList
          className="cgw-db-auto-steps"
          label={label}
          items={items}
          getKey={(item) => item.key}
          disabled={!canManage}
          handleLabel={(_, index) => at('stepDrag', { number: index + 1 })}
          onMove={(key, to) => {
            const from = items.findIndex((s) => s.key === key);
            const next = [...items];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            change(next);
          }}
          renderItem={(item, { index }) => (
            <fieldset className="cgw-db-auto-step" disabled={!canManage}>
              <legend>
                {at('stepNumber', { number: index + 1 })}: {stepName(item.step.kind)}
              </legend>
              <StepBody
                step={item.step}
                ctx={ctx}
                level={level}
                answered={answered}
                onChange={(step) =>
                  change(items.map((s) => (s.key === item.key ? { ...s, step } : s)))
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
                        change(
                          items.map((s) =>
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
                      change(
                        items.map((s) =>
                          s.key === item.key ? { ...s, step: { ...s.step, when: EMPTY_GROUP } } : s,
                        ),
                      )
                    }
                  >
                    {at('stepWhenAdd')}
                  </CgButton>
                ) : null
              ) : null}
              {canManage && steps.length > min ? (
                <CgButton
                  appearance="ghost"
                  size="small"
                  onClick={() => change(items.filter((s) => s.key !== item.key))}
                >
                  {at('stepRemove', { number: index + 1 })}
                </CgButton>
              ) : null}
            </fieldset>
          )}
        />
      ) : (
        <p className="cgw-db-auto-note">{at('branch.empty')}</p>
      )}
      {canManage && steps.length < MAX_STEPS && ctx.total < MAX_ALL_STEPS ? (
        <select
          className="cgw-select"
          aria-label={level === 1 ? at('addStep') : at('nested.add', { path: label })}
          value=""
          onChange={(event) => {
            const kind = event.target.value as StepKind;
            if (!kind) return;
            change([...items, { key: `s${counter.current++}`, step: newStep(kind, database) }]);
          }}
        >
          <option value="">{at('addStep')}</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {stepName(k)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
