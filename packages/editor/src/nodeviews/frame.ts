// A block that is a frame the host draws into (schema version 3's database view, version 4's
// workbook and ERP views), in plain DOM. The frame is mounted lazily when the block comes near the
// scrolling pane and destroyed when it goes far away, keeping its last height so the page does not
// jump (D26: lazy mounting); it is never made again per transaction: only a change of what the
// block's `key` holds (its database, workbook or link, its block id, the editability) mounts it
// again, and any other change of its attributes goes to the frame's `update`. Without a host to
// draw it, the block draws a placeholder with the actions it can offer. Removing the block only
// destroys the frame: what it shows is a record of its own and stays.
import type { Editor, NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { textOnlyChange } from '@cgw/doc';
import type { EditorHost, EditorStrings, MountedFrame, OnHostChange } from '../host';

type Pos = (() => number | undefined) | boolean;

/** Mounted when the block is this near the scrolled area, destroyed beyond the second margin. */
export const NEAR_MARGIN = '800px 0px';
export const FAR_MARGIN = '2400px 0px';

/** What a frame block knows when it decides what to draw. */
export interface FrameContext {
  node: PMNode;
  host: EditorHost;
  strings: EditorStrings | undefined;
  /** The id of the block holding the body. */
  blockId: string | null;
  /** Whether the page is editable here. */
  editable: boolean;
  /** Changes the body's attributes as an ordinary edit; nothing when not editable or gone. */
  setAttrs(attrs: Record<string, unknown>): void;
}

/** A button the placeholder offers (choose a database, make a workbook). */
export interface PlaceholderAction {
  label: string;
  run(): void;
}

/** What the block draws: the host's frame, or a placeholder. */
export type FrameDrawing<Options> =
  | {
      kind: 'frame';
      /** What needs a new frame when it changes; any other change of `options` goes to `update`. */
      key: string;
      options: Options;
      mount(element: HTMLElement, options: Options): MountedFrame<Options>;
    }
  | { kind: 'placeholder'; text: string; actions?: PlaceholderAction[] };

export interface FrameBlockSpec<Options> {
  /** The body's node name, written as `data-body`. */
  body: string;
  /** Class names: the block, the frame, the placeholder, its text and its buttons. */
  classes: { root: string; frame: string; placeholder: string; text: string; action: string };
  /** The block's accessible name. */
  label(strings: EditorStrings | undefined): string;
  /** What the placeholder says when the host's frame throws while mounting. */
  failed(strings: EditorStrings | undefined): string;
  /** For the console only: what kind of frame failed. */
  what: string;
  draw(context: FrameContext): FrameDrawing<Options>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The element that scrolls the page: the nearest ancestor that scrolls, else the viewport. */
function scrollRoot(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
  }
  return null;
}

/**
 * The top-level block holding the body: what is watched, because top-level blocks have
 * `content-visibility: auto` and what is inside a skipped one is not laid out.
 */
function topBlock(dom: HTMLElement, view: EditorView): HTMLElement | null {
  let node: HTMLElement | null = dom;
  while (node && node.parentElement !== view.dom) node = node.parentElement;
  return node;
}

/**
 * Tells whether an element is near the scrolled area: true when it comes within `NEAR_MARGIN`,
 * false when it leaves `FAR_MARGIN` (between the two, nothing changes, so scrolling past does
 * not mount and destroy over and over). Without IntersectionObserver, always near.
 */
function watchNearness(
  target: HTMLElement,
  root: HTMLElement | null,
  onChange: (near: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  const near = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onChange(true);
    },
    { root, rootMargin: NEAR_MARGIN },
  );
  const far = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last && !last.isIntersecting) onChange(false);
    },
    { root, rootMargin: FAR_MARGIN },
  );
  near.observe(target);
  far.observe(target);
  return () => {
    near.disconnect();
    far.disconnect();
  };
}

/** The id of the block holding the body at `pos`. */
function blockIdAt(editor: Editor, getPos: Pos): string | null {
  if (typeof getPos !== 'function') return null;
  const pos = getPos();
  if (pos === undefined) return null;
  try {
    const parent = editor.state.doc.resolve(pos).parent;
    return parent.type.name === 'block' ? ((parent.attrs.id as string | null) ?? null) : null;
  } catch {
    return null;
  }
}

/** Options as compared for `update`: their data, without the callbacks. */
const dataOf = (options: unknown) => JSON.stringify(options) ?? '';

