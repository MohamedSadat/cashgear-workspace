// Automations (Phase 15; DATA_MODEL.md, Automations): a database's rules, each a trigger,
// conditions over the row in `queryRows`' filter language, and steps in order, run on the server
// as the rule's author. This file holds what a rule is, the check every `automation.upsert` passes
// on the device and again on the server (`checkAutomation`; the C# port is
// server/src/Cgw.Core/Automations/AutomationRules.cs), and which change of a row starts a rule
// (`changeStarts`). The two are held together by packages/workspace/vectors/db-automation-vectors.json.
// No React, no DOM; nothing here runs a rule: only the server does.
import { isId, type Id } from '../ids';
import { OpError, type RowRecord } from '../types';
import { isPropertyId } from './ids';
import { matchesFilter } from './query';
import {
  STORED_TYPES,
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type FilterValue,
  type PropertyDef,
  type PropertyId,
  type QueryContext,
  type Value,
} from './types';

/** Rules a database holds at most (the server counts them; DECISIONS.md, 2026-11-24). */
export const MAX_AUTOMATIONS = 50;
export const MAX_STEPS = 20;
export const MAX_STEP_VALUES = 50;
export const MAX_RECIPIENTS = 100;
export const MAX_MESSAGE = 1000;
export const MAX_NAME = 200;
/** A date trigger's offset, either way: 30 days. */
export const MAX_OFFSET_MINUTES = 43_200;
/** A rule's JSON, as the server stores it. */
export const MAX_AUTOMATION_CHARS = 100_000;
/** How deep rules start each other: a person's change starts runs of depth 1; depth 4 is stopped. */
export const MAX_DEPTH = 3;
/** Runs a rule may make in a minute, and a workspace. */
export const RULE_RUNS_PER_MINUTE = 100;
export const WORKSPACE_RUNS_PER_MINUTE = 1000;
/** A run is kept this long (its steps too), then the worker removes it. */
export const RUNS_KEPT_DAYS = 30;
/** Phase 17: a wait, and an approval's deadline, last at most 90 days. */
export const MAX_WAIT_MINUTES = 129_600;
/** Phase 17: the paths a branch holds besides its "otherwise". */
export const MAX_BRANCHES = 10;
/** Phase 17: steps nest in branches and approvals at most three levels deep (the rule's own list is the first). */
export const MAX_NESTING = 3;
/** Phase 17: every step of a rule, inside branches and approvals too. */
export const MAX_ALL_STEPS = 50;
/** Phase 17: an approval's comment, as an answer gives it. */
export const MAX_COMMENT = 1000;

/** A value a trigger's change is compared with: an operator and value of the filter language. */
export interface TriggerValue {
  operator: FilterOperator;
  value?: FilterValue;
}

export type AutomationTrigger =
  /** A row added to the database by a person (or by a rule's step, within the depth limit). */
  | { kind: 'rowAdded' }
  /**
   * A property's value changed (null: any stored property or the title), optionally from a value
   * and to one, each read as a filter condition on that property before and after the change.
   */
  | {
      kind: 'propertyChanged';
      propertyId: PropertyId | null;
      from?: TriggerValue | null;
      to?: TriggerValue | null;
    }
  /**
   * A date property's day or time reached, moved by `offsetMinutes` (negative: before it). A day
   * with no time is reached at `at` (`HH:mm`, default 09:00) in the workspace's time zone.
   */
  | { kind: 'date'; propertyId: PropertyId; offsetMinutes: number; at?: string | null }
  /** Every day, week (`weekday`, 0 Sunday) or month (`day`, 1 to 31; a shorter month's last day), at `at`. */
  | {
      kind: 'schedule';
      every: 'day' | 'week' | 'month';
      at: string;
      weekday?: number | null;
      day?: number | null;
    }
  /** A button property pressed on a row. */
  | { kind: 'button'; propertyId: PropertyId }
  /**
   * Phase 16: a form view of the database answered (in the app or by its link): the row the answer
   * added. The server checks that the view is a form of this database.
   */
  | { kind: 'formAnswered'; viewId: Id };

export type TriggerKind = AutomationTrigger['kind'];

/**
 * What a step writes into a property: a value (coerced to the property's type when the step runs),
 * null to clear it, or one worked out then: `now` (a date: today, or now with the time; `days`
 * moves it), `actor` (a person: who started the run), `row` (a relation: the row the rule ran for).
 */
