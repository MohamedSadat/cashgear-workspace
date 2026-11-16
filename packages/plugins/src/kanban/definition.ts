// `cashgear.kanban`, version 1 (INTEGRATIONS.md, Plugin blocks): the definition; the view loads with
// the first board on screen.
import { lazy } from 'react';
import type { BlockDefinition } from '../types';
import { KANBAN_TYPE, KANBAN_VERSION, kanbanProps, type KanbanProps } from './props';

export const kanban: BlockDefinition<KanbanProps> = {
  type: KANBAN_TYPE,
  version: KANBAN_VERSION,
  props: kanbanProps,
  slash: {
    label: { en: 'Kanban board', ar: 'لوحة كانبان' },
    icon: 'board',
    keywords: [
      'kanban board columns cards status select database',
      'كانبان لوحة أعمدة بطاقات حالة اختيار قاعدة بيانات',
    ],
  },
  toPlainText: (props, { language, pageTitle }) => {
    const title = props.databaseId ? pageTitle?.(props.databaseId) : undefined;
    const word = language === 'ar' ? 'لوحة' : 'Board';
    return title ? `${word}: ${title}` : word;
  },
  render: lazy(() => import('./KanbanBlock')),
};