export function frameBlockView<Options>(
  spec: FrameBlockSpec<Options>,
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = el('div', `cgw-body ${spec.classes.root}`);
    dom.dataset.body = spec.body;
    dom.contentEditable = 'false';
    dom.setAttribute('role', 'group');
    const frame = el('div', spec.classes.frame);
    const placeholder = el('div', spec.classes.placeholder);
    dom.append(frame, placeholder);

    let mounted: MountedFrame<Options> | null = null;
    /** What is mounted: the key it was mounted for, and the options it was last given. */
    let mountedKey = '';
    let mountedData = '';
    let mountedBlockId: string | null = null;
    let near = false;
    let destroyed = false;
    let stopWatching: (() => void) | null = null;
    let editable = editor.isEditable;
    let clearHeight = 0;
    const owns = (target: EventTarget | null) =>
      target instanceof Node &&
      (frame.contains(target) || (target instanceof HTMLElement && target.tagName === 'BUTTON'));

    const setAttrs = (attrs: Record<string, unknown>) => {
      if (destroyed || typeof getPos !== 'function' || !editor.isEditable) return;
      const pos = getPos();
      if (pos === undefined || editor.state.doc.nodeAt(pos)?.type !== node.type) return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }),
      );
    };

    const release = () => {
      if (!mounted) return;
      const done = mounted;
      mounted = null;
      mountedKey = '';
      mountedData = '';
      try {
        done.destroy();
      } catch (error) {
        console.error(`A ${spec.what} did not unmount cleanly:`, error);
      }
    };

    const showPlaceholder = (text: string, actions: PlaceholderAction[] = []) => {
      frame.hidden = true;
      placeholder.hidden = false;
      placeholder.replaceChildren(el('span', spec.classes.text, text));
      for (const action of actions) {
        const button = el('button', spec.classes.action, action.label);
        button.type = 'button';
        button.addEventListener('click', () => action.run());
        placeholder.append(button);
      }
    };

    const draw = () => {
      if (destroyed) return;
      editable = editor.isEditable;
      const current = host();
      const strings = current.strings;
      dom.setAttribute('aria-label', spec.label(strings));
      const drawing = spec.draw({
        node,
        host: current,
        strings,
        blockId: blockIdAt(editor, getPos),
        editable,
        setAttrs,
      });
      if (drawing.kind === 'placeholder') {
        release();
        showPlaceholder(drawing.text, drawing.actions);
        return;
      }
      placeholder.hidden = true;
      frame.hidden = false;
      if (!near) return;
      const data = dataOf(drawing.options);
      if (mounted && drawing.key === mountedKey) {
        if (data === mountedData) return;
        mountedData = data;
        try {
          mounted.update(drawing.options);
        } catch (error) {
          console.error(`A ${spec.what} could not be updated:`, error);
        }
        return;
      }
      release();
      try {
        mounted = drawing.mount(frame, drawing.options);
        mountedKey = drawing.key;
        mountedData = data;
        mountedBlockId = blockIdAt(editor, getPos);
      } catch (error) {
        console.error(`A ${spec.what} could not be drawn:`, error);
        mounted = null;
        showPlaceholder(spec.failed(strings));
        return;
      }
      // The height kept while it was away holds the page still until it has drawn again.
      cancelAnimationFrame(clearHeight);
      clearHeight = requestAnimationFrame(() => {
        clearHeight = requestAnimationFrame(() => {
          frame.style.minBlockSize = '';
        });
      });
    };

    const setNear = (next: boolean) => {
      if (destroyed || next === near) return;
      near = next;
      if (near) draw();
      else if (mounted) {
        // Far away: destroyed, keeping its height so the page does not jump.
        const height = frame.getBoundingClientRect().height;
        if (height > 0) frame.style.minBlockSize = `${Math.round(height)}px`;
        release();
      }
    };

    // Watched once the block is in the page (the view is made before ProseMirror places it).
    const start = () => {
      if (destroyed || stopWatching) return;
      const view = editor.view;
      const target = (dom.isConnected && topBlock(dom, view)) || dom;
      stopWatching = watchNearness(target, scrollRoot(view.dom), setNear);
    };
    queueMicrotask(start);

    // Editability changes without a change to the node; an editor emits `update` for it. So does
    // the block's id (the id repair): ProseMirror keeps this view when only the block around it
    // changes. Typing (a text-only change) is passed over at the cost of one comparison.
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (editor.isEditable !== editable) draw();
      else if (
        mounted &&
        !textOnlyChange(transaction) &&
        blockIdAt(editor, getPos) !== mountedBlockId
      )
        draw();
    };
    editor.on('update', onUpdate);
    // Another host: its strings, or a way to draw it did not have before. A host that only
    // changed (the language, say) does not mount the frame again: the key is the same.
    const unsubscribe = onHostChange(draw);
    draw();

    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      // The frame is the host's: its keys, clicks, drags and clipboard never reach ProseMirror;
      // nor do the placeholder's buttons'. Elsewhere on the block, a click selects it as an atom.
      stopEvent: (event) => owns(event.target),
      ignoreMutation: () => true,
      destroy() {
        destroyed = true;
        cancelAnimationFrame(clearHeight);
        editor.off('update', onUpdate);
        unsubscribe();
        stopWatching?.();
        release();
      },
    };
  };
}
