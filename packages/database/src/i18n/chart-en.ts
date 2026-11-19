// The chart's English strings (Phase 12): the chart block's words, moved from `@cgw/plugins` as
// they were, and the chart view's. Not part of `en.ts`: they are merged into the `database.chart`
// section the first time a chart draws (`views/chart/words.ts`), so the initial JavaScript holds
// none of them. `chart-ar.ts` has exactly the same keys; its type is derived from this one.
export const chartEn = {
  // The chart block's (`cashgear.chart`), as it had them.
  name: 'Chart',
  label: 'Chart of {{title}}',
  kind: 'Chart',
  kinds: { bar: 'Bar', line: 'Line', pie: 'Pie', number: 'Number' },
  groupBy: 'Group by',
  groupNone: 'Nothing (one number)',
  measure: 'Measure',
  count: 'Count of rows',
  sum: 'Sum',
  average: 'Average',
  measureOf: 'Of',
  noNumber: 'No number property',
  title: 'Title',
  titlePlaceholder: 'From the measure and the group',
  titles: {
    count: 'Count by {{group}}',
    sum: 'Sum of {{measure}} by {{group}}',
    average: 'Average of {{measure}} by {{group}}',
    countAll: 'Count of rows',
    sumAll: 'Sum of {{measure}}',
    averageAll: 'Average of {{measure}}',
  },
  partial: 'Based on the first {{count}} rows.',
  chooseGroup: 'Choose a property to group by in the settings.',
  noRows: 'No rows to chart.',
  noValue: 'None',
  plainText: 'Chart: {{title}}',
  // Phase 12: a share link's refusal of a chart grouped or measured by what a link never shares
  // (people, a formula of a person, a rollup of rows out of its scope); the view's and the block's.
  hidden:
    'This chart isn’t shown by this link: it’s grouped or measured by people, or by values a link doesn’t share.',
  // The chart view's own (Phase 12).
  view: {
    chooseGroup: 'A chart draws its rows by a group: choose a property in Group, in the toolbar.',
    noGroup: 'This chart has no property to group by yet.',
    groupHint: 'Its points are the view’s groups: Group, in the toolbar.',
    drawing: 'Drawing the chart…',
  },
  // Phase 12: `CgChart`'s own words (its defaults, which are English), for the block and the view;
  // `{series}`, `{argument}`, `{value}` and `{count}` are the library's own placeholders.
  canvas: {
    chart: 'Chart',
    series: 'series',
    point: 'data point',
    tooSmall: 'Not enough room to draw this chart',
    table: 'Chart data',
    tableToggle: 'Chart data',
    argument: 'Category',
    percentage: 'Percentage',
    legend: 'Chart series',
    thousand: 'K',
    million: 'M',
    billion: 'B',
    seriesShown: '{series} shown',
    seriesHidden: '{series} hidden',
    pointSelected: '{series}, {argument}, {value} selected',
    selectionCleared: 'Selection cleared',
    pointLabel: '{series}, {argument}, {value}',
    seriesLabel: '{series}, {count} points',
    keyboard:
      'Use the left and right arrow keys to move between data points, up and down to change series, Enter or Space to activate, and Escape to dismiss the tooltip.',
  },
};
