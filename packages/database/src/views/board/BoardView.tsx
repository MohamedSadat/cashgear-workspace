// The board view: a column per group of the view's group property (select or status by default;
// any groupable one), each with its count, a "New" card preset to that group, and its cards: the
// title and the view's shown properties. Empty groups show (unless the rule hides them), hidden
// groups are listed at the end, a column can be collapsed. The board scrolls as one; each column
// draws only the cards inside the window (fixed heights worked out from each row, layout.ts).
//
// A card moves by pointer (`cgTrackDrag`: a copy follows the pointer and a `CgDropIndicator` shows
// where it lands; no card is drawn again during the drag) or by keyboard (Space picks it up, the
// arrows move it, Space drops it, Escape cancels). Into another column: one `row.update` of the
// group property (and a `page.move` when its place there needs a new order key); within a column:
// a `page.move` with `host.rowOrderKey`. With a sort, cards keep the sort's order: a move only
// changes the column. Left and right are mirrored in RTL, where columns run right to left.
//
// Columns move too (Phase 8): a drag of a column's header (its handle, its name) or its handle by
// the keys (Space picks it up, the arrows move it, Space drops it, Escape cancels), spoken through
// the same `CgLiveAnnouncer`. The order is the view's (`GroupRule.order`, one `view.upsert`), so it
// reaches other devices as the view's settings do and leaves the property's options as they are.
import {
  CgContextMenu,
  CgDragHandle,
  CgDropIndicator,
  CgLiveAnnouncer,
  cgStartsDrag,
  cgTrackDrag,
  type CgContextMenuActions,
  type CgContextMenuItem,
  type CgDropIndicatorHandle,
  type CgLiveAnnouncerHandle,
} from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import { TITLE_PROPERTY, type DatabaseRecord, type ViewRecord } from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import {
  isGroupable,
  liveProperties,
  propertyOf,
  shownProperties,
  uniqueName,
} from '../../model/properties';
import { withGroup, withGroupHidden, withGroupOrder } from '../../model/viewConfig';
import { newPropertyDef } from '../../properties/defs';
import type { ListLayout } from '../../table/windowing';
import { GroupLabel, groupText } from '../GroupLabel';
import type { ViewProps } from '../types';
import { Card, cardDomId } from './Card';
import { draftRow } from './shared';
import {
  CARD_GAP,
  COLUMN_HEAD,
  DRAFT_HEIGHT,
  boardKey,
  cardsIn,
  columnDropIndex,
  columnLayout,
  dropIndex,
  moveDrop,
  moveFocus,
  movableGroup,
  movedOrder,
  movedGroupValue,
  needsMove,
  orderedGroups,
  placeAt,
  targetIndex,
  type BoardPos,
} from './layout';
import './board.css';
import './card.css';

/** Pixels drawn above and below the window. */
const OVERSCAN = 480;
/** The gap between two columns (board.css), where a moved column's drop line is drawn. */
const COLUMN_GAP = 12;
/** The window's top is kept in steps of this many pixels, so a scroll redraws only now and then. */
const STEP = 160;

interface Column {
  key: string;
  count: number;
  rows: RowRecord[];
  complete: boolean;
  layout: ListLayout;
}

/** A card the keyboard picked up: where it came from and where it would land. */
interface Picked {
  row: RowRecord;
  fromKey: string;
  fromIndex: number;
  /** Column index, and the index among that column's other cards. */
  pos: BoardPos;
}

