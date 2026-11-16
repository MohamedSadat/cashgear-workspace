// What the table does with a selection of cells (Phase 8, M8.3): copy it (the clipboard's text
// and HTML), paste into it, clear it, and the notice after a paste or a clear with its Undo. Each
// paste, clear and Undo is one batch of operations through `host.apply`; the views never save or
// load anything themselves. Handlers read the table as it is when they run (a ref), so the
// commands are stable across its renders.
import { keysBetween, type RowRecord } from '@cgw/workspace';
import { useCallback, useRef, useState } from 'react';
import type { CellEnv } from '../cells/env';
import { copyCells, clipFor } from '../clipboard/copy';
import {
  PASTE_ROW_LIMIT,
  planClear,
  planOperations,
  planPaste,
  undoOf,
  undoOperations,
  type CellPlan,
  type PasteSource,
} from '../clipboard/paste';
import { cellReport } from '../clipboard/report';
import { parseHtmlTable, parseTsv } from '../clipboard/tsv';
import type { DatabaseRecord, PropertyDef, ViewRecord } from '../core';
import type { DatabaseHost, RowSnapshot } from '../host';
import type { DbT } from '../i18n';
import { valuesForNewRow } from '../model/newRow';
import type { CellNoticeState } from './CellNotice';
import type { TableItem } from './items';
import type { GridPos } from './navigation';
import { rowItemsIn, type CellRect } from './selection';

export interface CellCommandsInput {
  host: DatabaseHost;
  database: DatabaseRecord;
  view: ViewRecord;
  snapshot: RowSnapshot;
  items: readonly TableItem[];
  columns: readonly PropertyDef[];
  editable: boolean;
  env: CellEnv;
  t: DbT;
  locale: string;
  /** What is selected now (the active cell alone, when nothing more is); null on the header row. */
  rect: CellRect | null;
  /** The selection is more than one cell. */
  ranged: boolean;
  /** Selects a rectangle (after a paste: what it wrote). */
  select(anchor: GridPos, active: GridPos): void;
  /** Says something through the table's live region. */
  say(text: string): void;
}

export interface CellCommands {
  /** The selection's cells for the clipboard, or null when it holds none. */
  copy(): { text: string; html: string } | null;
  paste(text: string, html: string): Promise<void>;
  /** Clears the selection's cells (Delete, Backspace). */
  clear(): Promise<void>;
  /** Takes the last paste or clear back while its notice offers it (Ctrl+Z on the table). */
  undo(): boolean;
  notice: CellNoticeState | null;
  closeNotice(): void;
}

const isRowItem = (item: TableItem | undefined): item is Extract<TableItem, { kind: 'row' }> =>
  item?.kind === 'row';

