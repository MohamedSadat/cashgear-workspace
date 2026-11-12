// The database view block (schema version 3), in plain DOM: a frame the host draws the database
// into (`host.databases.mount`, the shell's `@cgw/database`), mounted lazily when the block comes
// near the viewport and unmounted when it goes far away (D26: lazy mounting of database views),
// and never made again per transaction: the frame is mounted again only when the block's
// database, view, block id or editability changes. Without a host to draw it, or without a
// database, the block draws a placeholder. Removing the block only unmounts the frame; the
// database is a page of its own and stays (contracts, section 5).
import type { Editor, NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { textOnlyChange } from '@cgw/doc';
import type { DatabaseMountOptions, DatabaseRef, EditorHost, OnHostChange } from '../host';

type Pos = (() => number | undefined) | boolean;

/** Mounted when the block is this near the scrolled area, unmounted beyond the second margin. */
export const NEAR_MARGIN = '800px 0px';
export const FAR_MARGIN = '2400px 0px';

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
 * The top-level block holding the view: what is watched, because top-level blocks have
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
 * not mount and unmount over and over). Without IntersectionObserver, always near.
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

function setAttrs(editor: Editor, getPos: Pos, node: PMNode, attrs: Record<string, unknown>) {
  if (typeof getPos !== 'function' || !editor.isEditable) return;
  const pos = getPos();
  if (pos === undefined || editor.state.doc.nodeAt(pos)?.type !== node.type) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
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

export function databaseViewView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = el('div', 'cgw-body cgw-databaseView');
    dom.dataset.body = 'databaseView';
    dom.contentEditable = 'false';
    dom.setAttribute('role', 'group');
    const frame = el('div', 'cgw-database-frame');
    const placeholder = el('div', 'cgw-database-placeholder');
    dom.append(frame, placeholder);

    let unmount: (() => void) | null = null;
    /** What is mounted: the database, view, block and editability it was mounted for. */
    let mountedKey = '';
    let mountedBlockId: string | null = null;
    let near = false;
    let destroyed = false;
    let stopWatching: (() => void) | null = null;
    let editable = editor.isEditable;
    let clearHeight = 0;
    const owns = (target: EventTarget | null) =>
      target instanceof Node &&
      (frame.contains(target) || (target instanceof HTMLElement && target.tagName === 'BUTTON'));

    const release = () => {
      if (!unmount) return;
      const done = unmount;
      unmount = null;
      mountedKey = '';
      try {
        done();
      } catch (error) {
        console.error('A database view did not unmount cleanly:', error);
      }
    };

    const showPlaceholder = (text: string, choose: boolean) => {
      frame.hidden = true;
      placeholder.hidden = false;
      placeholder.replaceChildren(el('span', 'cgw-database-placeholder-text', text));
      const pick = host().databases?.pick;
      if (choose && pick && editor.isEditable) {
        const button = el('button', 'cgw-database-choose', host().strings?.databaseChoose ?? '');
        button.type = 'button';
        button.addEventListener('click', () => {
          void pick().then((picked: DatabaseRef | null) => {
            if (picked && !destroyed)
              setAttrs(editor, getPos, node, {
                databaseId: picked.databaseId,
                viewId: picked.viewId ?? null,
              });
          });
        });
        placeholder.append(button);
      }
    };

    const draw = () => {
      if (destroyed) return;
      editable = editor.isEditable;
      const strings = host().strings;
      dom.setAttribute('aria-label', strings?.databaseView ?? '');
      const databaseId = node.attrs.databaseId as string | null;
      const mount = host().databases?.mount;
      if (!databaseId || !mount) {
        release();
        showPlaceholder(
          (databaseId ? strings?.databaseUnavailable : strings?.databaseNotChosen) ?? '',
          !databaseId,
        );
        return;
      }
      placeholder.hidden = true;
      frame.hidden = false;
      if (!near) return;
      const options: DatabaseMountOptions = {
        databaseId,
        viewId: (node.attrs.viewId as string | null) ?? null,
        blockId: blockIdAt(editor, getPos),
        editable,
        setViewId: (viewId) => setAttrs(editor, getPos, node, { viewId }),
      };
      const key = JSON.stringify([options.databaseId, options.viewId, options.blockId, editable]);
      if (key === mountedKey) return;
      release();
      try {
        unmount = mount(frame, options);
        mountedKey = key;
        mountedBlockId = options.blockId;
      } catch (error) {
        console.error('A database view could not be drawn:', error);
        unmount = null;
        showPlaceholder(strings?.databaseUnavailable ?? '', false);
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
      else if (unmount) {
        // Far away: unmounted, keeping its height so the page does not jump.
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
        unmount &&
        !textOnlyChange(transaction) &&
        blockIdAt(editor, getPos) !== mountedBlockId
      )
        draw();
    };
    editor.on('update', onUpdate);
    // Another host: its strings, or a way to draw databases it did not have before. A host that
    // only changed (the language, say) does not mount the frame again: the key is the same.
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
      // nor do the placeholder's button's. Elsewhere on the block, a click selects it as an atom.
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
