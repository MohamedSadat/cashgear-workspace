// The rule editor's model (Phase 15): a new rule and new steps, what a trigger and a step say in
// words, and what a refusal's reason or a run's outcome reads as. Pure: no React, no DOM.
import type { Id } from '@cgw/workspace';
import {
  TITLE_PROPERTY,
  type AutomationRecord,
  type AutomationStep,
  type AutomationTrigger,
  type DatabaseRecord,
  type PropertyDef,
  type StepKind,
  type TriggerKind,
  type ViewRecord,
} from '../core';
import { liveProperties, propertyOf } from '../model/properties';
import type { AutoKey, AutoT } from './words';

/** Properties a change of which a rule watches, and a step sets: the title and the stored types. */
export const WRITABLE = new Set([
  'title',
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'status',
  'person',
  'url',
  'email',
  'phone',
  'files',
  'relation',
]);

export const writable = (database: DatabaseRecord) =>
  liveProperties(database).filter((p) => WRITABLE.has(p.type));
export const dateProperties = (database: DatabaseRecord) =>
  liveProperties(database).filter((p) => p.type === 'date' || p.type === 'createdTime');
export const buttonProperties = (database: DatabaseRecord) =>
  liveProperties(database).filter((p) => p.type === 'button');
export const peopleProperties = (database: DatabaseRecord) =>
  liveProperties(database).filter(
    (p) => p.type === 'person' || p.type === 'createdBy' || p.type === 'lastEditedBy',
  );

/** Phase 16: the database's form views, which "a form is answered" names. */
export const formViews = (views: readonly ViewRecord[]) => views.filter((v) => v.type === 'form');

/** A trigger of the kind, with the database's first property (or form) that fits it. */
export function newTrigger(
  kind: TriggerKind,
  database: DatabaseRecord,
  forms: readonly ViewRecord[] = [],
): AutomationTrigger {
  switch (kind) {
    case 'formAnswered':
      return { kind, viewId: forms[0]?.id ?? '' };
    case 'rowAdded':
      return { kind };
    case 'propertyChanged':
      return { kind, propertyId: null, from: null, to: null };
    case 'date':
      return {
        kind,
        propertyId: dateProperties(database)[0]?.id ?? '',
        offsetMinutes: 0,
        at: null,
      };
    case 'schedule':
      return { kind, every: 'week', at: '09:00', weekday: 1, day: null };
    case 'button':
      return { kind, propertyId: buttonProperties(database)[0]?.id ?? '' };
  }
}

export function newStep(kind: StepKind, database: DatabaseRecord): AutomationStep {
  switch (kind) {
    case 'set':
      return { kind, values: {}, when: null };
    case 'addRow':
      return { kind, databaseId: database.id, templateId: null, values: {}, when: null };
    case 'notify':
      return { kind, people: [], groups: [], personProperties: [], message: '', when: null };
    case 'webhook':
      return { kind, webhookId: '', properties: [TITLE_PROPERTY], when: null };
  }
}

/** A new rule: off until it is saved on, a row added, one step that sets nothing yet. */
export function newRule(
  id: Id,
  workspaceId: Id,
  database: DatabaseRecord,
  trigger?: AutomationTrigger,
): AutomationRecord {
  return {
    id,
    workspaceId,
    databaseId: database.id,
    name: '',
    enabled: true,
    trigger: trigger ?? { kind: 'rowAdded' },
    conditions: null,
    steps: [newStep('set', database)],
    authorId: null,
    version: 0,
    createdAt: '',
    updatedAt: '',
  };
}

/** A step kind a rule of this trigger may hold (a schedule has no row to set). */
export const stepFits = (kind: StepKind, trigger: AutomationTrigger) =>
  trigger.kind !== 'schedule' || kind !== 'set';

const nameOf = (database: DatabaseRecord, id: string | null | undefined, at: AutoT) =>
  (id && propertyOf(database, id)?.name) || at('summary.missing');

/** "2 hours", "1 day": the offset in the largest whole unit, in the interface language. */
export function amountText(minutes: number, locale: string): string {
  const abs = Math.abs(minutes);
  const [value, unit] =
    abs % 1440 === 0 ? [abs / 1440, 'day'] : abs % 60 === 0 ? [abs / 60, 'hour'] : [abs, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

/** A weekday's name (0 Sunday) in the interface language. */
export const weekdayName = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 22 + day)),
  );