export type StepValue =
  | Value
  | null
  | { dynamic: 'now'; days?: number }
  | { dynamic: 'actor' }
  | { dynamic: 'row' }
  /** Phase 17, on an approval's approved or rejected path: who answered it (a person). */
  | { dynamic: 'approver' }
  /** Phase 17, on an approval's approved or rejected path: the answers' comments (a text). */
  | { dynamic: 'comment' };

interface StepBase {
  /** Conditions over the row as it is when the step's turn comes; null runs it always. */
  when?: FilterGroup | null;
}

/**
 * Phase 17: what a wait waits for. A time; a date property's day or time (moved by the offset; a
 * day with no time reached at `at` in the workspace's zone; a date already past, or none, goes on at
 * once); or the row matching conditions (read again whenever the row changes). A wait lasts at most
 * `MAX_WAIT_MINUTES` from when it began, and `match` at most its own `minutes`: past that the run
 * stops, `wait.expired`.
 */
export type WaitFor =
  | { kind: 'time'; minutes: number }
  | { kind: 'date'; propertyId: PropertyId; offsetMinutes: number; at?: string | null }
  | { kind: 'match'; conditions: FilterGroup; minutes: number };

/** Phase 17: one path of a branch, taken when the row matches its `when`. */
export interface BranchPath {
  when: FilterGroup;
  steps: AutomationStep[];
}

export type AutomationStep =
  /** Sets the row's properties (the title among them) as the rule's author. */
  | (StepBase & { kind: 'set'; values: Record<PropertyId, StepValue> })
  /** Adds a row to a database the author can edit, from one of its templates (values, icon, cover, body). */
  | (StepBase & {
      kind: 'addRow';
      databaseId: Id;
      templateId: Id | null;
      values: Record<PropertyId, StepValue>;
    })
  /** Tells people, groups and the people in person properties, in their inbox and by their mail setting. */
  | (StepBase & {
      kind: 'notify';
      people: Id[];
      groups: Id[];
      personProperties: PropertyId[];
      message: string;
    })
  /** Calls a workspace's webhook with the properties named (owners and admins only). */
  | (StepBase & { kind: 'webhook'; webhookId: Id; properties: PropertyId[] })
  /** Phase 17: waits, its run's place kept on the server, and goes on when it ends. */
  | (StepBase & { kind: 'wait'; until: WaitFor })
  /** Phase 17: the first path whose conditions the row matches (if, else if), else `otherwise`. */
  | (StepBase & { kind: 'branch'; branches: BranchPath[]; otherwise: AutomationStep[] })
  /**
   * Phase 17: asks people, groups and a person property's people to approve, in their inbox and by
   * their mail setting; goes on by `approved` or `rejected` at the first answer (`any`) or once every
   * one asked approved or one rejected (`all`), or by `noAnswer` after the deadline.
   */
  | (StepBase & {
      kind: 'approval';
      people: Id[];
      groups: Id[];
      personProperties: PropertyId[];
      mode: 'any' | 'all';
      message: string;
      deadlineMinutes: number;
      approved: AutomationStep[];
      rejected: AutomationStep[];
      noAnswer: AutomationStep[];
    });

export type StepKind = AutomationStep['kind'];

export interface AutomationRecord {
  id: Id;
  workspaceId: Id;
  databaseId: Id;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** Over the row the rule runs for; null runs it for every row its trigger names. */
  conditions: FilterGroup | null;
  steps: AutomationStep[];
  /** Who it acts as: the person who last saved it, set by the server. Null until it has. */
  authorId: Id | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'rowAdded',
  'propertyChanged',
  'date',
  'schedule',
  'button',
  'formAnswered',
];
export const STEP_KINDS: readonly StepKind[] = [
  'set',
  'addRow',
  'notify',
  'webhook',
  'wait',
  'branch',
  'approval',
];
/** Phase 17: the step kinds a server before 0.17.0 keeps (`/version`'s `stepKinds` 4, or none). */
export const STEP_KINDS_BEFORE_17 = 4;

/** Phase 17: the step lists a step holds (a branch's paths and otherwise, an approval's three), in order. */
export function childLists(step: AutomationStep): AutomationStep[][] {
  if (step.kind === 'branch') return [...step.branches.map((b) => b.steps), step.otherwise];
  if (step.kind === 'approval') return [step.approved, step.rejected, step.noAnswer];
  return [];
}

