// A pointer drag of a card (board, calendar and gallery cards), done outside React so a drag
// paints only what moves: a copy of the card follows the pointer (a transform, once per animation
// frame) and the view moves its one drop indicator; no card is drawn again while it lasts. The
// card itself is only marked (`data-dragging`). Near the scrolling box's edges it scrolls, and the
// view is told the pointer moved. Escape or a cancelled pointer ends it without a drop.
//
// Pointer events, not HTML5 drag and drop: the same code serves touch, and test drivers move the
// mouse step by step (Playwright's `dragTo` does not drive HTML5 drags).

/** Pixels the pointer must travel before a press becomes a drag (a click stays a click). */
export const DRAG_THRESHOLD = 4;
/** Distance from the scrolling box's edge where a drag scrolls it, and the fastest step. */
const EDGE = 48;
const MAX_STEP = 18;

export interface DragHandlers {
  /** The press became a drag. */
  onStart(): void;
  /** The pointer is at (x, y) in the viewport: called at most once per frame, and after a scroll. */
  onMove(x: number, y: number): void;
  onDrop(x: number, y: number): void;
  onCancel(): void;
}

/** What is under the pointer can start a drag: not a control inside the card. */
export function startsDrag(target: EventTarget | null, card: HTMLElement): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  const control = el.closest(
    'button, a, input, textarea, select, label, [role="checkbox"], [contenteditable="true"], [data-no-drag]',
  );
  return !control || !card.contains(control) || control === card;
}

/** Edge scrolling: how far to scroll for a pointer at `p` in a box from `start` to `end`. */
export function edgeStep(p: number, start: number, end: number): number {
  if (p < start + EDGE) return -Math.ceil(MAX_STEP * Math.min(1, (start + EDGE - p) / EDGE));
  if (p > end - EDGE) return Math.ceil(MAX_STEP * Math.min(1, (p - (end - EDGE)) / EDGE));
  return 0;
}

/**
 * Watches a press on `card` and, once it travels, drags a copy of it. Returns a function that
 * stops it at once (the view went away).
 */
export function trackDrag(
  press: PointerEvent,
  card: HTMLElement,
  scroller: HTMLElement | null,
  handlers: DragHandlers,
): () => void {
  const startX = press.clientX;
  const startY = press.clientY;
  const rect = card.getBoundingClientRect();
  const grabX = startX - rect.left;
  const grabY = startY - rect.top;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let x = startX;
  let y = startY;
  let frame = 0;
  let done = false;

  const place = () => {
    if (ghost) ghost.style.transform = `translate3d(${x - grabX}px, ${y - grabY}px, 0)`;
  };

  const tick = () => {
    frame = 0;
    if (done || !dragging) return;
    place();
    let scrolled = false;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const dx = edgeStep(x, box.left, box.right);
      const dy = edgeStep(y, box.top, box.bottom);
      if (dx || dy) {
        const left = scroller.scrollLeft;
        const top = scroller.scrollTop;
        scroller.scrollBy(dx, dy);
        scrolled = scroller.scrollLeft !== left || scroller.scrollTop !== top;
      }
    }
    handlers.onMove(x, y);
    if (scrolled) frame = requestAnimationFrame(tick);
  };

  const begin = () => {
    dragging = true;
    ghost = card.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id');
    ghost.classList.add('cgw-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.dir = getComputedStyle(card).direction;
    // The card's place in its column does not apply to the copy: it is placed by its transform.
    ghost.style.removeProperty('inset-block-start');
    ghost.style.removeProperty('inset-inline-start');
    ghost.style.inlineSize = `${rect.width}px`;
    ghost.style.blockSize = `${rect.height}px`;
    place();
    document.body.append(ghost);
    card.setAttribute('data-dragging', '');
    handlers.onStart();
  };

  const finish = () => {
    done = true;
    if (frame) cancelAnimationFrame(frame);
    ghost?.remove();
    card.removeAttribute('data-dragging');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    x = event.clientX;
    y = event.clientY;
    if (!dragging) {
      if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
      begin();
    }
    event.preventDefault();
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    const was = dragging;
    finish();
    if (was) {
      // The click that follows a drag must not open the card.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      handlers.onDrop(event.clientX, event.clientY);
    }
  };
  const onCancel = () => {
    const was = dragging;
    finish();
    if (was) handlers.onCancel();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !dragging) return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  return () => {
    if (!done) onCancel();
  };
}
