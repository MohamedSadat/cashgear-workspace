// One item of the table: a row of cells, a group header, "load more" or "New". Memoised: while
// the table scrolls only items that come into the window are drawn, and an item is drawn again
// only when its row, the columns, the active or edited cell in it, or the selected columns of it
// change. A row's title cell starts with its handle (`CgDragHandle`), which selects the whole row
// and, dragged, whole rows from it (Phase 8).
//
// For a screen reader (Phase 12, M12.3): the title cell is the row's header (`rowheader`, named by
// the title alone), every other cell a `gridcell`; each row says its place of the query's total
// (`aria-rowindex`, from `ariaLayout`), and in a tree grid its level and its place in its group.
// A group's header is a row of the tree grid (expanded or not, named by its group and count);
// "load more" stands where the next row will be; the "New" line is not in the accessibility tree
// (the table says it through its live region when the active cell reaches it).
import { CgDragHandle } from '@cashgear/ui';
import { memo, useState, type CSSProperties, type ReactNode } from 'react';
import { renderCell } from '../cells/CellDisplay';
import type { CellEnv } from '../cells/env';
import { InlineEditor, type EditEnd } from '../cells/InlineEditor';
import { PickerEditor } from '../cells/PickerEditor';
import type { GroupRule, PropertyDef } from '../core';
import { editKind } from '../model/properties';
import { GroupLabel, groupText } from '../views/GroupLabel';
import type { TableItem } from './items';
import type { Range } from './windowing';

export const cellId = (gridId: string, item: number, col: number) => `${gridId}-c${item}-${col}`;
export const itemDomId = (gridId: string, item: number) => `${gridId}-i${item}`;
/**
 * The "load more" line's cell: an id of its own, so when the rows it stood for arrive at its place
 * the active descendant changes and a screen reader reads the row that is there now.
 */
export const moreCellId = (gridId: string, item: number) => `${gridId}-m${item}`;
export const widthVar = (col: number) => `var(--cgw-w-${col})`;

export interface EditingCell {
  col: number;
  seed: string | null;
}

/** The columns of a row the selection covers (one object per selection, shared by its rows). */
export interface SelectedCols {
  left: number;
  right: number;
  /** The selection is of whole rows: the row's handle shows it. */
  whole: boolean;
  /** More than one cell: the cells are tinted (a single cell is only the active one). */
  range: boolean;
}

export interface TableRowProps {
  item: TableItem;
  index: number;
  /** `aria-rowindex` (0: the item is no row of the grid, a "New" line). */
  rowIndex: number;
  /** In a tree grid: `aria-level`, `aria-posinset` and `aria-setsize` (0: none, ungrouped). */
  level: number;
  posInSet: number;
  setSize: number;
  top: number;
  height: number;
  gridId: string;
  columns: readonly PropertyDef[];
  env: CellEnv;
  /** What the cell being edited writes through (the table hears from it whether a value was saved). */
  editEnv: CellEnv;
  /** The active column when this item holds the active cell. */
  activeCol: number | null;
  /** Columns drawn besides the title (the horizontal window); others are one spacer. */
  cols: Range;
  editing: EditingCell | null;
  /** The columns the selection covers when this item is in it. */
  selected: SelectedCols | null;
  wrap: boolean;
  group: { rule: GroupRule; def: PropertyDef | undefined } | null;
  onEditDone(end: EditEnd): void;
  onOpenRow(rowId: string): void;
  onToggleGroup(key: string): void;
  /** Phase 17: shows or hides a nested row's sub-items. */
  onToggleRow?(rowId: string): void;
  /** Phase 17: the words a nested row's toggle says. */
  subWords?: { expand(title: string): string; collapse(title: string): string; context: string };
  onNewRow(group: string | null): void;
  onLoadMore(group: string | null): void;
}

