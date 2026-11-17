// Workbooks in the workspace's export (Phase 9, M9.3; export format version 3, exchange.ts). A
// workbook lives in the account, never on this device, so an export reads each one the exporter
// may read from the server (its record, then its newest version's bytes by a short signed URL),
// and an import into the account makes each again there: the record with the id its sheet blocks
// were already given, then the bytes as its first version (`If-None-Match: *`, as Sheet's first
// save). Nothing here touches the store.
import { getSigned } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import type { WorkbookApi } from '../sheet/api';
import type { ExportWorkbook, ExportWorkbooks, PendingWorkbook } from './exchange';

type ReadApi = Pick<WorkbookApi, 'list' | 'content'>;
type MakeApi = Pick<WorkbookApi, 'create' | 'uploadVersion'>;

/**
 * Reads the workbooks for an export of the workspace: every one the server lists for the exporter
 * (it lists only those they may read, trashed ones not) that has a version, or of those, the ids
 * wanted (the workbooks an export of some pages shows; one the exporter may not read is not
 * listed, and so left out). The list failing throws; a workbook whose bytes cannot be read is
 * counted in `failed` and the export goes on without it.
 */
export function workbookReader(
  api: ReadApi,
  workspaceId: Id,
  fetchSigned: (url: string) => Promise<Response> = getSigned,
): (wanted: ReadonlySet<Id> | null) => Promise<ExportWorkbooks> {
  return async (wanted) => {
    const listed = await api.list(workspaceId);
    const chosen = listed.filter((w) => w.versionId && (!wanted || wanted.has(w.id)));
    const workbooks: ExportWorkbook[] = [];
    let failed = 0;
    for (const workbook of chosen) {
      try {
        const content = await api.content(workbook.id);
        if (!content.readUrl) continue;
        const response = await fetchSigned(content.readUrl);
        if (!response.ok) {
          failed++;
          continue;
        }
        workbooks.push({
          id: workbook.id,
          name: workbook.name,
          bytes: new Uint8Array(await response.arrayBuffer()),
        });
      } catch {
        failed++;
      }
    }
    return { workbooks, failed };
  };
}

export interface MadeWorkbooks {
  made: number;
  failed: number;
}

/**
 * Makes an import's workbooks in the account, once its workspace is there: each record by the id
 * its blocks point at, then its bytes as version 1. One that fails is counted and the rest go on;
 * its blocks then say the workbook cannot be opened.
 */
export async function makeWorkbooks(
  api: MakeApi,
  workspaceId: Id,
  pending: readonly PendingWorkbook[],
): Promise<MadeWorkbooks> {
  let made = 0;
  let failed = 0;
  for (const workbook of pending) {
    try {
      await api.create(workspaceId, workbook.name.slice(0, 200), workbook.id);
      await api.uploadVersion(workbook.id, workbook.bytes, null);
      made++;
    } catch (error) {
      console.warn('A workbook of the import could not be made:', error);
      failed++;
    }
  }
  return { made, failed };
}
