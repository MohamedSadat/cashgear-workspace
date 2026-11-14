// The workbook dialogs, drawn once inside the frame (as the database dialogs are): "Existing
// workbook" (the workspace's readable workbooks, by name), "New workbook" (a name, then the
// block; Sheet makes the first version) and a block's "Import this range into a database". The
// dialogs load with their first request, not with the frame.
import type { Id } from '@cgw/workspace';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Cloud } from '../cloud/cloud';
import type { ShellDatabaseHost } from '../database/host';
import type { WorkspaceSession } from '../session';
import { listenForWorkbookRequests, type WorkbookRequest } from './requests';

const PickWorkbook = lazy(() =>
  import('./WorkbookPicker').then((m) => ({ default: m.PickWorkbook })),
);
const NewWorkbook = lazy(() =>
  import('./WorkbookPicker').then((m) => ({ default: m.NewWorkbook })),
);
const RangeImport = lazy(() => import('./RangeImport').then((m) => ({ default: m.RangeImport })));

export function WorkbookDialogs({
  session,
  cloud,
  databases,
}: {
  session: WorkspaceSession;
  cloud: Cloud | null;
  databases: ShellDatabaseHost;
}) {
  const [request, setRequest] = useState<WorkbookRequest | null>(null);
  const current = useRef<WorkbookRequest | null>(null);
  useEffect(
    () =>
      listenForWorkbookRequests((next) => {
        // One at a time: an earlier one still open is cancelled.
        current.current?.answer(null);
        current.current = next;
        setRequest(next);
      }),
    [],
  );
  if (!request) return null;
  const done = () => {
    current.current = null;
    setRequest(null);
  };
  return (
    <Suspense fallback={null}>
      {request.kind === 'pick' ? (
        <PickWorkbook
          session={session}
          cloud={cloud}
          onDone={(ref) => {
            done();
            request.answer(ref);
          }}
        />
      ) : request.kind === 'create' ? (
        <NewWorkbook
          session={session}
          cloud={cloud}
          onDone={(ref) => {
            done();
            request.answer(ref);
          }}
        />
      ) : (
        <RangeImport
          session={session}
          cloud={cloud}
          databases={databases}
          source={request.source}
          onDone={(made: { databaseId: Id } | null) => {
            done();
            request.answer(made);
          }}
        />
      )}
    </Suspense>
  );
}
