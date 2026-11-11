// The block handle: one floating element beside the hovered block (or the block holding the
// caret), never one widget per block (S6: that costs about 95 ms a keystroke at 5,000 blocks).
// Dragging it moves the block, before or after another, or inside it when dropped indented; the
// move keeps every id. Clicking it opens the block menu. A stand-in for Track U3's drag handle,
// drop indicator and drag-and-drop helper.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { blockInfoAt, childBlocksStart, moveBlock, type BlockInfo } from './blocks';
import type { EditorHost } from './host';

export interface HandleUi {
  /** The handle was clicked (or Ctrl+/ pressed): show the block menu for the block at `pos`. */
  openBlockMenu: ((pos: number, rect: DOMRect) => void) | null;
}

export const handleKey = new PluginKey('cgwHandle');
const DRAG_TYPE = 'application/x-cgw-block';
/** How far right (left in RTL) of a block's text a drop must be to nest inside it. */
const NEST_OFFSET = 48;

interface DropTarget {
  pos: number;
  /** Where the line is drawn, in the frame's coordinates. */
  line: { top: number; start: number; width: number };
}

function blockElementAt(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-block]') : null;
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

class HandleView {
  readonly handle: HTMLElement;
  readonly indicator: HTMLElement;
  private hovered: number | null = null;
  private dragging: BlockInfo | null = null;
  private drop: DropTarget | null = null;
  private frame: HTMLElement;

  constructor(
    private readonly view: EditorView,
    private readonly host: () => EditorHost,
    private readonly ui: () => HandleUi,
  ) {
    this.frame = (view.dom.parentElement?.parentElement ?? view.dom.parentElement)!;
    this.handle = document.createElement('div');
    this.handle.className = 'cgw-handle';
    this.handle.draggable = true;
    this.handle.setAttribute('role', 'button');
    this.handle.setAttribute('aria-hidden', 'true');
    this.handle.textContent = '⠿';
    this.handle.hidden = true;
    this.indicator = document.createElement('div');
    this.indicator.className = 'cgw-drop-indicator';
    this.indicator.hidden = true;
    this.frame.append(this.handle, this.indicator);

    view.dom.addEventListener('mousemove', this.onMove);
    this.frame.addEventListener('mouseleave', this.onLeave);
    this.handle.addEventListener('mousedown', (event) => event.stopPropagation());
    this.handle.addEventListener('click', this.onClick);
    this.handle.addEventListener('dragstart', this.onDragStart);
    this.handle.addEventListener('dragend', this.onDragEnd);
    view.dom.addEventListener('dragover', this.onDragOver);
    view.dom.addEventListener('drop', this.onDrop);
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
    const strings = this.host().strings;
    if (strings) this.handle.title = strings.dragHandle;
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
    const element = blockElementAt(this.view, event.target);
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

  private readonly onClick = () => {
    const pos = Number(this.handle.dataset.pos);
    if (Number.isNaN(pos)) return;
    this.ui().openBlockMenu?.(pos, this.handle.getBoundingClientRect());
  };

  private readonly onDragStart = (event: DragEvent) => {
    const pos = Number(this.handle.dataset.pos);
    const block = Number.isNaN(pos) ? null : blockInfoAt(this.view.state.doc, pos);
    if (!block || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    this.dragging = block;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, String(pos));
    event.dataTransfer.setData('text/plain', block.node.textContent);
    const dom = this.view.nodeDOM(pos) as HTMLElement | null;
    if (dom) event.dataTransfer.setDragImage(dom, 0, 0);
  };

  private readonly onDragEnd = () => {
    this.dragging = null;
    this.drop = null;
    this.indicator.hidden = true;
  };

  /** The place a drop at this point means: before or after a block, or inside it. */
  private target(event: DragEvent): DropTarget | null {
    const element = blockElementAt(this.view, event.target);
    if (!element || !this.dragging) return null;
    const pos = blockPosOf(this.view, element);
    if (pos === null) return null;
    const block = blockInfoAt(this.view.state.doc, pos);
    if (!block) return null;
    const dragged = this.dragging;
    // Not onto itself or its own subtree.
    if (pos >= dragged.pos && pos < dragged.pos + dragged.node.nodeSize) return null;
    const body = element.firstElementChild as HTMLElement;
    const rect = body.getBoundingClientRect();
    const frame = this.frame.getBoundingClientRect();
    const rtl = isRtl(body);
    const below = event.clientY > rect.top + rect.height / 2;
    const indent = rtl ? rect.right - event.clientX : event.clientX - rect.left;
    if (below && indent > NEST_OFFSET) {
      const at = childBlocksStart(block);
      return {
        pos: at,
        line: {
          top: rect.bottom - frame.top,
          start: (rtl ? rect.left : rect.left + 26) - frame.left,
          width: rect.width - 26,
        },
      };
    }
    return {
      pos: below ? pos + block.node.nodeSize : pos,
      line: {
        top: (below ? element.getBoundingClientRect().bottom : rect.top) - frame.top,
        start: rect.left - frame.left,
        width: rect.width,
      },
    };
  }

  private readonly onDragOver = (event: DragEvent) => {
    if (!this.dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.drop = this.target(event);
    if (!this.drop) {
      this.indicator.hidden = true;
      return;
    }
    const { top, start, width } = this.drop.line;
    this.indicator.style.top = `${top - 1}px`;
    this.indicator.style.left = `${start}px`;
    this.indicator.style.width = `${width}px`;
    this.indicator.hidden = false;
  };

  private readonly onDrop = (event: DragEvent) => {
    if (!this.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const drop = this.drop ?? this.target(event);
    const dragged = blockInfoAt(this.view.state.doc, this.dragging.pos);
    this.onDragEnd();
    if (!drop || !dragged) return;
    const tr = moveBlock(this.view.state, dragged, drop.pos);
    if (tr) this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  };

  destroy() {
    cancelAnimationFrame(this.frameRequest);
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.frame.removeEventListener('mouseleave', this.onLeave);
    this.view.dom.removeEventListener('dragover', this.onDragOver);
    this.view.dom.removeEventListener('drop', this.onDrop);
    this.handle.remove();
    this.indicator.remove();
  }
}

// Tiptap copies option objects, so the shared ui object is passed behind a function.
export const BlockHandle = Extension.create<{ host: () => EditorHost; ui: () => HandleUi }>({
  name: 'cgwBlockHandle',
  addOptions: () => ({ host: () => ({}), ui: () => ({ openBlockMenu: null }) }),
  addProseMirrorPlugins() {
    const { host, ui } = this.options;
    return [
      new Plugin({
        key: handleKey,
        view: (view) => new HandleView(view, host, ui),
        props: {
          // Our own drags are handled by the view; ProseMirror must not also drop them.
          handleDrop: (_view, event) =>
            !!(event as DragEvent).dataTransfer?.types.includes(DRAG_TYPE),
        },
      }),
    ];
  },
});
