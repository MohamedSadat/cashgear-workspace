// "Add an automation" from a button property's menu (Phase 15): the menu closes, and the views'
// toolbar button (always there while automations are) opens the dialog on a new rule for it.
import type { Id } from '@cgw/workspace';
import type { AutomationTrigger } from '../core';

type Listener = (databaseId: Id, start: AutomationTrigger) => void;

const listeners = new Set<Listener>();

export function openAutomations(databaseId: Id, start: AutomationTrigger) {
  for (const listener of listeners) listener(databaseId, start);
}

export function onOpenAutomations(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
