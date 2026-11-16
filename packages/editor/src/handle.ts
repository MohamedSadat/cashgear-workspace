// The block handle: one floating element beside the hovered block (or the block holding the
// caret), never one widget per block (S6: that costs about 95 ms a keystroke at 5,000 blocks).
// Dragging it moves the block, before or after another, or inside it when dropped indented; the
// move keeps every id. Clicking it opens the block menu.
//
// Built from `@cashgear/ui`'s pieces (Track U3), all outside React's renders: a press is followed
// by `cgTrackDrag` (pointer events, so touch drags too; a copy of the block's line follows the
// pointer, the page scrolls near its edges, Escape ends it without a move, the click after a drop
// is swallowed). The overlays draw `CgDragHandle` into the handle's box and `CgDropIndicator` into
// the frame (ui/BlockHandle.tsx); the line is moved through its handle, so a drag draws nothing.
import { cgTrackDrag, type CgDropIndicatorHandle } from '@cashgear/ui';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { blockInfoAt, childBlocksStart, moveBlock, type BlockInfo } from './blocks';

/** Where the overlays draw the handle's button and the drop line. */
export interface HandleParts {
  /** The floating handle's box, placed beside a block: `CgDragHandle` goes in it. */
  handle: HTMLElement;
  /** A box without a layout of its own in the frame: `CgDropIndicator` goes in it. */
  line: HTMLElement;
}

export interface HandleUi {
  /** The handle was clicked (or Ctrl+/ pressed): show the block menu for the block at `pos`. */
  openBlockMenu: ((pos: number, rect: DOMRect) => void) | null;
  /** Set by the handle while it exists; `onHandleParts` (the overlays) is told when it changes. */
  handleParts?: HandleParts | null;
  onHandleParts?: (() => void) | null;
  /** The drop line, once the overlays have drawn it. */
  dropIndicator?: CgDropIndicatorHandle | null;
}

export const handleKey = new PluginKey('cgwHandle');
/** How far right (left in RTL) of a block's text a drop must be to nest inside it. */
const NEST_OFFSET = 48;

interface DropTarget {
  pos: number;
  /** Where the line is drawn: its top in the frame's coordinates, its left in the viewport's. */
  line: { top: number; left: number; width: number };
}

function blockElementAt(view: EditorView, target: Element | null): HTMLElement | null {
  const element = target?.closest<HTMLElement>('[data-block]') ?? null;
  return element && view.dom.contains(element) ? element : null;
}

function blockPosOf(view: EditorView, element: HTMLElement): number | null {
  try {
    const pos = view.posAtDOM(element, 0) - 1;
    const node = view.state.doc.nodeAt(pos);
    return node?.type.name === 'block' ? pos : null;
  } catch {
    return null;
  }
}

const isRtl = (element: Element) => getComputedStyle(element).direction === 'rtl';