function EditingCellView({
  def,
  item,
  env,
  editing,
  onEditDone,
  className,
  style,
  id,
  colIndex,
  children,
}: {
  def: PropertyDef;
  item: Extract<TableItem, { kind: 'row' }>;
  env: CellEnv;
  editing: EditingCell;
  onEditDone(end: EditEnd): void;
  className: string;
  style: CSSProperties;
  id: string;
  colIndex: number;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const kind = editKind(def.type);
  return (
    <div
      ref={setAnchor}
      id={id}
      role={def.type === 'title' ? 'rowheader' : 'gridcell'}
      aria-colindex={colIndex + 1}
      aria-selected="true"
      className={`${className} is-editing`}
      style={style}
      data-col={colIndex}
    >
      {kind === 'inline' ? (
        <InlineEditor
          def={def}
          row={item.row}
          env={env}
          seed={editing.seed}
          onDone={onEditDone}
          label={def.name}
        />
      ) : (
        <>
          {children}
          {anchor ? (
            <PickerEditor
              def={def}
              row={item.row}
              env={env}
              anchor={anchor}
              seed={editing.seed}
              onDone={onEditDone}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function TableRowView(props: TableRowProps) {
  const { item, index, top, height, gridId, columns, env, activeCol, editing, wrap } = props;
  const style: CSSProperties = { insetBlockStart: top, blockSize: height };
  const { rowIndex } = props;
  // A tree grid's row: its level, and its place in its group (a group's among the groups).
  const tree = props.level
    ? { 'aria-level': props.level, 'aria-posinset': props.posInSet, 'aria-setsize': props.setSize }
    : null;
  const active = activeCol !== null;
  const rowDomId = itemDomId(gridId, index);

  if (item.kind !== 'row') {
    const span = columns.length;
    let content: ReactNode;
    if (item.kind === 'group') {
      const name = props.group ? (
        <GroupLabel def={props.group.def} rule={props.group.rule} groupKey={item.group} env={env} />
      ) : null;
      content = (
        <span className="cgw-group-head">
          <button
            type="button"
            className="cgw-icon-button cgw-group-toggle"
            tabIndex={-1}
            aria-expanded={!item.collapsed}
            aria-label={env.t(item.collapsed ? 'group.expand' : 'group.collapse', {
              name: props.group
                ? groupText(props.group.def, props.group.rule, item.group, env)
                : '',
            })}
            onClick={() => props.onToggleGroup(item.group)}
          >
            <span aria-hidden="true" className="cgw-chevron" data-open={!item.collapsed}>
              ›
            </span>
          </button>
          <span id={`${rowDomId}-n`}>{name}</span>
          <span id={`${rowDomId}-c`} className="cgw-group-count">
            {env.t('group.count', { count: item.count })}
          </span>
        </span>
      );
      // The group's header is the tree grid's row at level 1: the active descendant when it is
      // reached (so its expanded state and place are read), named by its group and its count.
      return (
        <div
          role="row"
          id={rowDomId}
          aria-rowindex={rowIndex}
          {...tree}
          aria-expanded={!item.collapsed}
          aria-labelledby={`${rowDomId}-n ${rowDomId}-c`}
          className="cgw-trow cgw-trow-group"
          style={style}
          data-item={index}
        >
          <div
            role="gridcell"
            id={cellId(gridId, index, 0)}
            aria-colindex={1}
            aria-colspan={span}
            className={`cgw-tcell cgw-tcell-wide${active ? ' is-active' : ''}`}
            data-col={0}
          >
            <span className="cgw-sticky-start">{content}</span>
          </div>
        </div>
      );
    } else if (item.kind === 'more') {
      // A row at the place of the first row not loaded yet (in a tree grid, at its place in the
      // group): it stands for the rows to come and adds none to the count.
      return (
        <div
          role="row"
          id={rowDomId}
          aria-rowindex={rowIndex}
          {...tree}
          className="cgw-trow cgw-trow-more"
          style={style}
          data-item={index}
        >
          <div
            role="gridcell"
            id={moreCellId(gridId, index)}
            aria-colindex={1}
            aria-colspan={span}
            className={`cgw-tcell cgw-tcell-wide${active ? ' is-active' : ''}`}
            data-col={0}
          >
            <span className="cgw-sticky-start">
              <button
                type="button"
                className="cgw-text-button"
                tabIndex={-1}
                onClick={() => props.onLoadMore(item.group)}
              >
                {env.t('table.loadMore')}
              </button>
            </span>
          </div>
        </div>
      );
    }
    // The "New" line is no row of the grid: a row would be counted (Chromium raises the count to
    // the highest index), so it is hidden from the accessibility tree. The keys still reach it and
    // Enter adds a row there; the table's live region says what it is (the toolbar's New is the
    // same action for a screen reader's browse mode).
    content = (
      <button
        type="button"
        className="cgw-new-row"
        tabIndex={-1}
        aria-label={
          props.group && item.group !== null
            ? env.t('table.newRowIn', {
                name: groupText(props.group.def, props.group.rule, item.group, env),
              })
            : undefined
        }
        onClick={() => props.onNewRow(item.group)}
      >
        <span aria-hidden="true">＋ </span>
        {env.t('table.newRow')}
      </button>
    );
    return (
      <div
        id={rowDomId}
        aria-hidden="true"
        className="cgw-trow cgw-trow-new"
        style={style}
        data-item={index}
      >
        <div
          id={cellId(gridId, index, 0)}
          className={`cgw-tcell cgw-tcell-wide${active ? ' is-active' : ''}`}
          data-col={0}
        >
          <span className="cgw-sticky-start">{content}</span>
        </div>
      </div>
    );
  }

  const row = item.row;
  const sel = props.selected;
  const inSel = (c: number) => !!sel && c >= sel.left && c <= sel.right;
  // Phase 17: a nested row, its sub-items shown or hidden by its toggle.
  const sub = item.sub;
  const named = row.title || env.t('untitled');
  return (
    <div
      role="row"
      id={rowDomId}
      aria-rowindex={rowIndex}
      {...tree}
      aria-expanded={sub && sub.children > 0 ? !sub.collapsed : undefined}
      aria-selected={sel?.whole || undefined}
      className={`cgw-trow${wrap ? ' is-wrapped' : ''}${sel?.whole ? ' is-row-selected' : ''}${
        sub?.context ? ' is-context' : ''
      }`}
      style={style}
      data-item={index}
    >
      {columns.map((def, col) => {
        // Columns out of the horizontal window are not drawn: one spacer stands for each run.
        const drawn = (c: number) =>
          c === 0 ||
          (c >= props.cols.start && c < props.cols.end) ||
          c === activeCol ||
          editing?.col === c;
        if (!drawn(col)) {
          if (drawn(col - 1) || col === 0) {
            let last = col;
            while (last + 1 < columns.length && !drawn(last + 1)) last++;
            const terms: string[] = [];
            for (let c = col; c <= last; c++) terms.push(`var(--cgw-w-${c})`);
            return (
              <div
                key={`gap${col}`}
                className="cgw-tcell-gap"
                aria-hidden="true"
                style={{ inlineSize: `calc(${terms.join(' + ')})` }}
              />
            );
          }
          return null;
        }
        const className = `cgw-tcell cgw-type-${def.type}${col === 0 ? ' cgw-tcell-title' : ''}${
          activeCol === col ? ' is-active' : ''
        }${sel?.range && inSel(col) ? ' is-selected' : ''}`;
        const cellStyle: CSSProperties = { inlineSize: widthVar(col) };
        const id = cellId(gridId, index, col);
        const title = def.type === 'title';
        let content = renderCell(def, row, env);
        if (title) {
          const nest = sub ? (
            <span
              className="cgw-db-sub-indent"
              style={{ inlineSize: `${sub.depth * 18 + 18}px` }}
              aria-hidden={sub.children > 0 ? undefined : true}
            >
              {sub.children > 0 ? (
                <button
                  type="button"
                  className="cgw-icon-button cgw-db-sub-toggle"
                  tabIndex={-1}
                  aria-label={
                    sub.collapsed ? props.subWords?.expand(named) : props.subWords?.collapse(named)
                  }
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleRow?.(row.id);
                  }}
                >
                  <span aria-hidden="true" className="cgw-chevron" data-open={!sub.collapsed}>
                    ›
                  </span>
                </button>
              ) : null}
            </span>
          ) : null;
          content = (
            <>
              {nest}
              <CgDragHandle
                className="cgw-db-row-select"
                tabIndex={-1}
                label={env.t('cells.selectRow', { title: row.title || env.t('untitled') })}
              />
              <span className="cgw-title-text" id={`${id}-t`}>
                {row.icon ? (
                  <span className="cgw-row-icon" aria-hidden="true">
                    {row.icon}
                  </span>
                ) : null}
                {content ?? <span className="cgw-placeholder">{env.t('untitled')}</span>}
              </span>
              <button
                type="button"
                className="cgw-open-row"
                tabIndex={-1}
                aria-label={env.t('cell.openRow', { title: row.title || env.t('untitled') })}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenRow(row.id);
                }}
              >
                {env.t('cell.open')}
              </button>
            </>
          );
        }
        if (editing && editing.col === col)
          return (
            <EditingCellView
              key={def.id}
              def={def}
              item={item}
              env={props.editEnv}
              editing={editing}
              onEditDone={props.onEditDone}
              className={className}
              style={cellStyle}
              id={id}
              colIndex={col}
            >
              {content}
            </EditingCellView>
          );
        return (
          <div
            key={def.id}
            id={id}
            // The title is the row's header: a screen reader names the row by it as one moves
            // down a column. Named by the title alone, not its handle's or Open's labels.
            role={title ? 'rowheader' : 'gridcell'}
            aria-labelledby={title ? `${id}-t` : undefined}
            aria-colindex={col + 1}
            aria-selected={inSel(col) || activeCol === col}
            className={className}
            style={cellStyle}
            data-col={col}
          >
            {content}
          </div>
        );
      })}
      <div className="cgw-tcell cgw-tcell-pad" aria-hidden="true" />
    </div>
  );
}

export const TableRow = memo(TableRowView);