/**
 * Phase 17: every step of a list, inside branches and approvals too, in the order a run meets them,
 * each with its path (`"2"`, a top-level step; `"2/0/1"`, the second step of the first list step 2
 * holds: a branch's paths in order then its otherwise, an approval's approved, rejected, no answer).
 */
export function* allSteps(
  steps: readonly AutomationStep[],
  prefix = '',
): Generator<{ step: AutomationStep; path: string }> {
  for (let i = 0; i < steps.length; i++) {
    const path = prefix ? `${prefix}/${i}` : String(i);
    yield { step: steps[i], path };
    const lists = childLists(steps[i]);
    for (let l = 0; l < lists.length; l++) yield* allSteps(lists[l], `${path}/${l}`);
  }
}

/** Phase 17: the step at a path (`allSteps`), or null. */
export function stepAt(steps: readonly AutomationStep[], path: string): AutomationStep | null {
  const parts = path.split('/').map(Number);
  let list: readonly AutomationStep[] = steps;
  let step: AutomationStep | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    step = list[parts[i]] ?? null;
    if (!step) return null;
    if (i + 1 < parts.length) {
      const next = childLists(step)[parts[i + 1]];
      if (!next) return null;
      list = next;
    }
  }
  return step;
}

/** Phase 17: whether a rule waits on its row (a date or conditions), so its row's changes are written for it. */
export const watchesRows = (steps: readonly AutomationStep[]): boolean => {
  for (const { step } of allSteps(steps))
    if (step.kind === 'wait' && step.until.kind !== 'time') return true;
  return false;
};

const OPERATORS = new Set<FilterOperator>([
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'eq',
  'ne',
  'gt',
  'lt',
  'ge',
  'le',
  'before',
  'after',
  'onOrBefore',
  'onOrAfter',
  'group',
]);

/** A refused rule: `reason` names the part, the same in the C# port (the vectors hold it). */
export class AutomationError extends OpError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super('invalid', message);
    this.name = 'AutomationError';
  }
}

const fail = (reason: string, message: string): never => {
  throw new AutomationError(reason, message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `HH:mm`, 00:00 to 23:59. */
export const isTimeOfDay = (value: unknown): value is string =>
  typeof value === 'string' && TIME.test(value);

const live = (db: DatabaseRecord, id: unknown): PropertyDef | undefined =>
  typeof id === 'string' ? db.properties.find((p) => p.id === id && !p.trashedAt) : undefined;

const stored = (def: PropertyDef) => STORED_TYPES.includes(def.type);
/** What a change can be about, and a set step can write: the title and the stored types. */
const writable = (def: PropertyDef) => def.type === 'title' || stored(def);
const PEOPLE_TYPES = new Set(['person', 'createdBy', 'lastEditedBy']);
const DATE_TRIGGER_TYPES = new Set(['date', 'createdTime']);

function wholeNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** A filter condition's shape, as a view's filter holds it (the filter decides what it matches). */
function checkCondition(value: unknown, reason: string): FilterCondition {
  if (!isObject(value) || value.kind !== 'condition') fail(reason, 'A condition is an object');
  const c = value as Record<string, unknown>;
  if (!isPropertyId(c.propertyId) && c.propertyId !== TITLE_PROPERTY)
    fail(reason, 'A condition names a property');
  if (!OPERATORS.has(c.operator as FilterOperator)) fail(reason, 'Not a filter operator');
  const out: FilterCondition = {
    kind: 'condition',
    propertyId: c.propertyId as PropertyId,
    operator: c.operator as FilterOperator,
  };
  if (c.value !== undefined) out.value = checkFilterValue(c.value, reason);
  return out;
}

function checkFilterValue(value: unknown, reason: string): FilterValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.date === 'string') return { date: value.date };
    if (keys.length === 1 && typeof value.relative === 'string')
      return { relative: value.relative } as FilterValue;
    if (keys.length === 1 && value.me === true) return { me: true };
  }
  return fail(reason, 'Not a filter value');
}

