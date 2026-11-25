// Sub-items' and dependencies' words (`database.tasks.*`; Phase 17), as the automations' are: not
// in the views' catalogue the shell merges at start, but merged into the app's instance the first
// time a table nests rows, a switch draws or a card counts sub-items, so the initial JavaScript
// holds none of them.
import type { i18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksAr } from '../i18n/tasks-ar';
import { tasksEn } from '../i18n/tasks-en';

/** A key of the tasks' words, without its `database.tasks.` prefix. */
export type TaskKey = keyof typeof tasksEn;
export type TaskT = (key: TaskKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export { tasksAr, tasksEn };

const added = new WeakSet<i18n>();

/** Merges the words into an instance's `database` section, once; later calls do nothing. */
export function addTaskWords(instance: i18n) {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle('en', 'translation', { database: { tasks: tasksEn } }, true, false);
  instance.addResourceBundle('ar', 'translation', { database: { tasks: tasksAr } }, true, false);
}

/** The tasks' words in the interface language, merged first (synchronous, idempotent). */
export function useTaskT(): TaskT {
  const { t, i18n } = useTranslation();
  addTaskWords(i18n);
  const loose = t as unknown as LooseT;
  return useCallback<TaskT>((key, options) => loose(`database.tasks.${key}`, options), [loose]);
}
