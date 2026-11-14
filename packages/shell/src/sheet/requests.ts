// The workbook dialogs, asked for from anywhere (the editor's "Workbook" and "Existing workbook",
// a block's "Import this range into a database") and drawn once inside the frame
// (WorkbookDialogs.tsx): a request is an event with the answer's callback; with no frame
// listening, it answers null at once. No React and no editor here, so the frame's bundle can hold
// it.
import type { WorkbookRef } from '@cgw/editor';
import type { Id } from '@cgw/workspace';

/** What a block's range import starts from: the workbook, and the view it shows. */
export interface RangeImportSource {
  workbookId: Id;
  name: string;
  sheet: string | null;
  range: string | null;
  /** The page holding the block: a new database goes under it. */
  pageId: Id | null;
}

export type WorkbookRequest =
  | { kind: 'pick'; answer: (ref: WorkbookRef | null) => void }
  | { kind: 'create'; answer: (ref: WorkbookRef | null) => void }
  | {
      kind: 'import';
      source: RangeImportSource;
      answer: (made: { databaseId: Id } | null) => void;
    };

const requests = new EventTarget();
let listening = 0;

function ask<T>(make: (answer: (value: T | null) => void) => WorkbookRequest): Promise<T | null> {
  if (!listening) return Promise.resolve(null);
  return new Promise((resolve) => {
    requests.dispatchEvent(new CustomEvent('request', { detail: make(resolve) }));
  });
}

/** Asks which of the workspace's readable workbooks a block shows; null when cancelled. */
export const requestWorkbookPick = () =>
  ask<WorkbookRef>((answer) => ({ kind: 'pick', answer }) as WorkbookRequest);

/** Makes a workbook with no version (Sheet makes the first), named by the person; or null. */
export const requestNewWorkbook = () =>
  ask<WorkbookRef>((answer) => ({ kind: 'create', answer }) as WorkbookRequest);

/** Imports a workbook's range into a new or existing database (the CSV import); or null. */
export const requestRangeImport = (source: RangeImportSource) =>
  ask<{ databaseId: Id }>((answer) => ({ kind: 'import', source, answer }) as WorkbookRequest);

/** Listens for requests while the frame is drawn; returns the unsubscribe. */
export function listenForWorkbookRequests(take: (request: WorkbookRequest) => void): () => void {
  const listener = (event: Event) => take((event as CustomEvent<WorkbookRequest>).detail);
  requests.addEventListener('request', listener);
  listening++;
  return () => {
    listening--;
    requests.removeEventListener('request', listener);
  };
}