/** A filter group of at most two levels and 50 conditions, as a view's filter. */
function checkGroup(value: unknown, reason: string, depth = 1): FilterGroup {
  if (!isObject(value) || value.kind !== 'group') fail(reason, 'Conditions are a filter group');
  const g = value as Record<string, unknown>;
  if (g.op !== 'and' && g.op !== 'or') fail(reason, 'A group is "and" or "or"');
  if (!Array.isArray(g.children) || g.children.length > 50)
    fail(reason, 'A group holds at most 50 conditions');
  const children = (g.children as unknown[]).map((child) => {
    if (isObject(child) && child.kind === 'group') {
      if (depth >= 2) fail(reason, 'Conditions nest at most two levels');
      return checkGroup(child, reason, depth + 1);
    }
    return checkCondition(child, reason);
  });
  return { kind: 'group', op: g.op as 'and' | 'or', children };
}

function checkTriggerValue(value: unknown): TriggerValue | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !OPERATORS.has(value.operator as FilterOperator))
    fail('trigger', 'From and to are an operator and a value');
  const v = value as Record<string, unknown>;
  const out: TriggerValue = { operator: v.operator as FilterOperator };
  if (v.value !== undefined) out.value = checkFilterValue(v.value, 'trigger');
  return out;
}

function checkTrigger(value: unknown, db: DatabaseRecord): AutomationTrigger {
  if (!isObject(value)) return fail('trigger', 'A rule has a trigger');
  switch (value.kind) {
    case 'rowAdded':
      return { kind: 'rowAdded' };
    case 'propertyChanged': {
      const id = value.propertyId ?? null;
      if (id !== null) {
        const def = live(db, id);
        if (!def || !writable(def))
          fail('trigger.property', 'A change is watched on the title or a stored property');
      }
      const from = checkTriggerValue(value.from);
      const to = checkTriggerValue(value.to);
      if (id === null && (from || to))
        fail('trigger', 'From and to need the property they are about');
      return { kind: 'propertyChanged', propertyId: id as PropertyId | null, from, to };
    }
    case 'date': {
      const def = live(db, value.propertyId);
      if (!def || !DATE_TRIGGER_TYPES.has(def.type))
        fail('trigger.property', 'A date trigger names a date or created-time property');
      if (!wholeNumber(value.offsetMinutes, -MAX_OFFSET_MINUTES, MAX_OFFSET_MINUTES))
        fail('trigger', 'The offset is whole minutes, at most 30 days either way');
      const at = value.at ?? null;
      if (at !== null && !isTimeOfDay(at)) fail('trigger', 'A time of day is HH:mm');
      return {
        kind: 'date',
        propertyId: def!.id,
        offsetMinutes: value.offsetMinutes as number,
        at: at as string | null,
      };
    }
    case 'schedule': {
      const every = value.every;
      if (every !== 'day' && every !== 'week' && every !== 'month')
        fail('trigger', 'A schedule is every day, week or month');
      if (!isTimeOfDay(value.at)) fail('trigger', 'A time of day is HH:mm');
      const out: AutomationTrigger = {
        kind: 'schedule',
        every: every as 'day' | 'week' | 'month',
        at: value.at as string,
        weekday: null,
        day: null,
      };
      if (every === 'week') {
        if (!wholeNumber(value.weekday, 0, 6)) fail('trigger', 'A weekly schedule names its day');
        out.weekday = value.weekday as number;
      }
      if (every === 'month') {
        if (!wholeNumber(value.day, 1, 31)) fail('trigger', 'A monthly schedule names its day');
        out.day = value.day as number;
      }
      return out;
    }
    case 'button': {
      const def = live(db, value.propertyId);
      if (!def || def.type !== 'button')
        fail('trigger.property', 'A button trigger names a button property');
      return { kind: 'button', propertyId: def!.id };
    }
    case 'formAnswered':
      // Which views are forms of the database is the server's to check: a device may not hold them.
      if (!isId(value.viewId)) fail('trigger.form', 'A form trigger names its form');
      return { kind: 'formAnswered', viewId: value.viewId as Id };
    default:
      return fail('trigger', 'Not a trigger');
  }
}

