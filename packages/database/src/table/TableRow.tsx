// One item of the table: a row of cells, a group header, "load more" or "New". Memoised: while
// the table scrolls only items that come into the window are drawn, and an item is drawn again
// only when its row, the columns, or the active or edited cell in it change.
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
export const widthVar = (col: number) => `var(--cgw-w-${col})`;

export interface EditingCell {
  col: number;
  seed: string | null;
}

export interface TableRowProps {
  item: TableItem;
  index: number;
  top: number;
  height: number;
  gridId: string;
  columns: readonly PropertyDef[];
  env: CellEnv;
  /** The active column when this item holds the active cell. */
  activeCol: number | null;
  /** Columns drawn besides the title (the horizontal window); others are one spacer. */
  cols: Range;
  editing: EditingCell | null;
  wrap: boolean;
  group: { rule: GroupRule; def: PropertyDef | undefined } | null;
  onEditDone(end: EditEnd): void;
  onOpenRow(rowId: string): void;
  onToggleGroup(key: string): void;
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
      role="gridcell"
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
  const rowIndex = index + 2;
  const active = activeCol !== null;

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
          {name}
          <span className="cgw-group-count">{env.t('group.count', { count: item.count })}</span>
        </span>
      );
    } else if (item.kind === 'more') {
      content = (
        <button
          type="button"
          className="cgw-text-button"
          tabIndex={-1}
          onClick={() => props.onLoadMore(item.group)}
        >
          {env.t('table.loadMore')}
        </button>
      );
    } else {
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
    }
    return (
      <div
        role="row"
        id={itemDomId(gridId, index)}
        aria-rowindex={rowIndex}
        className={`cgw-trow cgw-trow-${item.kind}`}
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
  }

  const row = item.row;
  return (
    <div
      role="row"
      id={itemDomId(gridId, index)}
      aria-rowindex={rowIndex}
      className={`cgw-trow${wrap ? ' is-wrapped' : ''}`}
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
        }`;
        const cellStyle: CSSProperties = { inlineSize: widthVar(col) };
        const id = cellId(gridId, index, col);
        let content = renderCell(def, row, env);
        if (def.type === 'title') {
          content = (
            <>
              <span className="cgw-title-text">
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
              env={env}
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
            role="gridcell"
            aria-colindex={col + 1}
            aria-selected={activeCol === col || undefined}
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