/** The box the page scrolls in, for scrolling near its edges during a drag. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight)
      return at;
  }
  return null;
}

class HandleView {
  readonly handle: HTMLElement;
  readonly line: HTMLElement;
  private hovered: number | null = null;
  private dragging: BlockInfo | null = null;
  private drop: DropTarget | null = null;
  private frame: HTMLElement;
  private stopDrag: (() => void) | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly ui: () => HandleUi,
  ) {
    this.frame = (view.dom.parentElement?.parentElement ?? view.dom.parentElement)!;
    this.handle = document.createElement('div');
    this.handle.className = 'cgw-handle';
    this.handle.setAttribute('aria-hidden', 'true');
    this.handle.hidden = true;
    this.line = document.createElement('div');
    this.line.className = 'cgw-handle-line';
    this.frame.append(this.handle, this.line);
    const shared = ui();
    shared.handleParts = { handle: this.handle, line: this.line };
    shared.onHandleParts?.();

    view.dom.addEventListener('mousemove', this.onMove);
    this.frame.addEventListener('mouseleave', this.onLeave);
    // The editor keeps the focus and its selection: no text is selected by a drag.
    this.handle.addEventListener('mousedown', this.onMouseDown);
    this.handle.addEventListener('pointerdown', this.onPointerDown);
    this.handle.addEventListener('click', this.onClick);
  }

  private frameRequest = 0;

  /** Placing reads layout, so it waits for the next frame and happens once per frame. */
  update() {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      if (!this.view.isDestroyed) this.reposition();
    });
  }

  private reposition() {
    // A drag keeps the handle where it was pressed (the pointer may leave the frame meanwhile).
    if (this.dragging) return;
    if (!this.view.editable) {
      this.handle.hidden = true;
      return;
    }
    // Follow the caret when the pointer is not over a block.
    if (this.hovered === null && this.view.hasFocus()) {
      const { $from } = this.view.state.selection;
      for (let d = $from.depth; d > 0; d--)
        if ($from.node(d).type.name === 'block') {
          this.place($from.before(d));
          return;
        }
    } else if (this.hovered !== null) {
      const node = this.view.state.doc.nodeAt(this.hovered);
      if (node?.type.name === 'block') this.place(this.hovered);
      else this.hide();
    }
  }

  private hide() {
    this.handle.hidden = true;
    this.hovered = null;
  }

  private place(pos: number) {
    const dom = this.view.nodeDOM(pos) as HTMLElement | null;
    const body = dom?.firstElementChild as HTMLElement | null;
    if (!dom || !body) return;
    const frame = this.frame.getBoundingClientRect();
    const rect = body.getBoundingClientRect();
    const rtl = isRtl(body);
    const top = rect.top - frame.top + Math.min(4, rect.height / 4);
    this.handle.style.top = `${top}px`;
    if (rtl) {
      this.handle.style.left = `${rect.right - frame.left + 4}px`;
    } else {
      this.handle.style.left = `${rect.left - frame.left - 26}px`;
    }
    this.handle.dataset.pos = String(pos);
    this.handle.hidden = false;
  }

  private readonly onMove = (event: MouseEvent) => {
    if (this.dragging) return;
    const element = blockElementAt(this.view, event.target as Element | null);
    const pos = element ? blockPosOf(this.view, element) : null;
    if (pos === null || pos === this.hovered) return;
    this.hovered = pos;
    this.place(pos);
  };

  private readonly onLeave = (event: MouseEvent) => {
    if (this.handle.contains(event.relatedTarget as Node)) return;
    this.hovered = null;
    this.update();
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onClick = () => {
    const pos = Number(this.handle.dataset.pos);
    if (Number.isNaN(pos)) return;
    this.ui().openBlockMenu?.(pos, this.handle.getBoundingClientRect());
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.view.editable) return;
    const pos = Number(this.handle.dataset.pos);
    const block = Number.isNaN(pos) ? null : blockInfoAt(this.view.state.doc, pos);
    if (!block) return;
    this.stopDrag?.();
    this.stopDrag = cgTrackDrag(event, this.handle, {
      scroller: scrollerOf(this.view.dom),
      ghost: () => this.ghost(block.pos),
      ghostClassName: 'cgw-block-ghost',
      onStart: () => {
        this.dragging = block;
        this.frame.classList.add('is-dragging-block');
      },
      onMove: (x, y) => this.showDrop(x, y),
      onDrop: (x, y) => this.dropAt(x, y),
      onCancel: () => this.endDrag(),
    });
  };

  /** What follows the pointer: a copy of the block's own line, without its children. */
  private ghost(pos: number): HTMLElement {
    const ghost = document.createElement('div');
    const dom = this.view.nodeDOM(pos) as HTMLElement | null;
    const body = (dom?.firstElementChild as HTMLElement | null) ?? dom;
    if (!body) return ghost;
    const copy = body.cloneNode(true) as HTMLElement;
    // Nothing of it loads, runs or is named again.
    for (const element of copy.querySelectorAll('iframe, object, embed, video, audio'))
      element.remove();
    for (const element of [copy, ...copy.querySelectorAll('[id]')]) element.removeAttribute('id');
    copy.removeAttribute('contenteditable');
    for (const element of copy.querySelectorAll('[contenteditable]'))
      element.removeAttribute('contenteditable');
    ghost.append(copy);
    ghost.style.inlineSize = `${body.getBoundingClientRect().width}px`;
    return ghost;
  }

  /** The place a drop at this point means: before or after a block, or inside it. */
  private target(x: number, y: number): DropTarget | null {
    const dragged = this.dragging;
    if (!dragged) return null;
    const root = this.view.root as Document | ShadowRoot;
    const under = typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : null;
    const element = blockElementAt(this.view, under);
    if (!element) return null;
    const pos = blockPosOf(this.view, element);
    if (pos === null) return null;
    const block = blockInfoAt(this.view.state.doc, pos);
    if (!block) return null;
    // Not onto itself or its own subtree.
    if (pos >= dragged.pos && pos < dragged.pos + dragged.node.nodeSize) return null;
    const body = element.firstElementChild as HTMLElement;
    const rect = body.getBoundingClientRect();
    const frame = this.frame.getBoundingClientRect();
    const rtl = isRtl(body);
    const below = y > rect.top + rect.height / 2;
    const indent = rtl ? rect.right - x : x - rect.left;
    if (below && indent > NEST_OFFSET) {
      return {
        pos: childBlocksStart(block),
        line: {
          top: rect.bottom - frame.top,
          left: rtl ? rect.left : rect.left + 26,
          width: rect.width - 26,
        },
      };
    }
    return {
      pos: below ? pos + block.node.nodeSize : pos,
      line: {
        top: (below ? element.getBoundingClientRect().bottom : rect.top) - frame.top,
        left: rect.left,
        width: rect.width,
      },
    };
  }

  private showDrop(x: number, y: number) {
    this.drop = this.target(x, y);
    const indicator = this.ui().dropIndicator;
    if (!indicator) return;
    if (!this.drop) {
      indicator.hide();
      return;
    }
    // The line is placed from the frame's inline start: its right edge in right to left.
    const { top, left, width } = this.drop.line;
    const frame = this.frame.getBoundingClientRect();
    const inline = isRtl(this.frame) ? frame.right - (left + width) : left - frame.left;
    indicator.show({ orientation: 'horizontal', block: top, inline, length: width });
  }

  private endDrag() {
    this.dragging = null;
    this.drop = null;
    this.stopDrag = null;
    this.frame.classList.remove('is-dragging-block');
    this.ui().dropIndicator?.hide();
  }

  private dropAt(x: number, y: number) {
    if (!this.dragging) return;
    const drop = this.target(x, y) ?? this.drop;
    const dragged = blockInfoAt(this.view.state.doc, this.dragging.pos);
    this.endDrag();
    if (!drop || !dragged) return;
    const tr = moveBlock(this.view.state, dragged, drop.pos);
    if (tr) this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  }

  destroy() {
    cancelAnimationFrame(this.frameRequest);
    this.stopDrag?.();
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.frame.removeEventListener('mouseleave', this.onLeave);
    this.handle.remove();
    this.line.remove();
    const ui = this.ui();
    if (ui.handleParts?.handle === this.handle) {
      ui.handleParts = null;
      ui.dropIndicator = null;
      ui.onHandleParts?.();
    }
  }
}

// Tiptap copies option objects, so the shared ui object is passed behind a function.
export const BlockHandle = Extension.create<{ ui: () => HandleUi }>({
  name: 'cgwBlockHandle',
  addOptions: () => ({ ui: () => ({ openBlockMenu: null }) }),
  addProseMirrorPlugins() {
    const { ui } = this.options;
    return [new Plugin({ key: handleKey, view: (view) => new HandleView(view, ui) })];
  },
});