/** One value a step writes, by the property it is for when that is known. */
function checkStepValue(
  value: unknown,
  def: PropertyDef | undefined,
  rowTrigger: boolean,
  answered: boolean,
): StepValue {
  if (value === null) return null;
  if (isObject(value) && 'dynamic' in value) {
    const keys = Object.keys(value);
    switch (value.dynamic) {
      case 'approver':
        if (keys.length !== 1) fail('step.value', 'Not a value a step writes');
        if (!answered)
          fail('step.value', '"Who answered" is known on an approval\'s answered paths only');
        if (def && def.type !== 'person')
          fail('step.value', '"Who answered" is written into a person');
        return { dynamic: 'approver' };
      case 'comment':
        if (keys.length !== 1) fail('step.value', 'Not a value a step writes');
        if (!answered)
          fail('step.value', "A comment is known on an approval's answered paths only");
        if (def && def.type !== 'text' && def.type !== 'title')
          fail('step.value', 'A comment is written into a text');
        return { dynamic: 'comment' };
      case 'now':
        if (keys.some((k) => k !== 'dynamic' && k !== 'days'))
          fail('step.value', 'Not a value a step writes');
        if (def && def.type !== 'date') fail('step.value', '"Now" is written into a date');
        if (value.days !== undefined && !wholeNumber(value.days, -3650, 3650))
          fail('step.value', 'Days are whole, at most ten years either way');
        return value.days === undefined
          ? { dynamic: 'now' }
          : { dynamic: 'now', days: value.days as number };
      case 'actor':
        if (keys.length !== 1) fail('step.value', 'Not a value a step writes');
        if (!rowTrigger) fail('step.value', 'A schedule has nobody who started it');
        if (def && def.type !== 'person')
          fail('step.value', '"Who started it" is written into a person');
        return { dynamic: 'actor' };
      case 'row':
        if (keys.length !== 1) fail('step.value', 'Not a value a step writes');
        if (!rowTrigger) fail('step.value', 'A schedule has no row');
        if (def && def.type !== 'relation')
          fail('step.value', '"This row" is written into a relation');
        return { dynamic: 'row' };
      default:
        return fail('step.value', 'Not a value a step writes');
    }
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 1000 && value.every((v) => typeof v === 'string'))
    return value as string[];
  if (
    isObject(value) &&
    typeof value.start === 'string' &&
    Object.keys(value).every((k) => k === 'start' || k === 'end') &&
    (value.end === undefined || value.end === null || typeof value.end === 'string')
  )
    return value.end == null
      ? { start: value.start }
      : { start: value.start, end: value.end as string };
  return fail('step.value', 'Not a value a step writes');
}

function checkValues(
  value: unknown,
  db: DatabaseRecord | null,
  rowTrigger: boolean,
  atLeastOne: boolean,
  answered: boolean,
): Record<PropertyId, StepValue> {
  if (!isObject(value)) return fail('step.values', 'A step writes an object of values');
  const entries = Object.entries(value);
  if (entries.length > MAX_STEP_VALUES) fail('step.values', 'A step writes at most 50 values');
  if (atLeastOne && entries.length === 0) fail('step.values', 'A step sets at least one property');
  const out: Record<PropertyId, StepValue> = {};
  for (const [id, raw] of entries) {
    if (!isPropertyId(id) && id !== TITLE_PROPERTY) fail('step.values', `Not a property id: ${id}`);
    let def: PropertyDef | undefined;
    if (db) {
      def = live(db, id);
      if (!def || !writable(def)) fail('step.values', `Property ${id} is not one a step writes`);
    }
    // A title is text, or (Phase 17) an approval's comment.
    const comment = isObject(raw) && raw.dynamic === 'comment';
    if (id === TITLE_PROPERTY && raw !== null && typeof raw !== 'string' && !comment)
      fail('step.value', 'A title is text');
    out[id] = checkStepValue(raw, def, rowTrigger, answered);
  }
  return out;
}

function checkIds(value: unknown, reason: string, max = MAX_RECIPIENTS): Id[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isId))
    fail(reason, `At most ${max} ids`);
  return [...new Set(value as Id[])];
}

/** What a step is checked within: its rule's database and trigger, and where it sits (Phase 17). */
interface StepCtx {
  db: DatabaseRecord;
  rowTrigger: boolean;
  target: (id: Id) => DatabaseRecord | null;
  /** On an approval's approved or rejected path: who answered and the comment may be written. */
  answered: boolean;
  /** The list's level: the rule's own steps are 1. */
  level: number;
  /** Steps met so far in the whole rule. */
  count: { n: number };
}

