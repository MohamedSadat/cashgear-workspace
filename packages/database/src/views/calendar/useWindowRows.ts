// A calendar's and a timeline's rows (Phase 9): a query of their own (requests.ts), every page of it
// fetched up to a bound, and while a new window's first page comes the last window's rows kept
// drawn (a scroll or a turned month does not empty the view for a moment).
import type { RowRecord } from '@cgw/workspace';
import { useEffect, useRef } from 'react';
import { LOCAL_ROW_LIMIT } from '../../core';
import { useRowSource } from '../../context';
import type { DatabaseHost, RowRequest, RowSnapshot, RowSource } from '../../host';

const NONE: RowRecord[] = [];

export interface WindowRows {
  source: RowSource | null;
  snapshot: RowSnapshot;
  /** The rows to draw: the source's, or the last ones while its first page comes. */
  rows: RowRecord[];
  /** Pages are still coming (under the bound). */
  fetching: boolean;
  /** The bound was reached with rows left: only the first `limit` are drawn. */
  capped: boolean;
}

/**
 * The rows of a query (null: none), every page fetched until `limit` rows are in (`Infinity` for
 * a list that loads by its own scrolling: then nothing more is fetched here).
 */
export function useWindowRows(
  host: DatabaseHost,
  databaseId: string,
  request: RowRequest | null,
  limit = LOCAL_ROW_LIMIT,
): WindowRows {
  const { source, snapshot } = useRowSource(host, databaseId, request);
  const loaded = snapshot.rows.length;
  useEffect(() => {
    if (!source || !Number.isFinite(limit)) return;
    if (snapshot.complete || snapshot.loading || snapshot.error) return;
    if (loaded < limit) source.loadMore();
  }, [source, snapshot.complete, snapshot.loading, snapshot.error, loaded, limit]);
  const last = useRef<RowRecord[]>(NONE);
  const waiting = !request || (snapshot.loading && loaded === 0);
  if (!waiting || !request) last.current = request ? snapshot.rows : NONE;
  const rows = waiting && request ? last.current : snapshot.rows;
  return {
    source,
    snapshot,
    rows,
    fetching: !!request && !snapshot.complete && loaded < limit && !snapshot.error,
    capped: !snapshot.complete && Number.isFinite(limit) && loaded >= limit,
  };
}
