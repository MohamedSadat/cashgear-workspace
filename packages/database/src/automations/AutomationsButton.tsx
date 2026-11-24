// The views' toolbar button "Automations" (Phase 15): shown while the host gives automations (a
// synced workspace), it opens the database's automations, loaded with the dialog.
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Id } from '@cgw/workspace';
import type { AutomationTrigger } from '../core';
import { useDatabaseContext, useHost } from '../context';
import { onOpenAutomations } from './open';
import { useAutoT } from './words';

const AutomationsDialog = lazy(() =>
  import('./AutomationsDialog').then((m) => ({ default: m.AutomationsDialog })),
);

/** The dialog, open on its list or (from a button property) on a new rule for a trigger. */
export function AutomationsPanel({
  databaseId,
  start,
  onClose,
}: {
  databaseId: Id;
  start?: AutomationTrigger;
  onClose(): void;
}) {
  return (
    <Suspense fallback={null}>
      <AutomationsDialog databaseId={databaseId} start={start} onClose={onClose} />
    </Suspense>
  );
}

/** The toolbar's button; `hidden`, only what opens the dialog (a row's page, which has no toolbar). */
export function AutomationsButton({ databaseId, hidden }: { databaseId: Id; hidden?: boolean }) {
  const { host } = useDatabaseContext();
  const automations = useHost(host, () => host.automations);
  const { t: at } = useAutoT();
  const [open, setOpen] = useState<{ start?: AutomationTrigger } | null>(null);
  useEffect(
    () =>
      onOpenAutomations((id, start) => {
        if (id === databaseId) setOpen({ start });
      }),
    [databaseId],
  );
  if (!automations) return null;
  return (
    <>
      {hidden ? null : (
        <button
          type="button"
          className="cgw-icon-button"
          aria-label={at('buttonLabel')}
          title={at('button')}
          aria-haspopup="dialog"
          onClick={() => setOpen({})}
        >
          <span aria-hidden="true">⚡</span>
        </button>
      )}
      {open ? (
        <AutomationsPanel
          databaseId={databaseId}
          start={open.start}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