function checkRecipients(value: Record<string, unknown>, ctx: StepCtx) {
  const people = checkIds(value.people, 'step.recipients');
  const groups = checkIds(value.groups, 'step.recipients');
  const properties = value.personProperties ?? [];
  if (!Array.isArray(properties) || properties.length > MAX_RECIPIENTS)
    fail('step.recipients', 'At most 100 person properties');
  for (const id of properties as unknown[]) {
    const def = live(ctx.db, id);
    if (!def || !PEOPLE_TYPES.has(def.type))
      fail('step.recipients', 'A notice goes to the people of a person property');
  }
  if (!ctx.rowTrigger && (properties as unknown[]).length)
    fail('step.recipients', 'A schedule has no row whose people to tell');
  if (!people.length && !groups.length && !(properties as unknown[]).length)
    fail('step.recipients', 'A notice goes to someone');
  return { people, groups, personProperties: [...new Set(properties as PropertyId[])] };
}

/** A list a branch or an approval holds: 0 to 20 steps, one level deeper. */
function checkList(value: unknown, ctx: StepCtx, answered: boolean): AutomationStep[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_STEPS)
    fail('steps', 'A path holds at most 20 steps');
  const inner: StepCtx = { ...ctx, level: ctx.level + 1, answered };
  return (value as unknown[]).map((step) => checkStep(step, inner));
}

function checkWait(value: unknown, ctx: StepCtx): WaitFor {
  if (!isObject(value)) return fail('step.wait', 'A wait says what it waits for');
  switch (value.kind) {
    case 'time':
      if (!wholeNumber(value.minutes, 1, MAX_WAIT_MINUTES))
        fail('step.wait', 'A wait is whole minutes, at most 90 days');
      return { kind: 'time', minutes: value.minutes as number };
    case 'date': {
      if (!ctx.rowTrigger) fail('step.wait', 'A schedule has no row whose date to wait for');
      const def = live(ctx.db, value.propertyId);
      if (!def || !DATE_TRIGGER_TYPES.has(def.type))
        fail('step.wait', 'A wait for a date names a date or created-time property');
      if (!wholeNumber(value.offsetMinutes, -MAX_OFFSET_MINUTES, MAX_OFFSET_MINUTES))
        fail('step.wait', 'The offset is whole minutes, at most 30 days either way');
      const at = value.at ?? null;
      if (at !== null && !isTimeOfDay(at)) fail('step.wait', 'A time of day is HH:mm');
      return {
        kind: 'date',
        propertyId: def!.id,
        offsetMinutes: value.offsetMinutes as number,
        at: at as string | null,
      };
    }
    case 'match':
      if (!ctx.rowTrigger) fail('step.wait', 'A schedule has no row to wait on');
      if (!wholeNumber(value.minutes, 1, MAX_WAIT_MINUTES))
        fail('step.wait', 'A wait is whole minutes, at most 90 days');
      return {
        kind: 'match',
        conditions: checkGroup(value.conditions, 'step.wait'),
        minutes: value.minutes as number,
      };
    default:
      return fail('step.wait', 'Not something a wait waits for');
  }
}

