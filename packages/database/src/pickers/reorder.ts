// Reordering a short list (options, sorts, the view's properties) by dragging a handle or with
// the keyboard on it (ArrowUp, ArrowDown). One move is one write, made when the drag ends.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface ReorderState {
  /** The item being dragged. */
  dragging: string | null;
  /** Where it would land (an index in the list without it). */
  over: number | null;
}

/** Where an item lands: `to` counted in the list with the item still in it. */
export function moveIndex(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const out = ids.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}

export function useReorder(ids: readonly string[], onMove: (id: string, toIndex: number) => void) {
  const [state, setState] = useState<ReorderState>({ dragging: null, over: null });
  const drag = useRef<{ id: string; pointerId: number; startY: number; moved: boolean } | null>(
    null,
  );

  const overIndex = (event: PointerEvent<HTMLElement>, id: string): number | null => {
    const target = document
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-reorder-id]');
    const key = target?.dataset.reorderId;
    if (!key || !target) return null;
    const index = ids.indexOf(key);
    if (index < 0) return null;
    const rect = target.getBoundingClientRect();
    const below = event.clientY > rect.top + rect.height / 2;
    const from = ids.indexOf(id);
    let to = below ? index + 1 : index;
    if (from >= 0 && to > from) to -= 1;
    return to;
  };

  const handleProps = (id: string) => ({
    'data-reorder-handle': id,
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { id, pointerId: event.pointerId, startY: event.clientY, moved: false };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.abs(event.clientY - current.startY) < 4) return;
      current.moved = true;
      const over = overIndex(event, current.id);
      setState((s) =>
        s.dragging === current.id && s.over === over ? s : { dragging: current.id, over },
      );
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = drag.current;
      drag.current = null;
      if (!current || current.pointerId !== event.pointerId) return;
      const over = current.moved ? overIndex(event, current.id) : null;
      setState({ dragging: null, over: null });
      if (over !== null && over !== ids.indexOf(current.id)) onMove(current.id, over);
    },
    onPointerCancel() {
      drag.current = null;
      setState({ dragging: null, over: null });
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      const from = ids.indexOf(id);
      const to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (from >= 0 && to >= 0 && to < ids.length) onMove(id, to);
    },
  });

  return { state, handleProps };
}
