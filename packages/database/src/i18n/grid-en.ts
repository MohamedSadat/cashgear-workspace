// The table's words for a screen reader (Phase 12, M12.3): what its live region says when a cell's
// editing starts, is saved and is cancelled, and when the active cell reaches a "New" line (which
// the accessibility tree does not hold). Not part of `en.ts`: they are merged into the
// `database.grid` section the first time a table draws (`table/words.ts`), so the initial
// JavaScript holds none of them. `grid-ar.ts` has exactly the same keys; its type is derived from
// this one.
export const gridEn = {
  editing: 'Editing: {{property}}, {{title}}.',
  saved: 'Saved: {{property}}, {{title}}.',
  cancelled: 'Edit cancelled: {{property}}, {{title}}.',
  newRow: 'New row: press Enter to add one.',
  newRowIn: 'New row in {{name}}: press Enter to add one.',
};
