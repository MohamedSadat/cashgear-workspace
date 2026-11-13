// The board view: a column per group of the view's group property (select or status by default;
// any groupable one), each with its count, a "New" card preset to that group, and its cards: the
// title and the view's shown properties. Empty groups show (unless the rule hides them), hidden
// groups are listed at the end, a column can be collapsed. The board scrolls as one; each column
// draws only the cards inside the window (fixed heights worked out from each row, layout.ts).
//
// A card moves by pointer (drag.ts: a copy follows the pointer and one indicator shows where it
// lands; no card is drawn again during the drag) or by keyboard (Space picks it up, the arrows
// move it, Space drops it, Escape cancels). Into another column: one `row.update` of the group
// property (and a `page.move` when its place there needs a new order key); within a column: a
// `page.move` with `host.rowOrderKey`. With a sort, cards keep the sort's order: a move only
// changes the column. Left and right are mirrored in RTL, where columns run right to left.
import { CgContextMenu, type CgContextMenuActions, type CgContextMenuItem } from '@cashgear/ui';
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
import { withGroup, withGroupHidden } from '../../model/viewConfig';
import { newPropertyDef } from '../../properties/defs';
import type { ListLayout } from '../../table/windowing';
import { GroupLabel, groupText } from '../GroupLabel';
import type { ViewProps } from '../types';
import { Card, cardDomId } from './Card';
import { startsDrag, trackDrag } from './drag';
import { draftRow, Live, type LiveHandle } from './shared';
import {
  CARD_GAP,
  COLUMN_HEAD,
  DRAFT_HEIGHT,
  boardKey,
  cardsIn,
  columnLayout,
  dropIndex,
  moveDrop,
  moveFocus,
  movableGroup,
  movedGroupValue,
  needsMove,
  placeAt,
  targetIndex,
  type BoardPos,
} from './layout';
import './board.css';
import './card.css';

/** Pixels drawn above and below the window. */
const OVERSCAN = 480;
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

  const columns = useMemo<Column[]>(
    () =>
      (snapshot.groups ?? []).map((g) => ({
        key: g.key,
        count: g.count,
        rows: g.rows,
        complete: g.complete,
        layout: columnLayout(g.rows, shown),
      })),
    [snapshot.groups, shown],
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const live = useRef<LiveHandle>(null);
  const pendingFocus = useRef<string | null>(null);
  const picked = useRef<Picked | null>(null);
  const indicator = useRef<HTMLDivElement | null>(null);

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

  // ---- The drop indicator: one element, moved by hand, never drawn by React -----------------------
  const showIndicator = (colKey: string, top: number | null) => {
    const body = bodies.current.get(colKey);
    let el = indicator.current;
    if (!el) {
      el = document.createElement('div');
      el.className = 'cgw-db-drop-indicator';
      el.setAttribute('aria-hidden', 'true');
      indicator.current = el;
    }
    if (!body) {
      el.remove();
      return;
    }
    if (el.parentElement !== body) body.append(el);
    if (top === null) {
      el.dataset.mode = 'column';
      el.style.transform = '';
    } else {
      el.dataset.mode = 'line';
      el.style.transform = `translateY(${Math.max(0, top - CARD_GAP / 2 - 1)}px)`;
    }
  };
  const hideIndicator = () => {
    indicator.current?.remove();
  };
  useEffect(() => hideIndicator, []);

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
        live.current?.say(t('card.fixedGroup'));
        return;
      }
      if (!sorted && place !== null && needsMove(row, others, place))
        void actions.moveRow(row, placeAt(others, place));
      void actions.setValue(row, groupDef, value);
    } else {
      if (sorted || place === null || !needsMove(row, others, place)) return;
      void actions.moveRow(row, placeAt(others, place));
    }
    live.current?.say(t('card.dropped', { title: row.title || t('untitled'), place: name }));
  };

  // ---- Pointer drag --------------------------------------------------------------------------------
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !draggable || picked.current) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!card || !startsDrag(event.target, card)) return;
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
    stopDrag.current = trackDrag(event.nativeEvent, card, el, {
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
        else showIndicator(column.key, column.layout.offsets[all]);
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

  // ---- Keyboard ------------------------------------------------------------------------------------
  const othersCounts = (row: RowRecord) =>
    columns.map((c) => (collapsed.has(c.key) ? 0 : c.rows.filter((r) => r.id !== row.id).length));

  const announcePick = (p: Picked) => {
    const column = columns[p.pos.col];
    if (!column || !rule) return;
    const others = column.rows.filter((r) => r.id !== p.row.id).length;
    live.current?.say(
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
      ?.removeAttribute('data-dragging');
    if (!commit) {
      live.current?.say(t('card.cancelled'));
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
      live.current?.say(t('card.cancelled'));
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
      card.setAttribute('data-dragging', '');
      live.current?.say(t('card.pickedUp', { title: row.title || t('untitled') }));
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
    if (!card || !startsDrag(event.target, card)) return;
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
        <div className="cgw-board-columns">
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
                <header className="cgw-board-head">
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
      <Live ref={live} />
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
