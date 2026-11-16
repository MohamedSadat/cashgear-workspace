// What the notice after a paste or a clear says: what changed, the rows added, and each kind of
// cell left as it was (values a property could not read, computed cells, cells past the last
// column, rows past the limit or still to load), each only when there are some.
import type { DbT } from '../i18n';
import type { CellCounts } from './paste';

const count = (n: number, locale: string) => n.toLocaleString(locale);

export function cellReport(
  kind: 'paste' | 'clear',
  counts: CellCounts,
  added: number,
  t: DbT,
  locale: string,
  rowsStillToLoad: boolean,
): string {
  const parts = [
    t(kind === 'paste' ? 'cells.pasted' : 'cells.cleared', {
      count: count(counts.changed, locale),
    }),
  ];
  if (added) parts.push(t('cells.rowsAdded', { count: count(added, locale) }));
  if (counts.refused) parts.push(t('cells.refused', { count: count(counts.refused, locale) }));
  if (counts.computed) parts.push(t('cells.computed', { count: count(counts.computed, locale) }));
  if (counts.outside) parts.push(t('cells.outside', { count: count(counts.outside, locale) }));
  if (counts.rowsLeftOut)
    parts.push(
      t(rowsStillToLoad ? 'cells.rowsNotLoaded' : 'cells.rowsOverLimit', {
        count: count(counts.rowsLeftOut, locale),
        limit: count(1000, locale),
      }),
    );
  return parts.join(' ');
}
