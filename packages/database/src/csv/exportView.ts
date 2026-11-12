// Export of a view as CSV (contract section 2, `rowsToCsv`): the view's rows in its order (its
// filter and sorts; no toolbar search, no grouping), its shown properties as columns. A database
// this device holds in full is written here; a larger one in a synced workspace is written by the
// server's export route (`host.exportCsv`); offline, the rows on this device are written and the
// caller is told it is partial. The file is saved through `host.saveFile` (the desktop's dialog),
// else downloaded by the browser.
import type { Id, RowRecord } from '@cgw/workspace';
import { rowsToCsv, type CsvLookups } from '@cgw/workspace';
import type { DatabaseRecord, ViewRecord } from '../core';
import type { DatabaseHost, RowSnapshot, RowSource } from '../host';

/** Rows fetched by one export at most when it must page through them itself. */
export const EXPORT_LIMIT = 50_000;

/** The next snapshot that is not loading (at once when the current one is not). */
export function settled(source: RowSource): Promise<RowSnapshot> {
  return new Promise((resolve) => {
    const now = source.snapshot();
    if (!now.loading) return resolve(now);
    const stop = source.subscribe(() => {
      const next = source.snapshot();
      if (next.loading) return;
      stop();
      resolve(next);
    });
  });
}

/** Names the CSV writes for people, related rows and files, and this device's computed cells. */
export function csvLookups(
  host: DatabaseHost,
  rows: readonly RowRecord[],
  database: DatabaseRecord,
): CsvLookups {
  const people = Object.fromEntries(host.people().map((p) => [p.id, p.name]));
  const related: Record<Id, string> = {};
  const files: Record<Id, string> = {};
  for (const def of database.properties) {
    if (def.type !== 'relation' && def.type !== 'files') continue;
    for (const row of rows) {
      const ids = row.values[def.id];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (def.type === 'relation') related[id] ??= host.pageTitle(id) ?? '';
        else files[id] ??= host.assets?.info(id)?.fileName ?? '';
      }
    }
  }
  return { people, rows: related, files, computed: (row) => row.computed };
}

/** A name a file may have on every system: the database's and the view's, without `\/:*?"<>|`. */
export function exportFileName(database: string, view: string): string {
  const base =
    [database, view]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' - ') || 'export';
  const safe = [...base].map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('');
  return `${safe.replace(/\s+/g, ' ').trim()}.csv`;
}

/** Saves a file the person asked for. */
export async function saveFile(host: DatabaseHost, name: string, data: Blob): Promise<void> {
  if (host.saveFile) return host.saveFile(name, data);
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ExportResult {
  /** Rows written (null when the server wrote the file). */
  count: number | null;
  /** Only the rows on this device were written (offline, or the database is larger). */
  partial: boolean;
}

/** Writes a view's rows as CSV and saves the file. */
export async function exportView(
  host: DatabaseHost,
  database: DatabaseRecord,
  view: ViewRecord,
  fileName: string,
): Promise<ExportResult> {
  const source = host.rows(database.id, {
    viewId: view.id,
    spec: { filter: view.config.filter, sorts: view.config.sorts, group: null },
    pageSize: 1000,
  });
  try {
    let snapshot = await settled(source);
    if (!snapshot.complete && !snapshot.localOnly && host.exportCsv) {
      const blob = await host.exportCsv(database.id, view.id);
      await saveFile(host, fileName, blob);
      return { count: null, partial: false };
    }
    while (
      !snapshot.complete &&
      !snapshot.localOnly &&
      !snapshot.error &&
      snapshot.rows.length < EXPORT_LIMIT
    ) {
      const before = snapshot.rows.length;
      source.loadMore();
      snapshot = await settled(source);
      if (snapshot.rows.length === before) break;
    }
    if (snapshot.error && !snapshot.rows.length) throw new Error(snapshot.error);
    const csv = rowsToCsv(database, view, snapshot.rows, csvLookups(host, snapshot.rows, database));
    await saveFile(host, fileName, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const count = snapshot.rows.filter((r) => !r.isTemplate && !r.trashedAt).length;
    return { count, partial: !snapshot.complete };
  } finally {
    source.close();
  }
}