function checkStep(value: unknown, ctx: StepCtx): AutomationStep {
  const { db, rowTrigger, target } = ctx;
  if (++ctx.count.n > MAX_ALL_STEPS) fail('steps', 'A rule has at most 50 steps in all');
  if (!isObject(value)) return fail('step.kind', 'A step is an object');
  const when =
    value.when === undefined || value.when === null ? null : checkGroup(value.when, 'step.when');
  if (when && !rowTrigger) fail('step.when', 'A schedule has no row to put conditions on');
  switch (value.kind) {
    case 'set':
      if (!rowTrigger) fail('step.kind', 'A schedule has no row to set');
      return {
        kind: 'set',
        values: checkValues(value.values, db, rowTrigger, true, ctx.answered),
        when,
      };
    case 'addRow': {
      if (!isId(value.databaseId)) fail('step.database', 'A new row names its database');
      const templateId = value.templateId ?? null;
      if (templateId !== null && !isId(templateId)) fail('step.database', 'Not a template id');
      // The target's properties are checked where it is held (always on the server).
      const into = value.databaseId === db.id ? db : target(value.databaseId as Id);
      return {
        kind: 'addRow',
        databaseId: value.databaseId as Id,
        templateId: templateId as Id | null,
        values: checkValues(value.values ?? {}, into, rowTrigger, false, ctx.answered),
        when,
      };
    }
    case 'notify': {
      const recipients = checkRecipients(value, ctx);
      if (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE)
        fail('step.message', 'A notice is at most 1,000 characters');
      return {
        kind: 'notify',
        ...recipients,
        message: value.message as string,
        when,
      };
    }
    case 'wait':
      return { kind: 'wait', until: checkWait(value.until, ctx), when };
    case 'branch': {
      if (!rowTrigger) fail('step.kind', 'A schedule has no row to branch on');
      if (ctx.level >= MAX_NESTING) fail('step.nesting', 'Steps nest at most three levels');
      if (
        !Array.isArray(value.branches) ||
        value.branches.length < 1 ||
        value.branches.length > MAX_BRANCHES
      )
        fail('step.branch', 'A branch has 1 to 10 paths besides "otherwise"');
      const branches = (value.branches as unknown[]).map((path) => {
        if (!isObject(path)) return fail('step.branch', 'A path is an object');
        return {
          when: checkGroup(path.when, 'step.branch'),
          steps: checkList(path.steps, ctx, ctx.answered),
        };
      });
      return {
        kind: 'branch',
        branches,
        otherwise: checkList(value.otherwise, ctx, ctx.answered),
        when,
      };
    }
    case 'approval': {
      if (ctx.level >= MAX_NESTING) fail('step.nesting', 'Steps nest at most three levels');
      const recipients = checkRecipients(value, ctx);
      if (value.mode !== 'any' && value.mode !== 'all')
        fail('step.approval', 'An approval goes on by any one answer or by all');
      if (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE)
        fail('step.message', 'A notice is at most 1,000 characters');
      if (!wholeNumber(value.deadlineMinutes, 1, MAX_WAIT_MINUTES))
        fail('step.approval', 'A deadline is whole minutes, at most 90 days');
      return {
        kind: 'approval',
        ...recipients,
        mode: value.mode as 'any' | 'all',
        message: value.message as string,
        deadlineMinutes: value.deadlineMinutes as number,
        approved: checkList(value.approved, ctx, true),
        rejected: checkList(value.rejected, ctx, true),
        noAnswer: checkList(value.noAnswer, ctx, false),
        when,
      };
    }
    case 'webhook': {
      if (!isId(value.webhookId)) fail('step.webhook', 'A webhook step names its webhook');
      const properties = value.properties ?? [];
      if (!Array.isArray(properties) || properties.length > MAX_STEP_VALUES * 2)
        fail('step.webhook', 'At most 100 properties');
      for (const id of properties as unknown[])
        if (!live(db, id)) fail('step.webhook', `No property ${String(id)}`);
      if (!rowTrigger && (properties as unknown[]).length)
        fail('step.webhook', 'A schedule has no row whose properties to send');
      return {
        kind: 'webhook',
        webhookId: value.webhookId as Id,
        properties: [...new Set(properties as PropertyId[])],
        when,
      };
    }
    default:
      return fail('step.kind', 'Not a step');
  }
}

/**
 * The rule as it is kept, or an `AutomationError` naming what is wrong: its trigger, conditions
 * and steps checked against the database's properties as they are now (a deleted property is not
 * one a rule may name). `target` gives another database a step adds rows to, when it is held (the
 * server always holds it; a device may not, and leaves that to the server). The server sets
 * `authorId`, `version` and the times; the check keeps whatever the payload says of them.
 */
export function checkAutomation(
  value: unknown,
  db: DatabaseRecord,
  target: (id: Id) => DatabaseRecord | null = () => null,
): AutomationRecord {
  if (!isObject(value)) return fail('rule', 'A rule is an object');
  if (!isId(value.id)) fail('rule', 'A rule has an id');
  if (value.databaseId !== db.id) fail('rule', 'A rule stays with its database');
  if (typeof value.name !== 'string' || value.name.length > MAX_NAME)
    fail('name', 'A name of at most 200 characters');
  if (typeof value.enabled !== 'boolean') fail('rule', 'A rule is on or off');
  const trigger = checkTrigger(value.trigger, db);
  const rowTrigger = trigger.kind !== 'schedule';
  const conditions =
    value.conditions === undefined || value.conditions === null
      ? null
      : checkGroup(value.conditions, 'conditions');
  if (conditions && !rowTrigger) fail('conditions', 'A schedule has no row to put conditions on');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS)
    fail('steps', 'A rule has 1 to 20 steps');
  const ctx: StepCtx = { db, rowTrigger, target, answered: false, level: 1, count: { n: 0 } };
  const steps = (value.steps as unknown[]).map((step) => checkStep(step, ctx));
  const rule: AutomationRecord = {
    id: value.id as Id,
    workspaceId: String(value.workspaceId ?? db.workspaceId),
    databaseId: db.id,
    name: value.name as string,
    enabled: value.enabled as boolean,
    trigger,
    conditions,
    steps,
    authorId: isId(value.authorId) ? value.authorId : null,
    version: typeof value.version === 'number' ? value.version : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
  if (JSON.stringify(definitionOf(rule)).length > MAX_AUTOMATION_CHARS)
    fail('size', 'The rule is too large');
  return rule;
}

