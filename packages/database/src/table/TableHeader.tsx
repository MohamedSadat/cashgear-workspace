// The table's header row: a cell per shown property (its type's glyph and its name), which opens
// the property's menu when clicked, reorders the columns when dragged, and has a resize handle at
// its inline end. Width changes during a drag are written to the grid's CSS variables directly
// (nothing React-rendered changes while the pointer moves); the width is written to the view once,
// when the drag ends. The "+" at the end adds a property.
import { memo, useRef, type PointerEvent } from 'react';
import type { PropertyDef } from '../core';
import type { DbT } from '../i18n';
import { MAX_WIDTH, MIN_WIDTH, TYPE_GLYPH } from '../model/properties';
import { widthVar } from './TableRow';

export const headerId = (gridId: string, col: number) => `${gridId}-h${col}`;

export interface TableHeaderProps {
  gridId: string;
  columns: readonly PropertyDef[];
  widths: readonly number[];
  t: DbT;
  editable: boolean;
  rtl: boolean;
  activeCol: number | null;
  /** Sets a column's width on the grid while it is dragged. */
  previewWidth(col: number, width: number): void;
  commitWidth(col: number, width: number): void;
  /** Moves a column before or after another (by index among the shown columns). */
  moveColumn(from: number, to: number, side: 'before' | 'after'): void;
  openMenu(col: number, anchor: HTMLElement): void;
  addProperty(anchor: HTMLElement): void;
  sortGlyph(id: string): string | null;
}

function TableHeaderView(props: TableHeaderProps) {
  const { gridId, columns, widths, t, editable, rtl, activeCol } = props;
  const drag = useRef<{
    kind: 'resize' | 'move';
    col: number;
    pointerId: number;
    startX: number;
    startWidth: number;
    moved: boolean;
    target: { col: number; side: 'before' | 'after' } | null;
  } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);

  const clearDrop = () =>
    headRef.current
      ?.querySelectorAll('[data-drop]')
      .forEach((el) => el.removeAttribute('data-drop'));

  const onResizeDown = (col: number) => (event: PointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      kind: 'resize',
      col,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widths[col],
      moved: false,
      target: null,
    };
  };

  const onCellDown = (col: number) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      kind: 'move',
      col,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widths[col],
      moved: false,
      target: null,
    };
  };

  const onMove = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    if (d.kind === 'resize') {
      d.moved = true;
      const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, d.startWidth + (rtl ? -dx : dx)));
      props.previewWidth(d.col, width);
      return;
    }
    // The title column stays first; only the others move, and only when the person may edit.
    if (!editable || d.col === 0) return;
    if (!d.moved && Math.abs(dx) < 5) return;
    if (!d.moved) {
      d.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const cells = [...(headRef.current?.querySelectorAll<HTMLElement>('[data-head-col]') ?? [])];
    clearDrop();
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right) continue;
      const col = Number(cell.dataset.headCol);
      const firstHalf = event.clientX < rect.left + rect.width / 2;
      // Before is the left half in LTR and the right half in RTL.
      let side: 'before' | 'after' = firstHalf !== rtl ? 'before' : 'after';
      if (col === 0) side = 'after';
      d.target = { col, side };
      cell.setAttribute('data-drop', side);
      break;
    }
  };

  const onUp = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.pointerId !== event.pointerId) return;
    if (d.kind === 'resize') {
      if (d.moved) {
        const dx = event.clientX - d.startX;
        const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, d.startWidth + (rtl ? -dx : dx)));
        props.commitWidth(d.col, Math.round(width));
      }
      return;
    }
    clearDrop();
    if (!d.moved) {
      const cell = headRef.current?.querySelector<HTMLElement>(`[data-head-col="${d.col}"]`);
      if (cell) props.openMenu(d.col, cell);
      return;
    }
    if (d.target && d.target.col !== d.col) props.moveColumn(d.col, d.target.col, d.target.side);
  };

  const onCancel = () => {
    drag.current = null;
    clearDrop();
  };

  return (
    <div
      ref={headRef}
      role="row"
      aria-rowindex={1}
      className="cgw-thead"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      {columns.map((def, col) => {
        const sort = props.sortGlyph(def.id);
        return (
          <div
            key={def.id}
            id={headerId(gridId, col)}
            role="columnheader"
            aria-colindex={col + 1}
            aria-sort={sort === '↑' ? 'ascending' : sort === '↓' ? 'descending' : undefined}
            aria-label={t('property.header', { name: def.name, type: t(`type.${def.type}`) })}
            aria-haspopup="dialog"
            data-head-col={col}
            className={`cgw-th${col === 0 ? ' cgw-th-title' : ''}${activeCol === col ? ' is-active' : ''}`}
            style={{ inlineSize: widthVar(col) }}
            onPointerDown={onCellDown(col)}
          >
            <span className="cgw-th-glyph" aria-hidden="true">
              {TYPE_GLYPH[def.type]}
            </span>
            <span className="cgw-th-name" dir="auto">
              {def.name}
            </span>
            {sort ? (
              <span className="cgw-th-sort" aria-hidden="true">
                {sort}
              </span>
            ) : null}
            {editable ? (
              <span
                className="cgw-col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('property.resize', { name: def.name })}
                aria-valuenow={widths[col]}
                aria-valuemin={MIN_WIDTH}
                aria-valuemax={MAX_WIDTH}
                onPointerDown={onResizeDown(col)}
              />
            ) : null}
          </div>
        );
      })}
      <div className="cgw-th cgw-th-add" aria-hidden="true">
        {editable ? (
          <button
            type="button"
            className="cgw-icon-button"
            tabIndex={-1}
            title={t('table.addColumn')}
            onClick={(event) => props.addProperty(event.currentTarget)}
          >
            ＋
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const TableHeader = memo(TableHeaderView);
