// A row's automation runs (Phase 15, M15.3: its properties' "Runs"): a disclosure under the row's
// properties, read when opened, for whoever can read the row.
import type { Id } from '@cgw/workspace';
import { useCallback, useState } from 'react';
import type { AutomationsHost } from '../host';
import { stepNameOf } from './RuleEditor';
import { RunLog } from './RunLog';
import { useAutoT } from './words';
import './automations.css';

export function RowRuns({
  automations,
  databaseId,
  rowId,
}: {
  automations: AutomationsHost;
  databaseId: Id;
  rowId: Id;
}) {
  const { t: at } = useAutoT();
  const [open, setOpen] = useState(false);
  const load = useCallback(
    (before: string | null) => automations.rowRuns(databaseId, rowId, before),
    [automations, databaseId, rowId],
  );
  return (
    <details
      className="cgw-db-auto-row-runs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{at('log.rowTitle')}</summary>
      {open ? (
        automations.online() ? (
          <RunLog title={at('log.rowTitle')} of="row" load={load} stepName={stepNameOf(at)} />
        ) : (
          <p className="cgw-db-auto-note">{at('offline')}</p>
        )
      ) : null}
    </details>
  );
}