export function useCellCommands(input: CellCommandsInput): CellCommands {
  const ref = useRef(input);
  ref.current = input;
  const [notice, setNotice] = useState<CellNoticeState | null>(null);
  const counter = useRef(0);
  const undoRef = useRef<(() => void) | null>(null);
  const show = useCallback((next: Omit<CellNoticeState, 'id'>) => {
    undoRef.current = next.undo ?? null;
    setNotice({ ...next, id: ++counter.current });
  }, []);
  const closeNotice = useCallback(() => {
    undoRef.current = null;
    setNotice(null);
  }, []);

  /** Writes a plan as one batch, then says what it did and offers Undo; true once written. */
  const write = useCallback(
    async (kind: 'paste' | 'clear', plan: CellPlan, groupKey: string | null): Promise<boolean> => {
      const { host, database, view, t, locale, snapshot } = ref.current;
      const page = host.page(database.id);
      const workspaceId = database.workspaceId;
      const { ops, created } = planOperations(plan, {
        workspaceId,
        databaseId: database.id,
        sectionId: page?.sectionId ?? '',
        newId: () => host.newId(),
        orderKeys: (count) => {
          const first = host.rowOrderKey(database.id, 'end');
          return [first, ...keysBetween(first, null, count - 1)];
        },
        preset: valuesForNewRow(database, view.config, groupKey, host.me()?.id ?? null),
        now: new Date().toISOString(),
      });
      const report = cellReport(kind, plan.counts, created.length, t, locale, !snapshot.complete);
      if (!ops.length) {
        show({ text: report });
        return false;
      }
      try {
        await host.apply(ops);
      } catch {
        show({ text: t('cells.failed'), error: true });
        return false;
      }
      const undo = undoOf(plan, workspaceId, created);
      const takeBack = async () => {
        const now = ref.current;
        undoRef.current = null;
        const back = undoOperations(undo, (id) => {
          const found = now.host.page(id);
          return found && found.kind === 'row' ? (found as RowRecord) : null;
        });
        try {
          if (back.ops.length) await now.host.apply(back.ops);
        } catch {
          show({ text: now.t('cells.undoFailed'), error: true });
          return;
        }
        const done = now.t(created.length ? 'cells.undoneAdded' : 'cells.undone');
        show({
          text: back.kept
            ? `${done} ${now.t('cells.undoneKept', { count: back.kept.toLocaleString(now.locale) })}`
            : done,
        });
      };
      show({ text: report, undo: () => void takeBack() });
      return true;
    },
    [show],
  );

  const copy = useCallback(() => {
    const { rect, items, columns, database, env, t, locale, say } = ref.current;
    if (!rect) return null;
    const rows = rowItemsIn(rect, (i) => isRowItem(items[i])).map(
      (i) => (items[i] as Extract<TableItem, { kind: 'row' }>).row,
    );
    const defs = columns.slice(rect.left, rect.right + 1);
    if (!rows.length || !defs.length) return null;
    const made = copyCells(database.id, rows, defs, env);
    say(t('cells.copied', { count: made.cells.toLocaleString(locale) }));
    return { text: made.text, html: made.html };
  }, []);

  const paste = useCallback(
    async (text: string, html: string) => {
      const {
        rect,
        items,
        columns,
        database,
        editable,
        snapshot,
        ranged,
        t,
        select,
        host,
        locale,
      } = ref.current;
      if (!editable) {
        show({ text: t('cells.readOnly'), error: true });
        return;
      }
      const clip = text ? clipFor(text) : null;
      let source: PasteSource | null = null;
      if (clip) source = { kind: 'clip', clip };
      else if (text)
        source = { kind: 'text', rows: parseTsv(text).map((r) => r.map((s) => ({ text: s }))) };
      else if (html) {
        const rows = parseHtmlTable(html);
        if (rows) source = { kind: 'text', rows };
      }
      const height = source ? (source.kind === 'clip' ? source.clip.cells : source.rows).length : 0;
      if (!source || !height) {
        show({ text: t('cells.nothing') });
        return;
      }
      const start = rect ?? { top: 0, bottom: 0, left: 0, right: 0 };
      const fill = ranged
        ? {
            rows: rowItemsIn(start, (i) => isRowItem(items[i])).length,
            cols: start.right - start.left + 1,
          }
        : null;
      const single =
        (source.kind === 'clip' ? source.clip.cells : source.rows).every((r) => r.length <= 1) &&
        height === 1;
      const need = single && fill ? Math.max(height, fill.rows) : height;
      // The rows from the rectangle's first one down, as the view lists them (across groups).
      const rows: RowRecord[] = [];
      const rowItems: number[] = [];
      let groupKey: string | null = null;
      for (let i = start.top; i < items.length && rows.length < need; i++) {
        const item = items[i];
        if (!isRowItem(item)) continue;
        rows.push(item.row);
        rowItems.push(i);
        groupKey = item.group;
      }
      const plan = planPaste({
        database,
        columns: columns.slice(start.left),
        rows,
        source,
        fill,
        maxNewRows: snapshot.complete ? PASTE_ROW_LIMIT : 0,
        // Spreadsheets show values in the device's language, which may not be the interface's.
        reading: {
          locale: (typeof navigator !== 'undefined' && navigator.language) || locale,
          people: host.people(),
        },
      });
      if (!(await write('paste', plan, groupKey))) return;
      // What was written stays selected (the rows added come after the last one).
      const lastExisting = Math.min(plan.size.rows, rows.length) - 1;
      const lastItem =
        lastExisting >= 0
          ? rowItems[lastExisting] + Math.max(0, plan.size.rows - rows.length)
          : start.top;
      select(
        { item: start.top, col: start.left },
        { item: lastItem, col: start.left + Math.max(0, plan.size.cols - 1) },
      );
    },
    [show, write],
  );

  const clear = useCallback(async () => {
    const { rect, items, columns, editable, t } = ref.current;
    if (!rect) return;
    if (!editable) {
      show({ text: t('cells.readOnly'), error: true });
      return;
    }
    const rows = rowItemsIn(rect, (i) => isRowItem(items[i])).map(
      (i) => (items[i] as Extract<TableItem, { kind: 'row' }>).row,
    );
    if (!rows.length) return;
    await write('clear', planClear(rows, columns.slice(rect.left, rect.right + 1)), null);
  }, [show, write]);

  const undo = useCallback(() => {
    const run = undoRef.current;
    if (!run) return false;
    run();
    return true;
  }, []);

  return { copy, paste, clear, undo, notice, closeNotice };
}
