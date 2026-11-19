// The table view (ARIA grid): a sticky header and title column, rows virtualised at fixed
// heights (only the window and an overscan are drawn), optional collapsible group sections with
// counts, "load more" while rows remain, and a "New" row. Keyboard: arrows (mirrored in RTL),
// Home, End, PageUp, PageDown, Tab; Enter or F2 edits, typing starts an edit, Escape cancels,
// Delete clears, Ctrl+Enter opens the row, Shift+F10 its menu. On a header: Enter opens the
// property's menu, Alt+arrows resize, Alt+Shift+arrows move the column.
//
// Cells are selected (Phase 8, M8.3) by Shift and the arrows (and Home, End, PageUp, PageDown),
// Shift and a click, a drag of the pointer (scrolling at the edges), whole rows by Shift+Space or a
// row's handle, whole columns by Ctrl+Space or Shift and a click on a header, everything by Ctrl+A;
// Escape lets go. The selection is the table's state (selection.ts), so the virtual window
// scrolls under it. Ctrl+C copies it (TSV and HTML), Ctrl+V pastes into it, Delete clears it, each
// one batch of operations; the notice after a paste or a clear offers Undo (also Ctrl+Z here).
//
// For a screen reader (Phase 12, M12.3): a grouped table is a tree grid (a group's header a row at
// level 1, expanded or not, its rows at level 2), and the counts are the query's (`ariaLayout`):
// the row count is the header and the query's total, each row's index its place of it as the
// virtual window scrolls (in a tree grid every group's header takes a place too). The grid is
// described by its foot ("Rows: 1,234"). On a group's header Left and Right (mirrored in RTL)
// collapse and expand it, as Enter and Space toggle it. Editing is said through the live region
// when it starts, is saved and is cancelled, naming the property and the row's title; so is the
// "New" line, which is not in the accessibility tree, when the active cell reaches it.
import {
  CgContextMenu,
  CgLiveAnnouncer,
  cgEdgeScrollStep,
  type CgContextMenuActions,
  type CgContextMenuItem,
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
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useCellEnv, type CellEnv } from '../cells/env';
import type { EditEnd } from '../cells/InlineEditor';
import { CellFlyout } from '../cells/CellFlyout';
import { TITLE_PROPERTY, newPropertyId, type PropertyDef, type PropertyType } from '../core';
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
import { NewPropertySetup, SET_UP_FIRST } from '../properties/NewPropertySetup';
import { PropertyMenu, type PropertyPanel } from '../properties/PropertyMenu';
import { TypePicker } from '../properties/TypePicker';
import { groupText } from '../views/GroupLabel';
import type { ViewProps } from '../views/types';
import { CellNotice } from './CellNotice';
import {
  ariaLayout,
  buildItems,
  HEADER_HEIGHT,
  indexOfRow,
  itemHeight,
  type TableItem,
} from './items';
import { navigate, startsTyping, type GridPos } from './navigation';
import {
  cellAtPoint,
  extended,
  extendsSelection,
  extendTo,
  isRange,
  rectContains,
  rowItemsIn,
  selectionRect,
  wholeOf,
  type TableSelection,
} from './selection';
import { TableHeader } from './TableHeader';
import {
  cellId,
  itemDomId,
  moreCellId,
  TableRow,
  type EditingCell,
  type SelectedCols,
} from './TableRow';
import { useCellCommands } from './useCells';
import { useGridT } from './words';
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
  const { t, rtl, locale } = useDbT();
  const gridT = useGridT();
  const env = useCellEnv(host, actions, editable);
  // The cell being edited writes through this: a write is what makes an edit "saved" when it
  // ends (an inline editor commits on Enter, Tab or leaving it; a picker writes its choice when it
  // closes, Escape included), and none makes it "cancelled". For the title, the title written.
  const wrote = useRef<{ title: string | null } | null>(null);
  const editEnv = useMemo<CellEnv>(
    () => ({
      ...env,
      actions: {
        ...env.actions,
        setValue: (row, def, value) => {
          wrote.current = {
            title: def.type === 'title' && typeof value === 'string' ? value : null,
          };
          return env.actions.setValue(row, def, value);
        },
      },
    }),
    [env],
  );
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
  // What a screen reader counts: the query's total, each line's place of it (items.ts).
  const aria = useMemo(() => ariaLayout(items, snapshot), [items, snapshot]);
  const tree = snapshot.groups !== null;
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
  const [settingUp, setSettingUp] = useState<{ def: PropertyDef; anchor: HTMLElement } | null>(
    null,
  );
  const pendingMenu = useRef<string | null>(null);
  const pendingRow = useRef<string | null>(null);
  const activeItem = Math.min(active.item, items.length - 1);
  const activeCol = Math.min(active.col, Math.max(0, columns.length - 1));
  const editingItem = editing ? indexOfRow(items, editing.rowId, editing.group) : -1;
  const editingCol = editing ? columns.findIndex((c) => c.id === editing.propertyId) : -1;

  // ---- The selection ------------------------------------------------------------------------
  const [selection, setSelection] = useState<TableSelection | null>(null);
  const live = useRef<CgLiveAnnouncerHandle>(null);
  const say = (text: string) => live.current?.announce(text);
  /** The property and the row's title an edit is said with, while it lasts. */
  const editSaid = useRef<{ property: string; title: string } | null>(null);
  const beginSaying = (def: PropertyDef, title: string) => {
    wrote.current = null;
    editSaid.current = { property: def.name || t('untitled'), title: title || t('untitled') };
    say(gridT('editing', editSaid.current));
  };
  // The "New" line is not in the accessibility tree: it is said when the active cell reaches it.
  const activeEntry = items[activeItem];
  const newLineGroup = activeEntry?.kind === 'new' ? (activeEntry.group ?? '') : null;
  useEffect(() => {
    if (newLineGroup === null || document.activeElement !== grid.current) return;
    live.current?.announce(
      group && activeEntry?.kind === 'new' && activeEntry.group !== null
        ? gridT('newRowIn', { name: groupText(group.def, group.rule, activeEntry.group, env) })
        : gridT('newRow'),
    );
    // Said once as the line is reached, not again as the rows around it change.
  }, [activeItem, newLineGroup]);
  const activePos: GridPos = { item: activeItem, col: activeCol };
  const rect =
    items.length && (activeItem >= 0 || selection)
      ? selectionRect(selection, activePos, { count: items.length, cols: columns.length })
      : null;
  const ranged = !!rect && !!selection && isRange(rect);
  const whole = selection?.mode === 'rows' || selection?.mode === 'all';
  const selLeft = rect?.left ?? -1;
  const selRight = rect?.right ?? -1;
  const selCols = useMemo<SelectedCols | null>(
    () => (selLeft >= 0 ? { left: selLeft, right: selRight, whole, range: ranged } : null),
    [selLeft, selRight, whole, ranged],
  );
  const headerCols =
    rect && (selection?.mode === 'columns' || selection?.mode === 'all')
      ? { left: rect.left, right: rect.right }
      : null;
  const isRowAt = (i: number) => items[i]?.kind === 'row';
  /** Says the selection's size through the live region. */
  const sayRect = (next: TableSelection | null, at: GridPos) => {
    if (!next) return;
    const r = selectionRect(next, at, { count: items.length, cols: columns.length });
    live.current?.announce(
      t('cells.selected', {
        rows: rowItemsIn(r, isRowAt).length.toLocaleString(locale),
        columns: (r.right - r.left + 1).toLocaleString(locale),
      }),
    );
  };

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
    setSelection(null);
    const def = columns[col];
    if (!def || !isEditableType(def.type)) return;
    const kind = editKind(def.type);
    if (kind === 'toggle') {
      void actions.setValue(entry.row, def, entry.row.values[def.id] !== true);
      say(
        gridT('saved', {
          property: def.name || t('untitled'),
          title: entry.row.title || t('untitled'),
        }),
      );
      return;
    }
    if (kind === 'none') return;
    setActive({ item, col });
    setEditing({ rowId: entry.row.id, group: entry.group, propertyId: def.id, seed });
    beginSaying(def, entry.row.title);
  };

  const onEditDone = useCallback(
    (end: EditEnd) => {
      setEditing(null);
      focusGrid();
      if (end === 'tab' || end === 'shiftTab')
        setActive((pos) => {
          const next = navigate(
            pos,
            { key: 'Tab', shiftKey: end === 'shiftTab' },
            shapeRef.current,
          );
          return next && next !== 'leave' ? next : pos;
        });
      // Saved when the editor wrote a value (a title by the one written), else cancelled.
      const said = editSaid.current;
      const written = wrote.current;
      editSaid.current = null;
      wrote.current = null;
      if (!said) return;
      const title = written?.title == null ? said.title : written.title || t('untitled');
      live.current?.announce(
        written ? gridT('saved', { ...said, title }) : gridT('cancelled', said),
      );
    },
    [gridT, t],
  );

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
    const titleDef = columns.find((c) => c.id === TITLE_PROPERTY);
    if (titleDef) beginSaying(titleDef, entry.row.title);
    requestAnimationFrame(() => reveal(at, 0));
    // `beginSaying` and `columns` are read when a row made here first shows, not followed.
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
  /** Shift and a click on a header: whole columns, from the selection's start to this one. */
  const selectRef = useRef<(col: number) => void>(() => undefined);
  selectRef.current = (col: number) => {
    if (!items.length) return;
    const at = { item: Math.max(0, activeItem), col };
    const next: TableSelection = {
      anchor: selection?.anchor ?? { item: at.item, col: activeCol },
      mode: selection?.mode === 'rows' || selection?.mode === 'all' ? 'all' : 'columns',
    };
    setSelection(next);
    setActive(at);
    focusGrid();
    sayRect(next, at);
  };
  const selectColumns = useCallback((col: number) => selectRef.current(col), []);
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

  const lastPlace = () => {
    const last = columns[columns.length - 1];
    return last ? { view, anchor: last.id, side: 'after' as const } : undefined;
  };
  const createProperty = (type: PropertyType) => {
    const anchor = adding;
    setAdding(null);
    const name = uniqueName(database, t(`type.${type}`));
    // A relation or a rollup is set up first: written without its settings it is refused.
    if (SET_UP_FIRST.includes(type)) {
      if (anchor) setSettingUp({ def: { id: newPropertyId(), name, type }, anchor });
      return;
    }
    const def = newPropertyDef(type, name, {
      todo: t('option.defaultTodo'),
      inProgress: t('option.defaultInProgress'),
      complete: t('option.defaultComplete'),
    });
    pendingMenu.current = def.id;
    void actions.addProperty(def, lastPlace());
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

  // ---- Copy, paste, clear ---------------------------------------------------------------------
  const cells = useCellCommands({
    host,
    database,
    view,
    snapshot,
    items,
    columns,
    editable,
    env,
    t,
    locale,
    rect,
    ranged,
    select: (anchor, at) => {
      setSelection({ anchor, mode: 'cells' });
      setActive(at);
    },
    say: (text) => live.current?.announce(text),
  });
  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== grid.current || editing) return;
    const made = cells.copy();
    if (!made) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', made.text);
    event.clipboardData.setData('text/html', made.html);
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== grid.current || editing) return;
    event.preventDefault();
    void cells.paste(
      event.clipboardData.getData('text/plain'),
      event.clipboardData.getData('text/html'),
    );
  };
  // With nothing selected in the document, a browser offers Copy and Paste on a focused element
  // only when its `beforecopy` and `beforepaste` are cancelled (React has no handler for them).
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const allow = (event: Event) => {
      if (event.target === el) event.preventDefault();
    };
    el.addEventListener('beforecopy', allow);
    el.addEventListener('beforepaste', allow);
    return () => {
      el.removeEventListener('beforecopy', allow);
      el.removeEventListener('beforepaste', allow);
    };
  }, []);

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
    const code = event.nativeEvent.code;
    // The direction the grid is drawn in: the nearest `dir`, as every CashGear control reads it.
    const dir = grid.current?.closest('[dir]')?.getAttribute('dir');
    const dirRtl = dir ? dir.toLowerCase() === 'rtl' : rtl;

    // The selection: extend it, whole rows or columns, everything, let go; Undo of a paste.
    if (event.key === 'Escape' && selection) {
      event.preventDefault();
      setSelection(null);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && code === 'KeyZ' && cells.undo()) {
      event.preventDefault();
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && code === 'KeyA' && items.length) {
      event.preventDefault();
      const next: TableSelection = { anchor: { item: 0, col: 0 }, mode: 'all' };
      const at = { item: Math.max(0, pos.item), col: pos.col };
      setSelection(next);
      if (pos.item < 0) setActive(at);
      sayRect(next, at);
      return;
    }
    if (code === 'Space' && !event.altKey && event.shiftKey !== mod && items.length) {
      if (event.shiftKey && pos.item < 0) return;
      event.preventDefault();
      const at = { item: Math.max(0, pos.item), col: pos.col };
      const next = wholeOf(selection, at, event.shiftKey ? 'rows' : 'columns');
      setSelection(next);
      if (pos.item < 0) setActive(at);
      sayRect(next, at);
      return;
    }
    if (extendsSelection(event) && items.length) {
      const next = extendTo(pos, event, { ...shape, rtl: dirRtl });
      if (next) {
        event.preventDefault();
        const made = extended(selection, pos);
        setSelection(made);
        moveTo(next);
        sayRect(made, next);
      }
      return;
    }

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

    // A group's header, as a tree grid's row: forward (Right, or Left in RTL) expands it, back
    // collapses it.
    if (
      entry?.kind === 'group' &&
      !mod &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      event.preventDefault();
      const forward = (event.key === 'ArrowRight') !== dirRtl;
      if (forward === entry.collapsed) toggleGroup(entry.group);
      return;
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
      if ((event.key === 'Delete' || event.key === 'Backspace') && ranged) {
        event.preventDefault();
        void cells.clear();
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
    setSelection(null);
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
  /** The cell under a point of the window, for a drag that leaves the cells. */
  const cellAtClient = (x: number, y: number): GridPos | null => {
    const el = grid.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const dirRtl = getComputedStyle(el).direction === 'rtl';
    return cellAtPoint(
      layout.offsets,
      items.length,
      widths,
      el.scrollTop,
      el.scrollLeft,
      dirRtl ? box.right - x : x - box.left,
      y - box.top - HEADER_HEIGHT,
    );
  };
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  /**
   * A drag from a cell (or a row's handle) selects from it to the cell under the pointer, the
   * window scrolling near the grid's edges. Listened for on the window until the button is up.
   */
  const dragSelect = (start: GridPos, mode: 'cells' | 'rows') => {
    stopDrag.current?.();
    let x = 0;
    let y = 0;
    let frame = 0;
    let last = start;
    const to = (found: GridPos | null) => {
      let at = found;
      if (!at || (at.item === last.item && at.col === last.col)) return;
      if (items[at.item]?.kind !== 'row' && at.item !== start.item) {
        // Group headers and "New" are passed over: the nearest row towards the start.
        const step = at.item > start.item ? -1 : 1;
        let i = at.item;
        while (i !== start.item && items[i]?.kind !== 'row') i += step;
        at = { item: i, col: at.col };
      }
      last = at;
      if (pressed.current) pressed.current.wasActive = false;
      setSelection({ anchor: mode === 'rows' ? { item: start.item, col: 0 } : start, mode });
      setActive(mode === 'rows' ? { item: at.item, col: activeCol } : at);
    };
    const tick = () => {
      frame = 0;
      const el = grid.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      // Nothing laid out (jsdom): nothing to scroll.
      if (!box.width || !box.height) return;
      const dy = cgEdgeScrollStep(y, box.top + HEADER_HEIGHT, box.bottom);
      const dx = mode === 'cells' ? cgEdgeScrollStep(x, box.left, box.right) : 0;
      if (dx || dy) {
        el.scrollBy?.(dx, dy);
        to(cellAtClient(x, y));
        frame = requestAnimationFrame(tick);
      }
    };
    const onMove = (move: globalThis.MouseEvent) => {
      // The button came up outside the window: the drag is over.
      if ((move.buttons & 1) === 0) return onUp();
      x = move.clientX;
      y = move.clientY;
      const target = move.target as HTMLElement | null;
      const inside = target?.closest?.('.cgw-grid') === grid.current;
      to(inside ? cellAt(target) : cellAtClient(x, y));
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      stopDrag.current = null;
    };
    const onUp = () => {
      finish();
      if (last.item !== start.item || last.col !== start.col || mode === 'rows')
        sayRect({ anchor: start, mode }, last);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    stopDrag.current = finish;
  };
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.cgw-inline-editor, .cgw-thead')) return;
    const at = cellAt(target);
    if (!at) return;
    const handle = !!target.closest('.cgw-db-row-select');
    pressed.current = {
      ...at,
      wasActive:
        !handle &&
        !event.shiftKey &&
        !selection &&
        at.item === activeItem &&
        at.col === activeCol &&
        document.activeElement === grid.current,
    };
    if (editing) return;
    event.preventDefault();
    focusGrid();
    const isRow = items[at.item]?.kind === 'row';
    if (handle && isRow) {
      // A row's handle: the whole row, or with Shift whole rows from the selection's start.
      const anchor =
        event.shiftKey && selection
          ? { item: selection.anchor.item, col: 0 }
          : event.shiftKey
            ? { item: Math.max(0, activeItem), col: 0 }
            : { item: at.item, col: 0 };
      setSelection({ anchor, mode: 'rows' });
      setActive({ item: at.item, col: activeCol });
      if (event.button === 0) dragSelect(anchor, 'rows');
      return;
    }
    if (event.shiftKey && isRow && activeItem >= 0) {
      setSelection(extended(selection, activePos));
      setActive(at);
      return;
    }
    // A right click inside the selection keeps it (the row menu opens on it).
    if (!(rect && selection && event.button !== 0 && rectContains(rect, at.item, at.col)))
      setSelection(null);
    setActive(at);
    if (event.button === 0 && isRow) dragSelect(at, 'cells');
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
    if (!rect || !rectContains(rect, at.item, at.col)) setSelection(null);
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
  // In their order: Chromium gives a row whose `aria-rowindex` is not above the one before it the
  // next index instead, so a pinned row drawn after the window would be read with a wrong place.
  if (pinned.size) rendered.sort((a, b) => a - b);

  const totalWidth = widths.reduce((a, b) => a + b, 0) + 48;
  const style = useMemo(() => {
    const s: Record<string, string> = { '--cgw-row-w': `${totalWidth}px` };
    widths.forEach((w, i) => (s[`--cgw-w-${i}`] = `${w}px`));
    return s as CSSProperties;
  }, [widths, totalWidth]);

  // A row's cell; a group's header row itself (its expanded state and place are the row's); the
  // "load more" line's cell; nothing on a "New" line (not in the accessibility tree: the live
  // region says it).
  const activeDescendant =
    activeItem === -1
      ? `${gridId}-h${activeCol}`
      : activeEntry?.kind === 'row'
        ? cellId(gridId, activeItem, activeCol)
        : activeEntry?.kind === 'group'
          ? itemDomId(gridId, activeItem)
          : activeEntry?.kind === 'more'
            ? moreCellId(gridId, activeItem)
            : undefined;
  const menuDef = menu ? propertyOf(database, menu.propertyId) : undefined;
  const title = host.pageTitle(database.id) || t('untitledDatabase');
  const empty = snapshot.complete && snapshot.rows.length === 0 && !snapshot.loading;
  const footId = `${gridId}-foot`;

  return (
    <div className={`cgw-db-table${embedded ? ' is-embedded' : ''}`}>
      <div
        ref={grid}
        role={tree ? 'treegrid' : 'grid'}
        tabIndex={0}
        aria-label={t('table.label', { name: title })}
        aria-describedby={footId}
        aria-rowcount={aria.rowCount}
        aria-colcount={columns.length}
        aria-readonly={!editable || undefined}
        aria-multiselectable="true"
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
        onCopy={onCopy}
        onPaste={onPaste}
      >
        <TableHeader
          gridId={gridId}
          columns={columns}
          widths={widths}
          t={t}
          editable={editable}
          rtl={rtl}
          activeCol={activeItem === -1 ? activeCol : null}
          selectedCols={headerCols}
          selectColumns={selectColumns}
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
                rowIndex={aria.rowIndex[i]}
                level={aria.level[i]}
                posInSet={aria.posInSet[i]}
                setSize={aria.setSize[i]}
                top={layout.offsets[i]}
                height={layout.offsets[i + 1] - layout.offsets[i]}
                gridId={gridId}
                columns={columns}
                env={env}
                editEnv={editEnv}
                activeCol={isActive ? activeCol : null}
                cols={cols}
                editing={edit}
                selected={
                  rect && i >= rect.top && i <= rect.bottom && item.kind === 'row' ? selCols : null
                }
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
      {cells.notice ? <CellNotice notice={cells.notice} t={t} onClose={cells.closeNotice} /> : null}
      <CgLiveAnnouncer ref={live} />
      <div className="cgw-table-foot" id={footId} role="status">
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
      {settingUp ? (
        <NewPropertySetup
          def={settingUp.def}
          database={database}
          anchor={settingUp.anchor}
          onSave={({ def, reverse }) =>
            void (def.type === 'relation'
              ? actions.addRelation(def, reverse, lastPlace())
              : actions.addProperty(def, lastPlace()))
          }
          onClose={() => {
            setSettingUp(null);
            focusGrid();
          }}
        />
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