/** A trigger's value as a person reads it: an option by its name, a checkbox in words. */
export function triggerValueText(def: PropertyDef, value: unknown, at: AutoT): string {
  const option = (id: unknown) =>
    def.options?.find((o) => o.id === id)?.name ?? at('summary.deletedOption');
  if (def.type === 'select' || def.type === 'status') return option(value);
  if (def.type === 'multiSelect')
    return (Array.isArray(value) ? value : [value]).map(option).join(', ');
  if (def.type === 'checkbox') return at(value === true ? 'summary.checked' : 'summary.unchecked');
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** What starts the rule, in a sentence. */
export function triggerText(
  trigger: AutomationTrigger,
  database: DatabaseRecord,
  at: AutoT,
  locale: string,
  valueText: (def: PropertyDef, value: unknown) => string = (def, v) =>
    triggerValueText(def, v, at),
  /** Phase 16: a form view's name, by its id (a form gone is "a deleted form"). */
  formName: (viewId: Id) => string | undefined = () => undefined,
): string {
  switch (trigger.kind) {
    case 'formAnswered':
      return at('summary.formAnswered', {
        form: formName(trigger.viewId) || at('summary.missingForm'),
      });
    case 'rowAdded':
      return at('summary.rowAdded');
    case 'propertyChanged': {
      if (!trigger.propertyId) return at('summary.anyChanged');
      const property = nameOf(database, trigger.propertyId, at);
      const def = propertyOf(database, trigger.propertyId);
      if (trigger.to && trigger.to.value !== undefined && def)
        return at('summary.propertyChangedTo', {
          property,
          value: valueText(def, trigger.to.value),
        });
      return at('summary.propertyChanged', { property });
    }
    case 'date': {
      const property = nameOf(database, trigger.propertyId, at);
      if (!trigger.offsetMinutes) return at('summary.dateAt', { property });
      const amount = amountText(trigger.offsetMinutes, locale);
      return at(trigger.offsetMinutes < 0 ? 'summary.dateBefore' : 'summary.dateAfter', {
        property,
        amount,
      });
    }
    case 'schedule':
      if (trigger.every === 'day') return at('summary.daily', { time: trigger.at });
      if (trigger.every === 'week')
        return at('summary.weekly', {
          time: trigger.at,
          weekday: weekdayName(trigger.weekday ?? 1, locale),
        });
      return at('summary.monthly', { time: trigger.at, day: trigger.day ?? 1 });
    case 'button':
      return at('summary.button', { property: nameOf(database, trigger.propertyId, at) });
  }
}

/** What a step does, in a few words. */
export function stepText(
  step: AutomationStep,
  at: AutoT,
  names: {
    database(id: Id): string;
    person(id: Id): string;
    group(id: Id): string;
    property(id: string): string;
    webhook(id: Id): string;
  },
): string {
  switch (step.kind) {
    case 'set':
      return at('stepSummary.set', { count: Object.keys(step.values).length });
    case 'addRow':
      return at('stepSummary.addRow', { database: names.database(step.databaseId) });
    case 'notify': {
      const who = [
        ...step.people.map(names.person),
        ...step.groups.map(names.group),
        ...step.personProperties.map(names.property),
      ];
      return at('stepSummary.notify', { who: who.length ? who.join(', ') : at('notify.nobody') });
    }
    case 'webhook':
      return at('stepSummary.webhook', { webhook: names.webhook(step.webhookId) });
  }
}

const PROBLEMS = new Set([
  'name',
  'trigger',
  'trigger.property',
  'trigger.form',
  'conditions',
  'steps',
  'step.kind',
  'step.values',
  'step.value',
  'step.recipients',
  'step.message',
  'step.webhook',
  'step.database',
  'step.when',
  'size',
  'rule',
]);

/** A refusal's reason (`checkAutomation`'s) as the editor says it. */
export const problemKey = (reason: string): AutoKey =>
  `problems.${PROBLEMS.has(reason) ? reason : 'rule'}` as AutoKey;

const REASONS = new Set([
  'depth',
  'limit.rule',
  'limit.workspace',
  'author.access',
  'author.gone',
  'access.denied',
  'not.found',
  'row.gone',
  'webhook.access',
  'webhook.gone',
  'webhook.unreached',
]);

/** Why a run stopped or was skipped, in words. */
export function reasonText(reason: string | null | undefined, at: AutoT): string {
  if (!reason) return '';
  if (REASONS.has(reason)) return at(`reasons.${reason}` as AutoKey);
  return at('reasons.other', { code: reason });
}

/** A run's or a step's status, in words; an unknown one as it is. */
export function statusText(status: string, at: AutoT): string {
  return ['done', 'stopped', 'skipped', 'running'].includes(status)
    ? at(`status.${status}` as AutoKey)
    : status;
}

export function stepStatusText(status: string, at: AutoT): string {
  return ['done', 'skipped', 'failed', 'queued', 'delivered', 'pending'].includes(status)
    ? at(`stepStatus.${status}` as AutoKey)
    : status;
}
