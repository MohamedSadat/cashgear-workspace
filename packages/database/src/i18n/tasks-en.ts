// Sub-items' and dependencies' words (`database.tasks.*`; Phase 17): the switches in a view's
// Properties menu, a row's sub-items in the table, a parent's count on a board and a list, and the
// rows a move took along. Merged into the app's instance by the first of them drawn
// (`tasks/words.ts`), never with the views' catalogue at start. `tasks-ar.ts` has the same keys.
export const tasksEn = {
  title: 'Tasks',
  subItems: 'Sub-items',
  subItemsHelp: 'A table nests each row’s sub-items under it, up to five levels.',
  dependencies: 'Dependencies',
  dependenciesHelp: 'A timeline draws an arrow from each row to the rows it blocks.',
  by: 'By',
  off: 'Off',
  newSubItems: 'New: Parent and Sub-items',
  newDependencies: 'New: Blocked by and Blocking',
  parent: 'Parent',
  children: 'Sub-items',
  blockedBy: 'Blocked by',
  blocking: 'Blocking',
  pair: '{{name}} and {{reverse}}',
  shift: 'Moving a row’s dates moves the rows it blocks by as many days',
  expand: 'Show the sub-items of {{title}}',
  collapse: 'Hide the sub-items of {{title}}',
  count: 'Sub-items: {{number}}',
  context: 'Shown for a sub-item that matches',
  moved: 'The rows it blocks moved too: {{number}}.',
  // A timeline's arrows (Track U20): what a bar's description says of them.
  blockedByThese: 'Blocked by {{titles}}',
  blockingThese: 'Blocking {{titles}}',
  conflictBlockedBy: 'Starts before {{titles}} ends',
  conflictBlocking: '{{titles}} starts before this ends',
};
