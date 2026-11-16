// `cashgear.chart`, version 1 (INTEGRATIONS.md, Plugin blocks): the definition, small enough for
// the frame's bundle; the view loads with the first chart on screen.
import { lazy } from 'react';
import type { BlockDefinition } from '../types';
import { CHART_TYPE, CHART_VERSION, chartProps, type ChartProps } from './props';

export const chart: BlockDefinition<ChartProps> = {
  type: CHART_TYPE,
  version: CHART_VERSION,
  props: chartProps,
  slash: {
    label: { en: 'Chart', ar: 'مخطط' },
    icon: 'chart',
    keywords: [
      'chart graph bar line pie number count sum average database',
      'مخطط رسم بياني أعمدة خطي دائري رقم عدد مجموع متوسط قاعدة بيانات',
    ],
  },
  toPlainText: (props, { language, pageTitle }) => {
    const title = props.title ?? (props.databaseId ? pageTitle?.(props.databaseId) : undefined);
    const word = language === 'ar' ? 'مخطط' : 'Chart';
    return title ? `${word}: ${title}` : word;
  },
  render: lazy(() => import('./ChartBlock')),
};