export function BoardView({
  database,
  view,
  source,
  snapshot,
  embedded,
  newRowRequest,
}: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t, rtl } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const idPrefix = `b${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const config = view.config;
  const rule = config.group;
  const groupDef = rule ? propertyOf(database, rule.propertyId) : undefined;
  const titleDef = database.properties.find((p) => p.id === TITLE_PROPERTY);
  const shown = useMemo(() => shownProperties(database, config, true), [database, config]);
  const sorted = config.sorts.length > 0;
  const crossColumns = editable && movableGroup(groupDef);
  const draggable = editable && (crossColumns || !sorted);

  const order = rule?.order;
  const columns = useMemo<Column[]>(
    () =>
      orderedGroups(snapshot.groups ?? [], order).map((g) => ({
        key: g.key,
        count: g.count,
        rows: g.rows,
        complete: g.complete,
        layout: columnLayout(g.rows, shown),
      })),
    [snapshot.groups, shown, order],
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const live = useRef<CgLiveAnnouncerHandle>(null);
  const pendingFocus = useRef<string | null>(null);
  const picked = useRef<Picked | null>(null);
  /** Each column's drop line (in its cards' box), and the one among the columns. */
  const indicators = useRef(new Map<string, CgDropIndicatorHandle>());
  const columnIndicator = useRef<CgDropIndicatorHandle>(null);
  const columnsBox = useRef<HTMLDivElement>(null);

  // ---- The window ---------------------------------------------------------------------------
  const [win, setWin] = useState({ top: 0, height: 800 });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = Math.floor(el.scrollTop / STEP) * STEP;
    const height = el.clientHeight || 800;
    setWin((prev) => (prev.top === top && prev.height === height ? prev : { top, height }));
  }, []);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const windowTop = win.top - COLUMN_HEAD - OVERSCAN;
  const windowBottom = win.top - COLUMN_HEAD + win.height + OVERSCAN + STEP;

  // A column scrolled to its end fetches its next page.
  const asked = useRef(new Set<string>());
  useEffect(() => asked.current.clear(), [snapshot]);
  useEffect(() => {
    if (!source || snapshot.loading) return;
    for (const column of columns) {
      if (column.complete || collapsed.has(column.key) || asked.current.has(column.key)) continue;
      if (windowBottom >= column.layout.total - 200) {
        asked.current.add(column.key);
        source.loadMore(column.key);
      }
    }
  }, [columns, collapsed, windowBottom, source, snapshot.loading]);

  // ---- New cards ------------------------------------------------------------------------------
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    const first = columns.find((c) => !collapsed.has(c.key)) ?? columns[0];
    if (first) setDraft(first.key);
  }, [newRowRequest, columns, collapsed]);

  const createCard = (groupKey: string, title: string) => {
    if (!title.trim()) return;
    void actions.createRow({ title, view, groupKey });
  };

  // ---- Focus ------------------------------------------------------------------------------------
  const counts = columns.map((c) => (collapsed.has(c.key) ? 0 : c.rows.length));
  const posOf = (cardKey: string | null): BoardPos | null => {
    if (!cardKey) return null;
    const split = cardKey.indexOf(':');
    const groupKey = cardKey.slice(0, split);
    const rowId = cardKey.slice(split + 1);
    const col = columns.findIndex((c) => c.key === groupKey);
    if (col < 0) return null;
    const index = columns[col].rows.findIndex((r) => r.id === rowId);
    return index < 0 ? null : { col, index };
  };
  const keyAt = (pos: BoardPos) => {
    const column = columns[pos.col];
    const row = column?.rows[pos.index];
    return row ? `${column.key}:${row.id}` : null;
  };
  const firstKey = columns.find((_c, i) => counts[i] > 0);
  const activeKey = posOf(active)
    ? active
    : firstKey
      ? `${firstKey.key}:${firstKey.rows[0].id}`
      : null;

  const reveal = (pos: BoardPos) => {
    const el = scroller.current;
    const layout = columns[pos.col]?.layout;
    if (!el || !layout) return;
    const top = layout.offsets[pos.index] + COLUMN_HEAD;
    const bottom = layout.offsets[pos.index + 1] + COLUMN_HEAD;
    if (top - COLUMN_HEAD < el.scrollTop) el.scrollTop = top - COLUMN_HEAD - 8;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8;
    const body = bodies.current.get(columns[pos.col].key);
    body?.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const focusCard = (cardKey: string) => {
    setActive(cardKey);
    pendingFocus.current = cardKey;
  };
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const el = document.getElementById(cardDomId(idPrefix, key));
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  });

  // ---- Where a card lands: a column's line, moved through its ref (never drawn by React), or the
  // whole column marked (a sorted board, or a column the card only joins) -------------------------
  const shownIndicator = useRef<{ key: string; top: number | null } | null>(null);
  const hideIndicator = () => {
    const shown = shownIndicator.current;
    shownIndicator.current = null;
    if (!shown) return;
    indicators.current.get(shown.key)?.hide();
    bodies.current.get(shown.key)?.removeAttribute('data-drop');
  };
  /** The line at `top` in a column's cards (`width`: theirs, when known), or null: the column. */
  const showIndicator = (colKey: string, top: number | null, width?: number) => {
    const body = bodies.current.get(colKey);
    const shown = shownIndicator.current;
    // Most frames of a drag land where the last one did: nothing to move.
    if (shown?.key === colKey && shown.top === top && body) return;
    if (shown?.key !== colKey) hideIndicator();
    if (!body) return;
    shownIndicator.current = { key: colKey, top };
    if (top === null) {
      indicators.current.get(colKey)?.hide();
      body.setAttribute('data-drop', 'column');
      return;
    }
    body.removeAttribute('data-drop');
    indicators.current.get(colKey)?.show({
      block: Math.max(1, top - CARD_GAP / 2),
      inline: 0,
      length: width ?? body.clientWidth,
    });
  };

  /** The indicator's top for an insertion at `index` among a column's other cards. */
  const lineTop = (column: Column, index: number, row: RowRecord) => {
    const from = column.rows.findIndex((r) => r.id === row.id);
    const all = from >= 0 && index >= from ? index + 1 : index;
    return column.layout.offsets[Math.min(all, column.layout.count)];
  };

  // ---- Moving a card -------------------------------------------------------------------------------
  /** Moves a card to `toKey` at `index` among that column's other cards (null: where it is). */
  const commitMove = (row: RowRecord, fromKey: string, toKey: string, index: number | null) => {
    const target = columnsRef.current.find((c) => c.key === toKey);
    if (!target || !rule) return;
    const others = target.rows.filter((r) => r.id !== row.id);
    const place = index === null ? null : Math.max(0, Math.min(others.length, index));
    const name = groupText(groupDef, rule, toKey, env);
    if (fromKey !== toKey) {
      const value = movedGroupValue(groupDef, rule, row, fromKey, toKey);
      if (value === undefined || !groupDef) {
        live.current?.announce(t('card.fixedGroup'));
        return;
      }
      if (!sorted && place !== null && needsMove(row, others, place))
        void actions.moveRow(row, placeAt(others, place));
      void actions.setValue(row, groupDef, value);
    } else {
      if (sorted || place === null || !needsMove(row, others, place)) return;
      void actions.moveRow(row, placeAt(others, place));
    }
    live.current?.announce(t('card.dropped', { title: row.title || t('untitled'), place: name }));
  };

  // ---- Pointer drag --------------------------------------------------------------------------------
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !draggable || picked.current) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!card || !cgStartsDrag(event.target, card)) return;
    const cardKey = card.dataset.card!;
    const split = cardKey.indexOf(':');
    const fromKey = cardKey.slice(0, split);
    const fromColumn = columnsRef.current.find((c) => c.key === fromKey);
    const row = fromColumn?.rows.find((r) => r.id === cardKey.slice(split + 1));
    if (!row || !fromColumn) return;
    const el = scroller.current;
    let geometry: { key: string; left: number; right: number; top: number; collapsed: boolean }[] =
      [];
    let start = { left: 0, top: 0 };
    let drop: { key: string; index: number | null } | null = null;

    stopDrag.current?.();
    stopDrag.current = cgTrackDrag(event.nativeEvent, card, {
      scroller: el,
      ghostClassName: 'cgw-drag-ghost',
      onStart() {
        start = { left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 };
        geometry = columnsRef.current.map((c) => {
          const body = bodies.current.get(c.key);
          const box = (
            body ?? document.getElementById(`${idPrefix}-col-${c.key}`)
          )?.getBoundingClientRect();
          return {
            key: c.key,
            left: box?.left ?? 0,
            right: box?.right ?? 0,
            top: box?.top ?? 0,
            collapsed: !body,
          };
        });
      },
      onMove(x, y) {
        const dx = (el?.scrollLeft ?? 0) - start.left;
        const dy = (el?.scrollTop ?? 0) - start.top;
        let best = -1;
        let distance = Infinity;
        geometry.forEach((g, i) => {
          const left = g.left - dx;
          const right = g.right - dx;
          const d = x < left ? left - x : x > right ? x - right : 0;
          if (d < distance) {
            distance = d;
            best = i;
          }
        });
        const g = geometry[best];
        const column = columnsRef.current.find((c) => c.key === g?.key);
        if (!g || !column) return;
        const same = column.key === fromKey;
        if (!crossColumns && !same) {
          drop = null;
          hideIndicator();
          return;
        }
        if (g.collapsed || sorted) {
          drop = { key: column.key, index: null };
          if (same) hideIndicator();
          else showIndicator(column.key, null);
          return;
        }
        const all = dropIndex(column.layout, y - (g.top - dy));
        const from = column.rows.findIndex((r) => r.id === row.id);
        const index = targetIndex(same, from, all);
        drop = { key: column.key, index };
        if (index === null) hideIndicator();
        else showIndicator(column.key, column.layout.offsets[all], g.right - g.left);
      },
      onDrop() {
        hideIndicator();
        stopDrag.current = null;
        if (drop) commitMove(row, fromKey, drop.key, drop.index);
      },
      onCancel() {
        hideIndicator();
        stopDrag.current = null;
      },
    });
  };

  // ---- Moving a column ------------------------------------------------------------------------------
  /** Writes the columns' order with `key` moved to `index` among the others. */
  const commitColumn = (key: string, index: number) => {
    const keys = columnsRef.current.map((c) => c.key);
    const next = movedOrder(keys, key, index);
    if (next.every((k, i) => k === keys[i])) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    void actions.updateView(view, withGroupOrder(view.config, next));
    live.current?.announce(
      t('board.columnDropped', {
        name: groupText(groupDef, rule!, key, env),
        index: next.indexOf(key) + 1,
      }),
    );
  };
  /**
   * Shows where a column would land: a line in the gap before the column at an insertion index,
   * or after the last. Measured only when the place changes.
   */
  const columnDrop = useRef<number | null>(null);
  const markColumnDrop = (index: number | null) => {
    if (index === columnDrop.current) return;
    columnDrop.current = index;
    const box = columnsBox.current;
    const sections = [
      ...(box?.querySelectorAll<HTMLElement>('.cgw-board-column[data-group]') ?? []),
    ];
    const target = index === null ? undefined : sections[Math.min(index, sections.length - 1)];
    if (!box || !target || index === null) return columnIndicator.current?.hide();
    const outer = box.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    // From the columns' inline start: their right edge in RTL.
    const start =
      getComputedStyle(box).direction === 'rtl' ? outer.right - rect.right : rect.left - outer.left;
    columnIndicator.current?.show({
      orientation: 'vertical',
      block: rect.top - outer.top,
      inline:
        index >= sections.length ? start + rect.width + COLUMN_GAP / 2 : start - COLUMN_GAP / 2,
      length: rect.height,
    });
  };

  /** A column picked up by the keys: where it came from and where it would land. */
  const pickedColumn = useRef<{ key: string; from: number; index: number } | null>(null);
  const endColumnPick = (commit: boolean) => {
    const p = pickedColumn.current;
    pickedColumn.current = null;
    markColumnDrop(null);
    if (!p) return;
    document.getElementById(`${idPrefix}-col-${p.key}`)?.removeAttribute('data-cg-dragging');
    if (!commit || p.index === p.from) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    commitColumn(p.key, p.index);
  };
  const onGripKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const p = pickedColumn.current;
    const count = columns.length;
    const name = rule ? groupText(groupDef, rule, key, env) : key;
    if (!p) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      const from = columns.findIndex((c) => c.key === key);
      if (from < 0) return;
      pickedColumn.current = { key, from, index: from };
      document.getElementById(`${idPrefix}-col-${key}`)?.setAttribute('data-cg-dragging', '');
      live.current?.announce(t('board.columnPickedUp', { name }));
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') return endColumnPick(false);
    if (event.key === ' ' || event.key === 'Enter') return endColumnPick(true);
    const rtlNow = getComputedStyle(event.currentTarget).direction === 'rtl';
    const move = boardKey(event.key, rtlNow);
    const index =
      move === 'next'
        ? p.index + 1
        : move === 'previous'
          ? p.index - 1
          : move === 'first'
            ? 0
            : move === 'last'
              ? count - 1
              : p.index;
    if (index < 0 || index >= count || index === p.index) return;
    p.index = index;
    // Shown as an insertion among every column: after itself when it goes later.
    markColumnDrop(index > p.from ? index + 1 : index);
    live.current?.announce(t('board.columnPosition', { name, index: index + 1, count }));
  };

  const onHeadPointerDown = (event: PointerEvent<HTMLElement>, key: string) => {
    if (event.button !== 0 || !editable || pickedColumn.current) return;
    const head = event.currentTarget;
    const target = event.target as HTMLElement;
    if (!target.closest('.cgw-db-column-grip') && !cgStartsDrag(event.target, head)) return;
    event.stopPropagation();
    const el = scroller.current;
    const from = columnsRef.current.findIndex((c) => c.key === key);
    if (from < 0) return;
    let boxes: { left: number; right: number }[] = [];
    let startLeft = 0;
    let drop: number | null = null;
    const rtlNow = getComputedStyle(head).direction === 'rtl';
    stopDrag.current?.();
    stopDrag.current = cgTrackDrag(event.nativeEvent, head, {
      scroller: el,
      ghostClassName: 'cgw-drag-ghost',
      onStart() {
        startLeft = el?.scrollLeft ?? 0;
        boxes = columnsRef.current.map((c) => {
          const box = document.getElementById(`${idPrefix}-col-${c.key}`)?.getBoundingClientRect();
          return { left: box?.left ?? 0, right: box?.right ?? 0 };
        });
      },
      onMove(x) {
        const dx = (el?.scrollLeft ?? 0) - startLeft;
        const at = columnDropIndex(
          boxes.map((b) => ({ left: b.left - dx, right: b.right - dx })),
          x,
          rtlNow,
        );
        drop = targetIndex(true, from, at);
        markColumnDrop(drop === null ? null : at);
      },
      onDrop() {
        markColumnDrop(null);
        stopDrag.current = null;
        if (drop !== null) commitColumn(key, drop);
      },
      onCancel() {
        markColumnDrop(null);
        stopDrag.current = null;
      },
    });
  };

  // ---- Keyboard ------------------------------------------------------------------------------------
  const othersCounts = (row: RowRecord) =>
    columns.map((c) => (collapsed.has(c.key) ? 0 : c.rows.filter((r) => r.id !== row.id).length));

  const announcePick = (p: Picked) => {
    const column = columns[p.pos.col];
    if (!column || !rule) return;
    const others = column.rows.filter((r) => r.id !== p.row.id).length;
    live.current?.announce(
      t('card.position', {
        group: groupText(groupDef, rule, column.key, env),
        index: p.pos.index + 1,
        count: others + 1,
      }),
    );
    if (collapsed.has(column.key) || sorted) {
      if (column.key === p.fromKey) hideIndicator();
      else showIndicator(column.key, null);
    } else showIndicator(column.key, lineTop(column, p.pos.index, p.row));
  };

  const endPick = (commit: boolean) => {
    const p = picked.current;
    picked.current = null;
    hideIndicator();
    if (!p) return;
    document
      .getElementById(cardDomId(idPrefix, `${p.fromKey}:${p.row.id}`))
      ?.removeAttribute('data-cg-dragging');
    if (!commit) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    const column = columns[p.pos.col];
    if (!column) return;
    const same = column.key === p.fromKey;
    const index =
      sorted || collapsed.has(column.key)
        ? null
        : same && p.pos.index === p.fromIndex
          ? null
          : p.pos.index;
    if (same && index === null) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    commitMove(p.row, p.fromKey, column.key, index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-card]');
    if (!card || card !== target) return;
    const cardKey = card.dataset.card!;
    const pos = posOf(cardKey);
    if (!pos) return;
    const row = columns[pos.col].rows[pos.index];
    const dirRtl = card.isConnected ? getComputedStyle(card).direction === 'rtl' : rtl;

    const p = picked.current;
    if (p) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') return endPick(false);
      if (event.key === ' ' || event.key === 'Enter') return endPick(true);
      const move = boardKey(event.key, dirRtl);
      if (!move) return;
      const next = moveDrop(othersCounts(p.row), p.pos, move);
      if (!next) return;
      if (next.col !== p.pos.col && !crossColumns) return;
      p.pos = next;
      announcePick(p);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      host.openRow(row.id);
      return;
    }
    if (event.key === ' ' && draggable) {
      event.preventDefault();
      const from = pos.index;
      picked.current = {
        row,
        fromKey: columns[pos.col].key,
        fromIndex: from,
        pos: { col: pos.col, index: from },
      };
      card.setAttribute('data-cg-dragging', '');
      live.current?.announce(t('card.pickedUp', { title: row.title || t('untitled') }));
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      void cardMenu.current?.showNear(card, row);
      return;
    }
    const move = boardKey(event.key, dirRtl);
    if (!move) return;
    event.preventDefault();
    const next = moveFocus(counts, pos, move);
    if (!next) return;
    const key = keyAt(next);
    if (!key) return;
    reveal(next);
    focusCard(key);
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (card?.dataset.card && card.dataset.card !== active) setActive(card.dataset.card);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (picked.current && !scroller.current?.contains(event.relatedTarget as Node | null))
      endPick(false);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!card || !cgStartsDrag(event.target, card)) return;
    if (card.dataset.rowId) host.openRow(card.dataset.rowId);
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    const pos = posOf(card?.dataset.card ?? null);
    if (!card || !pos) return;
    event.preventDefault();
    setActive(card.dataset.card!);
    void cardMenu.current?.showFromEvent(
      event as MouseEvent<HTMLElement>,
      columns[pos.col].rows[pos.index],
    );
  };

  // ---- Menus ---------------------------------------------------------------------------------------
  const cardMenu = useRef<CgContextMenuActions<RowRecord>>(null);
  const cardItems = useMemo<CgContextMenuItem<RowRecord>[]>(
    () => [
      {
        key: 'open',
        text: t('row.open'),
        command: ({ invocation }) => host.openRow(invocation.context.id),
      },
      {
        key: 'duplicate',
        text: t('row.duplicate'),
        disabled: !editable,
        command: ({ invocation }) => void actions.duplicateRow(invocation.context),
      },
      {
        key: 'delete',
        text: t('row.delete'),
        intent: 'danger',
        disabled: !editable,
        beginGroup: true,
        command: ({ invocation }) => void actions.trashRow(invocation.context),
      },
    ],
    [t, host, actions, editable],
  );
  const columnMenu = useRef<CgContextMenuActions<string>>(null);
  const columnItems = useMemo<CgContextMenuItem<string>[]>(
    () => [
      {
        key: 'hide',
        text: t('board.hideColumn'),
        disabled: !editable,
        command: ({ invocation }) =>
          void actions.updateView(view, withGroupHidden(view.config, invocation.context, true)),
      },
    ],
    [t, actions, editable, view],
  );

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ---- Drawing -------------------------------------------------------------------------------------
  if (!rule || !groupDef || groupDef.trashedAt || !snapshot.groups) {
    if (snapshot.loading && rule && groupDef) return <div className="cgw-board" aria-busy="true" />;
    return <BoardSetup database={database} view={view} env={env} />;
  }

  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const hidden = rule.hidden ?? [];
  const activePos = posOf(activeKey);

  return (
    <div className={`cgw-board${embedded ? ' is-embedded' : ''}`}>
      {sorted && crossColumns ? <p className="cgw-board-note">{t('board.sorted')}</p> : null}
      <div
        ref={scroller}
        className="cgw-board-scroll"
        role="region"
        aria-label={t('board.label', { name })}
        aria-busy={snapshot.loading || undefined}
        onScroll={measure}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div ref={columnsBox} className="cgw-board-columns">
          <CgDropIndicator ref={columnIndicator} className="cgw-db-drop-indicator" />
          {columns.map((column, col) => {
            const isCollapsed = collapsed.has(column.key);
            const label = groupText(groupDef, rule, column.key, env);
            const range = isCollapsed
              ? { start: 0, end: 0 }
              : cardsIn(column.layout, windowTop, windowBottom);
            const drawn: number[] = [];
            for (let i = range.start; i < range.end; i++) drawn.push(i);
            if (
              activePos &&
              activePos.col === col &&
              !drawn.includes(activePos.index) &&
              !isCollapsed
            )
              drawn.push(activePos.index);
            const hasDraft = draft === column.key && !isCollapsed;
            return (
              <section
                key={column.key}
                id={`${idPrefix}-col-${column.key}`}
                className="cgw-board-column"
                data-collapsed={isCollapsed || undefined}
                data-group={column.key}
                aria-label={`${label}, ${t('board.countLabel', { count: column.count })}`}
              >
                <header
                  className="cgw-board-head"
                  onPointerDown={(event) => onHeadPointerDown(event, column.key)}
                >
                  {editable ? (
                    <CgDragHandle
                      className="cgw-icon-button cgw-db-column-grip"
                      label={t('board.moveColumn', { name: label })}
                      aria-description={t('board.moveColumnHint')}
                      onKeyDown={(event) => onGripKeyDown(event, column.key)}
                      onBlur={() => pickedColumn.current && endColumnPick(false)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="cgw-icon-button cgw-board-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={t(isCollapsed ? 'board.expand' : 'board.collapse', { name: label })}
                    title={t(isCollapsed ? 'board.expand' : 'board.collapse', { name: label })}
                    onClick={() => toggle(column.key)}
                  >
                    <span aria-hidden="true" className="cgw-board-chevron">
                      ▾
                    </span>
                  </button>
                  <span className="cgw-board-name">
                    <GroupLabel def={groupDef} rule={rule} groupKey={column.key} env={env} />
                  </span>
                  <span className="cgw-board-count" aria-hidden="true">
                    {column.count.toLocaleString(env.locale)}
                  </span>
                  {!isCollapsed && editable ? (
                    <>
                      <button
                        type="button"
                        className="cgw-icon-button"
                        aria-label={t('board.columnMenu', { name: label })}
                        title={t('board.columnMenu', { name: label })}
                        onClick={(event) =>
                          void columnMenu.current?.showNear(event.currentTarget, column.key)
                        }
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                      <button
                        type="button"
                        className="cgw-icon-button"
                        aria-label={t('board.newCardIn', { name: label })}
                        title={t('board.newCardIn', { name: label })}
                        onClick={() => setDraft(column.key)}
                      >
                        <span aria-hidden="true">＋</span>
                      </button>
                    </>
                  ) : null}
                </header>
                {isCollapsed ? null : (
                  <>
                    <div
                      ref={(el) => {
                        if (el) bodies.current.set(column.key, el);
                        else bodies.current.delete(column.key);
                      }}
                      className="cgw-board-cards"
                      style={{
                        blockSize: column.layout.total + (hasDraft ? DRAFT_HEIGHT + CARD_GAP : 0),
                      }}
                    >
                      <CgDropIndicator
                        ref={(handle) => {
                          if (handle) indicators.current.set(column.key, handle);
                          else indicators.current.delete(column.key);
                        }}
                        className="cgw-db-drop-indicator"
                      />
                      {drawn.map((i) => {
                        const row = column.rows[i];
                        const cardKey = `${column.key}:${row.id}`;
                        return (
                          <Card
                            key={row.id}
                            row={row}
                            cardKey={cardKey}
                            idPrefix={idPrefix}
                            shown={shown}
                            env={env}
                            active={cardKey === activeKey}
                            draggable={draggable}
                            style={{
                              insetBlockStart: column.layout.offsets[i],
                              blockSize:
                                column.layout.offsets[i + 1] - column.layout.offsets[i] - CARD_GAP,
                            }}
                          />
                        );
                      })}
                      {hasDraft && titleDef ? (
                        <div
                          className="cgw-card cgw-card-draft"
                          style={{ insetBlockStart: column.layout.total, blockSize: DRAFT_HEIGHT }}
                        >
                          <InlineEditor
                            def={titleDef}
                            row={draftRow(database)}
                            env={env}
                            label={t('card.newLabel')}
                            className="cgw-card-input"
                            commit={(value) =>
                              createCard(column.key, typeof value === 'string' ? value : '')
                            }
                            onDone={() => setDraft(null)}
                          />
                        </div>
                      ) : null}
                      {!column.rows.length && !hasDraft ? (
                        <p className="cgw-board-empty">{t('board.empty')}</p>
                      ) : null}
                    </div>
                    <div className="cgw-board-foot">
                      {!column.complete ? (
                        <button
                          type="button"
                          className="cgw-text-button"
                          onClick={() => source?.loadMore(column.key)}
                        >
                          {t('board.loadMore')}
                        </button>
                      ) : null}
                      {editable && !hasDraft ? (
                        <button
                          type="button"
                          className="cgw-board-new"
                          aria-label={t('board.newCardIn', { name: label })}
                          onClick={() => setDraft(column.key)}
                        >
                          <span aria-hidden="true">＋ </span>
                          {t('board.newCard')}
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </section>
            );
          })}
          {hidden.length ? (
            <section
              className="cgw-board-column cgw-board-hidden"
              aria-label={t('board.hiddenGroups')}
            >
              <header className="cgw-board-head">
                <span className="cgw-board-name">{t('board.hiddenGroups')}</span>
              </header>
              <ul className="cgw-board-hidden-list">
                {hidden.map((key) => {
                  const label = groupText(groupDef, rule, key, env);
                  return (
                    <li key={key} className="cgw-board-hidden-item">
                      <GroupLabel def={groupDef} rule={rule} groupKey={key} env={env} />
                      {editable ? (
                        <button
                          type="button"
                          className="cgw-text-button"
                          aria-label={t('board.showColumn', { name: label })}
                          onClick={() =>
                            void actions.updateView(view, withGroupHidden(config, key, false))
                          }
                        >
                          {t('board.show')}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      <div className="cgw-table-foot" role="status">
        {snapshot.complete
          ? t('rowCount', { count: snapshot.total })
          : t('rowsShown', {
              shown: new Set(snapshot.rows.map((r) => r.id)).size,
              total: snapshot.total,
            })}
      </div>
      <CgLiveAnnouncer ref={live} />
      <CgContextMenu<RowRecord> items={cardItems} actionsRef={cardMenu} ariaLabel={t('row.menu')} />
      <CgContextMenu<string>
        items={columnItems}
        actionsRef={columnMenu}
        ariaLabel={t('board.hiddenGroups')}
      />
    </div>
  );
}

/** A board without a usable group property: choose one, or add a Status property. */
function BoardSetup({
  database,
  view,
  env,
}: {
  database: DatabaseRecord;
  view: ViewRecord;
  env: CellEnv;
}) {
  const { actions, editable } = useDatabaseContext();
  const { t } = env;
  const candidates = liveProperties(database).filter((p) => isGroupable(p.type));
  const choose = (propertyId: string) => {
    if (propertyId) void actions.updateView(view, withGroup(view.config, { propertyId }));
  };
  const addStatus = () => {
    const def = newPropertyDef('status', uniqueName(database, t('board.statusName')), {
      todo: t('option.defaultTodo'),
      inProgress: t('option.defaultInProgress'),
      complete: t('option.defaultComplete'),
    });
    void actions.addProperty(def).then(() => choose(def.id));
  };
  return (
    <div className="cgw-view-setup" role="note">
      <p>{candidates.length ? t('board.chooseGroup') : t('board.noGroupable')}</p>
      {candidates.length ? (
        <label className="cgw-view-setup-field">
          <span>{t('board.groupBy')}</span>
          <select
            className="cgw-select"
            value=""
            disabled={!editable}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{t('board.pickGroup')}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {editable ? (
        <button type="button" className="cgw-text-button" onClick={addStatus}>
          {t('board.addStatus')}
        </button>
      ) : null}
    </div>
  );
}
