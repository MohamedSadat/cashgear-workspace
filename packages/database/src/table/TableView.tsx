// The table view (ARIA grid): a sticky header and title column, rows virtualised at fixed
// heights (only the window and an overscan are drawn), optional collapsible group sections with
// counts, "load more" while rows remain, and a "New" row. Keyboard: arrows (mirrored in RTL),
// Home, End, PageUp, PageDown, Tab; Enter or F2 edits, typing starts an edit, Escape cancels,
// Delete clears, Ctrl+Enter opens the row, Shift+F10 its menu. On a header: Enter opens the
// property's menu, Alt+arrows resize, Alt+Shift+arrows move the column.
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
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useCellEnv } from '../cells/env';
import type { EditEnd } from '../cells/InlineEditor';
import { CellFlyout } from '../cells/CellFlyout';
import { TITLE_PROPERTY, type PropertyDef, type PropertyType } from '../core';
import { useDatabaseContext } from '../context';
import { useDbT } from '../i18n';
import { linkFor } from '../model/links';
import {
  clampWidth,
  columnWidth,
  editKind,
  isEditableType,
  propertyOf,
  shownProperties,
  uniqueName,
} from '../model/properties';
import { placeProperty, withWidth } from '../model/viewConfig';
import { newPropertyDef } from '../properties/defs';
import { PropertyMenu, type PropertyPanel } from '../properties/PropertyMenu';
import { TypePicker } from '../properties/TypePicker';
import type { ViewProps } from '../views/types';
import { buildItems, HEADER_HEIGHT, indexOfRow, itemHeight, type TableItem } from './items';
import { navigate, startsTyping, type GridPos } from './navigation';
import { TableHeader } from './TableHeader';
import { cellId, TableRow, type EditingCell } from './TableRow';
import {
  columnRange,
  layoutOf,
  revealScroll,
  sameRange,
  visibleRange,
  type Range,
} from './windowing';

const OVERSCAN = 4;
/**
 * Rows in the window are keyed by slot (index modulo this), so scrolling reuses their elements
 * and React updates text and attributes instead of building rows anew; the edited item keeps its
 * own key, so its editor survives a scroll.
 */
const SLOTS = 256;

interface Editing {
  rowId: string;
  group: string | null;
  propertyId: string;
  seed: string | null;
}

interface MenuState {
  propertyId: string;
  anchor: HTMLElement;
  panel?: PropertyPanel;
}

