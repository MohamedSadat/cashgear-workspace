// The rows with no date, beside a calendar or a timeline: a scrolling list drawn a window at a
// time, loading its next page as its end comes into view. A row is opened from it, dragged from it
// onto a day (the view follows the pointer: `onPointerDown`), or placed on a day by its button.
import type { RowRecord } from '@cgw/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { CellEnv } from '../../cells/env';
import { layoutOf, sameRange, visibleRange, type Range } from '../../table/windowing';
import './calendar.css';

const ITEM = 34;

export interface UndatedProps {
  id: string;
  /** Its heading and accessible name. */
  title: string;
  /** What it says when every row has a date. */
  empty: string;
  rows: RowRecord[];
  /** Rows with no date in all (the list may hold fewer so far). */
  total: number;
  env: CellEnv;
  writable: boolean;
  /** The place button's name ("Place on 14 November"). */
  placeLabel: string;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onOpen(row: RowRecord): void;
  onPlace(row: RowRecord): void;
  /** Its last rows are in view and there are more: fetch the next page. */
  onNearEnd?(): void;
}

export function Undated({
  id,
  title,
  empty,
  rows,
  total,
  env,
  writable,
  placeLabel,
  onPointerDown,
  onOpen,
  onPlace,
  onNearEnd,
}: UndatedProps) {
  const { t } = env;
  const box = useRef<HTMLUListElement>(null);
  const layout = useMemo(() => layoutOf(rows.length, () => ITEM), [rows.length]);
  const [range, setRange] = useState<Range>({ start: 0, end: 30 });
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const next = visibleRange(layout, el.scrollTop, el.clientHeight || 480, 8);
    setRange((prev) => (sameRange(prev, next) ? prev : next));
  }, [layout]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    if (onNearEnd && rows.length < total && range.end >= rows.length - 4) onNearEnd();
  }, [onNearEnd, rows.length, total, range.end]);
  const drawn = rows.slice(range.start, range.end);
  const rowOf = (target: EventTarget) => {
    const rowId = (target as HTMLElement).closest<HTMLElement>('[data-cal-item]')?.dataset.rowId;
    return rows.find((r) => r.id === rowId);
  };
  const onClick = (event: MouseEvent<HTMLElement>) => {
    const row = rowOf(event.target);
    if (row) onOpen(row);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = rowOf(event.target);
    if (!row) return;
    event.preventDefault();
    onOpen(row);
  };
  return (
    <aside id={id} className="cgw-cal-undated" aria-label={title}>
      <h4 className="cgw-cal-undated-title">{title}</h4>
      {rows.length ? (
        <ul
          ref={box}
          className="cgw-cal-undated-list"
          onScroll={measure}
          onPointerDown={onPointerDown}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <li
            aria-hidden="true"
            style={{ blockSize: layout.total }}
            className="cgw-cal-undated-space"
          />
          {drawn.map((row, i) => (
            <li
              key={row.id}
              className="cgw-cal-undated-item"
              data-cal-drag={writable ? '' : undefined}
              data-row-id={row.id}
              style={{ insetBlockStart: layout.offsets[range.start + i] }}
            >
              <span
                role="button"
                tabIndex={0}
                className="cgw-cal-undated-open"
                data-cal-item=""
                data-row-id={row.id}
                dir="auto"
              >
                {row.title || t('untitled')}
              </span>
              {writable ? (
                <button
                  type="button"
                  className="cgw-icon-button"
                  aria-label={placeLabel}
                  title={placeLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlace(row);
                  }}
                >
                  <span aria-hidden="true">↧</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cgw-cal-undated-empty">{empty}</p>
      )}
    </aside>
  );
}
