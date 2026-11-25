// "Add an automation" from a button property's menu (Phase 15): the menu closes, and the views'
// toolbar button (always there while automations are) opens the dialog on a new rule for it.
// Phase 17: "Repeat a template" and a date's "Remind people" too, with a name and steps to start
// from.
import type { Id } from '@cgw/workspace';
import type { AutomationStep, AutomationTrigger } from '../core';

/** What a new rule starts from besides its trigger. */
export interface RuleStart {
  name?: string;
  steps?: AutomationStep[];
}

type Listener = (databaseId: Id, start: AutomationTrigger, extra?: RuleStart) => void;

const listeners = new Set<Listener>();

export function openAutomations(databaseId: Id, start: AutomationTrigger, extra?: RuleStart) {
  for (const listener of listeners) listener(databaseId, start, extra);
}

export function onOpenAutomations(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