export function TableView({
  database,
  view,
  source,
  snapshot,
  embedded,
  searching,
  newRowRequest,
  requestFilter,
}: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t, rtl } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const gridId = useId().replace(/:/g, '');
  const grid = useRef<HTMLDivElement>(null);
  const config = view.config;
  const wrap = config.wrap === true;

  const columns = useMemo(() => shownProperties(database, config, true), [database, config]);
  const widths = useMemo(() => columns.map((def) => columnWidth(def, config)), [columns, config]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const previousItems = useRef<TableItem[] | undefined>(undefined);
  const items = useMemo(() => {
    const made = buildItems(snapshot, collapsed, editable, previousItems.current);
    previousItems.current = made;
    return made;
  }, [snapshot, collapsed, editable]);
  // Ungrouped, every row is as tall as the next: the layout changes only with the count.
  const shapeKey = snapshot.groups ? items : `${items.length}:${items[items.length - 1]?.kind}`;
  const layout = useMemo(
    () => layoutOf(items.length, (i) => itemHeight(items[i], wrap)),
    // `items` is read through `shapeKey`: a new item list of the same shape keeps the layout.
    [shapeKey, wrap],
  );
  const group = useMemo(
    () =>
      config.group
        ? { rule: config.group, def: propertyOf(database, config.group.propertyId) }
        : null,
    [config.group, database],
  );

  // ---- The window -------------------------------------------------------------------------
  const [range, setRange] = useState<Range>({ start: 0, end: 40 });
  const viewport = useRef(600);
  const [cols, setCols] = useState<Range>({ start: 1, end: 12 });
  const measure = useCallback(() => {
    const el = grid.current;
    if (!el) return;
    viewport.current = el.clientHeight - HEADER_HEIGHT;
    const next = visibleRange(layout, el.scrollTop, viewport.current, OVERSCAN);
    setRange((prev) => (sameRange(prev, next) ? prev : next));
    // jsdom lays nothing out: without a width every column is drawn.
    const across = el.clientWidth
      ? columnRange(widths, Math.abs(el.scrollLeft), el.clientWidth, 1)
      : { start: 1, end: widths.length };
    setCols((prev) => (sameRange(prev, across) ? prev : across));
  }, [layout, widths]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // ---- The active cell and the edit ------------------------------------------------------
  const [active, setActive] = useState<GridPos>({ item: 0, col: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const pendingMenu = useRef<string | null>(null);
  const pendingRow = useRef<string | null>(null);
  const activeItem = Math.min(active.item, items.length - 1);
  const activeCol = Math.min(active.col, Math.max(0, columns.length - 1));
  const editingItem = editing ? indexOfRow(items, editing.rowId, editing.group) : -1;
  const editingCol = editing ? columns.findIndex((c) => c.id === editing.propertyId) : -1;

  const focusGrid = () => grid.current?.focus({ preventScroll: true });

  const reveal = useCallback(
    (item: number, col: number) => {
      const el = grid.current;
      if (!el) return;
      if (item >= 0) {
        const top = revealScroll(layout, item, el.scrollTop, el.clientHeight - HEADER_HEIGHT, 0);
        if (top !== null) el.scrollTop = top;
      }
      const cell = document.getElementById(
        item < 0 ? `${gridId}-h${col}` : cellId(gridId, item, col),
      );
      cell?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    },
    [layout, gridId],
  );

  const moveTo = (pos: GridPos) => {
    setActive(pos);
    requestAnimationFrame(() => reveal(pos.item, pos.col));
  };

  const startEdit = (item: number, col: number, seed: string | null = null) => {
    const entry = items[item];
    if (!entry || entry.kind !== 'row' || !editable) return;
    const def = columns[col];
    if (!def || !isEditableType(def.type)) return;
    const kind = editKind(def.type);
    if (kind === 'toggle') {
      void actions.setValue(entry.row, def, entry.row.values[def.id] !== true);
      return;
    }
    if (kind === 'none') return;
    setActive({ item, col });
    setEditing({ rowId: entry.row.id, group: entry.group, propertyId: def.id, seed });
  };

  const onEditDone = useCallback((end: EditEnd) => {
    setEditing(null);
    focusGrid();
    if (end === 'tab' || end === 'shiftTab')
      setActive((pos) => {
        const next = navigate(pos, { key: 'Tab', shiftKey: end === 'shiftTab' }, shapeRef.current);
        return next && next !== 'leave' ? next : pos;
      });
  }, []);

  // ---- Rows: new, open, more ---------------------------------------------------------------
  const newRow = useCallback(
    async (groupKey: string | null) => {
      // Known before the row is made: the row can show before the write's promise settles.
      const id = host.newId();
      pendingRow.current = id;
      if (!(await actions.createRow({ id, view, groupKey }))) pendingRow.current = null;
    },
    [actions, host, view],
  );
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    // Only a new press of the toolbar's New makes a row: in the first group when grouped.
    void newRow(snapshot.groups ? (snapshot.groups[0]?.key ?? null) : null);
  }, [newRowRequest, newRow, snapshot.groups]);

  // A row made here gets the caret in its title once it shows.
  useEffect(() => {
    const id = pendingRow.current;
    if (!id) return;
    const at = indexOfRow(items, id);
    if (at < 0) return;
    pendingRow.current = null;
    const entry = items[at] as Extract<TableItem, { kind: 'row' }>;
    setActive({ item: at, col: 0 });
    setEditing({ rowId: id, group: entry.group, propertyId: TITLE_PROPERTY, seed: null });
    requestAnimationFrame(() => reveal(at, 0));
  }, [items, reveal]);

  const loadMore = useCallback(
    (groupKey: string | null) => source?.loadMore(groupKey ?? undefined),
    [source],
  );
  // "Load more" items that come into the window fetch the next page.
  useEffect(() => {
    if (snapshot.loading || !source) return;
    for (let i = range.start; i < range.end; i++) {
      const item = items[i];
      if (item?.kind === 'more') {
        source.loadMore(item.group ?? undefined);
        return;
      }
    }
  }, [range, items, snapshot.loading, source]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openRow = useCallback((rowId: string) => host.openRow(rowId), [host]);

  // ---- Columns: width, order, menus ---------------------------------------------------------
  const previewWidth = useCallback((col: number, width: number) => {
    grid.current?.style.setProperty(`--cgw-w-${col}`, `${width}px`);
  }, []);
  const commitWidth = useCallback(
    (col: number, width: number) => {
      const def = columns[col];
      if (def) void actions.updateView(view, withWidth(view.config, def.id, clampWidth(width)));
    },
    [actions, columns, view],
  );
  const moveColumn = useCallback(
    (from: number, to: number, side: 'before' | 'after') => {
      const def = columns[from];
      const anchor = columns[to];
      if (!def || !anchor || def.id === TITLE_PROPERTY) return;
      void actions.updateView(view, placeProperty(view.config, database, def.id, anchor.id, side));
    },
    [actions, columns, database, view],
  );
  const openMenu = useCallback(
    (col: number, anchor: HTMLElement) => {
      const def = columns[col];
      if (def) {
        setActive({ item: -1, col });
        setMenu({ propertyId: def.id, anchor });
      }
    },
    [columns],
  );
  const addProperty = useCallback((anchor: HTMLElement) => setAdding(anchor), []);
  const sortGlyph = useCallback(
    (id: string) => {
      const rule = config.sorts.find((s) => s.propertyId === id);
      return rule ? (rule.direction === 'asc' ? '↑' : '↓') : null;
    },
    [config.sorts],
  );

  // A property made here opens its menu, its name ready to type, once its column shows.
  useEffect(() => {
    const id = pendingMenu.current;
    if (!id) return;
    const col = columns.findIndex((c) => c.id === id);
    if (col < 0) return;
    pendingMenu.current = null;
    requestAnimationFrame(() => {
      const anchor = document.getElementById(`${gridId}-h${col}`);
      if (anchor) {
        anchor.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        setActive({ item: -1, col });
        setMenu({ propertyId: id, anchor });
      }
    });
  }, [columns, gridId]);

  const createProperty = (type: PropertyType) => {
    setAdding(null);
    const def = newPropertyDef(type, uniqueName(database, t(`type.${type}`)), {
      todo: t('option.defaultTodo'),
      inProgress: t('option.defaultInProgress'),
      complete: t('option.defaultComplete'),
    });
    pendingMenu.current = def.id;
    const last = columns[columns.length - 1];
    void actions.addProperty(def, last ? { view, anchor: last.id, side: 'after' } : undefined);
  };

  // ---- Row menu ------------------------------------------------------------------------------
  const rowMenu = useRef<CgContextMenuActions<RowRecord>>(null);
  const rowMenuItems = useMemo<CgContextMenuItem<RowRecord>[]>(
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

  // ---- Keyboard --------------------------------------------------------------------------------
  const shape = useMemo(
    () => ({
      count: items.length,
      cols: columns.length,
      isRow: (i: number) => items[i]?.kind === 'row',
      pageSize: Math.max(1, Math.floor(viewport.current / 34) - 1),
      rtl,
    }),
    [items, columns.length, rtl],
  );
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== grid.current || editing) return;
    const pos = { item: activeItem, col: activeCol };
    const entry = items[pos.item];
    const mod = event.ctrlKey || event.metaKey;
    // The direction the grid is drawn in: the nearest `dir`, as every CashGear control reads it.
    const dir = grid.current?.closest('[dir]')?.getAttribute('dir');
    const dirRtl = dir ? dir.toLowerCase() === 'rtl' : rtl;

    if (pos.item === -1) {
      const def = columns[pos.col];
      if ((event.key === 'Enter' || event.key === ' ') && def) {
        event.preventDefault();
        const anchor = document.getElementById(`${gridId}-h${pos.col}`);
        if (anchor) setMenu({ propertyId: def.id, anchor });
        return;
      }
      if (
        event.altKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        def &&
        editable
      ) {
        event.preventDefault();
        const forward = (event.key === 'ArrowRight') !== dirRtl;
        if (event.shiftKey) {
          if (pos.col === 0) return;
          const to = pos.col + (forward ? 1 : -1);
          if (to < 1 || to >= columns.length) return;
          moveColumn(pos.col, to, forward ? 'after' : 'before');
          setActive({ item: -1, col: to });
        } else commitWidth(pos.col, widths[pos.col] + (forward ? 16 : -16));
        return;
      }
    }

    if (entry && entry.kind !== 'row' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (entry.kind === 'group') toggleGroup(entry.group);
      else if (entry.kind === 'new') void newRow(entry.group);
      else loadMore(entry.group);
      return;
    }

    if (entry?.kind === 'row') {
      const def = columns[pos.col];
      if (event.key === 'Enter' && mod) {
        event.preventDefault();
        host.openRow(entry.row.id);
        return;
      }
      if (event.key === 'Enter' && event.shiftKey && def) {
        const text = entry.row.values[def.id];
        const href = typeof text === 'string' ? linkFor(def.type, text) : null;
        if (href) {
          event.preventDefault();
          env.openLink(href);
          return;
        }
      }
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        startEdit(pos.item, pos.col);
        return;
      }
      if (event.key === ' ' && def?.type === 'checkbox') {
        event.preventDefault();
        startEdit(pos.item, pos.col);
        return;
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        def &&
        editable &&
        isEditableType(def.type)
      ) {
        event.preventDefault();
        void actions.setValue(entry.row, def, null);
        return;
      }
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const cell = document.getElementById(cellId(gridId, pos.item, pos.col));
        if (cell) void rowMenu.current?.showNear(cell, entry.row);
        return;
      }
      if (def && editable && startsTyping(event.nativeEvent) && editKind(def.type) !== 'toggle') {
        event.preventDefault();
        startEdit(pos.item, pos.col, event.key);
        return;
      }
    }

    const next = navigate(pos, event, { ...shape, rtl: dirRtl });
    if (next === null) return;
    if (next === 'leave') return; // Tab leaves the grid as the browser moves focus.
    event.preventDefault();
    moveTo(next);
  };

  // ---- Pointer -----------------------------------------------------------------------------------
  const pressed = useRef<{ item: number; col: number; wasActive: boolean } | null>(null);
  const cellAt = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.('[data-col]') as HTMLElement | null;
    const rowEl = el?.closest('[data-item]') as HTMLElement | null;
    if (!el || !rowEl) return null;
    return { item: Number(rowEl.dataset.item), col: Number(el.dataset.col) };
  };
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.cgw-inline-editor, .cgw-thead')) return;
    const at = cellAt(target);
    if (!at) return;
    pressed.current = {
      ...at,
      wasActive:
        at.item === activeItem && at.col === activeCol && document.activeElement === grid.current,
    };
    if (editing) return;
    event.preventDefault();
    setActive(at);
    focusGrid();
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const at = cellAt(event.target);
    const press = pressed.current;
    pressed.current = null;
    if (!at || !press || press.item !== at.item || press.col !== at.col || editing) return;
    if (press.wasActive) startEdit(at.item, at.col);
  };
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const at = cellAt(event.target);
    if (at && !editing) startEdit(at.item, at.col);
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const at = cellAt(event.target);
    const entry = at ? items[at.item] : null;
    if (!at || entry?.kind !== 'row') return;
    event.preventDefault();
    setActive(at);
    void rowMenu.current?.showFromEvent(event as MouseEvent<HTMLElement>, entry.row);
  };

  // ---- Drawing -------------------------------------------------------------------------------------
  const rendered: number[] = [];
  const pinned = new Set<number>();
  for (let i = range.start; i < Math.min(range.end, items.length); i++) rendered.push(i);
  // The active and the edited item stay drawn when scrolled away: focus and flyouts need them.
  for (const extra of [activeItem, editingItem])
    if (extra >= 0 && extra < items.length && !rendered.includes(extra)) {
      rendered.push(extra);
      pinned.add(extra);
    }

  const totalWidth = widths.reduce((a, b) => a + b, 0) + 48;
  const style = useMemo(() => {
    const s: Record<string, string> = { '--cgw-row-w': `${totalWidth}px` };
    widths.forEach((w, i) => (s[`--cgw-w-${i}`] = `${w}px`));
    return s as CSSProperties;
  }, [widths, totalWidth]);

  const activeDescendant =
    activeItem === -1
      ? `${gridId}-h${activeCol}`
      : items[activeItem]
        ? items[activeItem].kind === 'row'
          ? cellId(gridId, activeItem, activeCol)
          : cellId(gridId, activeItem, 0)
        : undefined;
  const menuDef = menu ? propertyOf(database, menu.propertyId) : undefined;
  const title = host.pageTitle(database.id) || t('untitledDatabase');
  const empty = snapshot.complete && snapshot.rows.length === 0 && !snapshot.loading;

  return (
    <div className={`cgw-table${embedded ? ' is-embedded' : ''}`}>
      <div
        ref={grid}
        role="grid"
        tabIndex={0}
        aria-label={t('table.label', { name: title })}
        aria-rowcount={snapshot.complete ? items.length + 1 : -1}
        aria-colcount={columns.length}
        aria-readonly={!editable || undefined}
        aria-activedescendant={activeDescendant}
        aria-busy={snapshot.loading || undefined}
        className="cgw-grid"
        style={style}
        onScroll={measure}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <TableHeader
          gridId={gridId}
          columns={columns}
          widths={widths}
          t={t}
          editable={editable}
          rtl={rtl}
          activeCol={activeItem === -1 ? activeCol : null}
          previewWidth={previewWidth}
          commitWidth={commitWidth}
          moveColumn={moveColumn}
          openMenu={openMenu}
          addProperty={addProperty}
          sortGlyph={sortGlyph}
        />
        <div className="cgw-tbody" role="rowgroup" style={{ blockSize: layout.total }}>
          {rendered.map((i) => {
            const item = items[i];
            const isActive = i === activeItem;
            const edit: EditingCell | null =
              i === editingItem && editing && editingCol >= 0
                ? { col: editingCol, seed: editing.seed }
                : null;
            return (
              <TableRow
                key={i === editingItem || pinned.has(i) ? item.key : `s${i % SLOTS}`}
                item={item}
                index={i}
                top={layout.offsets[i]}
                height={layout.offsets[i + 1] - layout.offsets[i]}
                gridId={gridId}
                columns={columns}
                env={env}
                activeCol={isActive ? activeCol : null}
                cols={cols}
                editing={edit}
                wrap={wrap}
                group={group}
                onEditDone={onEditDone}
                onOpenRow={openRow}
                onToggleGroup={toggleGroup}
                onNewRow={newRow}
                onLoadMore={loadMore}
              />
            );
          })}
        </div>
        {empty ? (
          <div className="cgw-table-empty" role="presentation">
            {searching || (config.filter?.children.length ?? 0) > 0
              ? t('table.noMatch')
              : t('table.empty')}
          </div>
        ) : null}
      </div>
      <div className="cgw-table-foot" role="status">
        {snapshot.loading && !snapshot.rows.length
          ? t('table.loadingRows')
          : snapshot.complete
            ? t('rowCount', { count: snapshot.total })
            : t('rowsShown', { shown: snapshot.rows.length, total: snapshot.total })}
      </div>
      {menu && menuDef ? (
        <PropertyMenu
          def={menuDef}
          database={database}
          view={view}
          rows={snapshot.rows}
          anchor={menu.anchor}
          initialPanel={menu.panel}
          onClose={() => {
            setMenu(null);
            focusGrid();
          }}
          onInserted={(def) => (pendingMenu.current = def.id)}
          onFilter={requestFilter ? (def: PropertyDef) => requestFilter(def.id) : undefined}
        />
      ) : null}
      {adding ? (
        <CellFlyout
          anchor={adding}
          label={t('property.addLabel')}
          width={240}
          onClose={() => setAdding(null)}
        >
          <TypePicker label={t('property.addLabel')} onPick={createProperty} />
        </CellFlyout>
      ) : null}
      <CgContextMenu<RowRecord>
        items={rowMenuItems}
        actionsRef={rowMenu}
        ariaLabel={t('row.menu')}
        afterClose={() => focusGrid()}
      />
    </div>
  );
}
