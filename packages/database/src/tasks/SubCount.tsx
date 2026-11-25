// A parent's count of sub-items (Phase 17), on a board's card and a list's line: drawn only when
// the database has sub-items switched on and the row has any.
import type { RowRecord } from '@cgw/workspace';
import type { CellEnv } from '../cells/env';
import { subItemCount } from './model';
import { useTaskT } from './words';

export function SubCount({ row, env }: { row: RowRecord; env: CellEnv }) {
  const database = env.host.database(row.databaseId);
  const count = database ? subItemCount(database, row.values) : 0;
  return count > 0 ? <SubCountText count={count} locale={env.locale} /> : null;
}

function SubCountText({ count, locale }: { count: number; locale: string }) {
  const tt = useTaskT();
  return (
    <span className="cgw-db-sub-count">
      {tt('count', { number: new Intl.NumberFormat(locale).format(count) })}
    </span>
  );
}