/** What the server stores as a rule's definition: its name, trigger, conditions and steps. */
export function definitionOf(rule: AutomationRecord) {
  return { name: rule.name, trigger: rule.trigger, conditions: rule.conditions, steps: rule.steps };
}

// ---------------------------------------------------------------------------------------------
// Which change starts a rule

/**
 * A change to a row, as the server writes it for the rules (DATA_MODEL.md, `AutomationEvents`):
 * a row added, its values changed (the title as `title`), or a button pressed. `before` and
 * `after` hold the changed properties' values (absent: empty).
 */
export interface RowChange {
  kind: 'added' | 'changed' | 'button';
  changed: PropertyId[];
  before: Record<PropertyId, Value>;
  after: Record<PropertyId, Value>;
  /** The button pressed. */
  propertyId?: PropertyId | null;
  /** Phase 16: the form view whose answer added the row (a row added only). */
  formId?: Id | null;
}

/** A row holding `values` (the title among them), for reading a trigger's from and to. */
function valuesRow(db: DatabaseRecord, values: Record<PropertyId, Value>): RowRecord {
  const { [TITLE_PROPERTY]: title, ...rest } = values;
  return {
    id: '',
    workspaceId: db.workspaceId,
    sectionId: '',
    parentPageId: db.id,
    orderKey: 'a0',
    kind: 'row' as const,
    title: typeof title === 'string' ? title : '',
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: '',
    updatedAt: '',
    trashedAt: null,
    trashRootId: null,
    databaseId: db.id,
    values: rest,
    versions: {},
    computed: {},
    computedVersion: null,
    createdBy: null,
    updatedBy: null,
  };
}

/**
 * Whether the change starts a rule of this trigger: a row added starts `rowAdded`; a change of a
 * watched property (or, with none named, of the title or any stored property not deleted) starts
 * `propertyChanged` when its old value passes `from` and its new one `to` (each read as a filter
 * condition on that property, so an operator that does not fit the type passes); a press starts
 * the `button` trigger naming its property; a row added by a form's answer starts `formAnswered`
 * naming that form (and `rowAdded` too). Dates and schedules are reached by time, never by a
 * change. A property deleted since the rule was saved starts nothing.
 */
export function changeStarts(
  trigger: AutomationTrigger,
  db: DatabaseRecord,
  change: RowChange,
  ctx: QueryContext,
): boolean {
  switch (trigger.kind) {
    case 'rowAdded':
      return change.kind === 'added';
    case 'formAnswered':
      return change.kind === 'added' && !!change.formId && change.formId === trigger.viewId;
    case 'button':
      return (
        change.kind === 'button' &&
        change.propertyId === trigger.propertyId &&
        !!live(db, trigger.propertyId)
      );
    case 'propertyChanged': {
      if (change.kind !== 'changed') return false;
      if (trigger.propertyId === null)
        return change.changed.some((id) => {
          const def = live(db, id);
          return !!def && writable(def);
        });
      const def = live(db, trigger.propertyId);
      if (!def || !writable(def) || !change.changed.includes(def.id)) return false;
      const passes = (side: TriggerValue | null | undefined, values: Record<PropertyId, Value>) =>
        !side ||
        matchesFilter(
          db,
          valuesRow(db, def.id in values ? { [def.id]: values[def.id] } : {}),
          { kind: 'condition', propertyId: def.id, operator: side.operator, value: side.value },
          ctx,
        );
      return passes(trigger.from, change.before) && passes(trigger.to, change.after);
    }
    default:
      return false;
  }
}
