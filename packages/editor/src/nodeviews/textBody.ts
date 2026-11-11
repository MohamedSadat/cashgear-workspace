// The text body as a plain DOM node view (D26): no React in the typing path. Bullets and numbers
// are drawn by CSS; the checkbox, the toggle's arrow and the callout's icon are small elements
// outside the editable text.
import type { NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorHost } from '../host';

const tagFor = (node: PMNode) =>
  node.attrs.kind === 'heading'
    ? `h${Math.min(3, Math.max(1, Number(node.attrs.level) || 1))}`
    : 'div';

/**
 * Sets only this view's own attributes (decorations add theirs too), and only those that change:
 * a keystroke must not rewrite the element, or the browser's caret and ProseMirror's DOM observer
 * see changes that are not there.
 */
function applyAttrs(dom: HTMLElement, node: PMNode) {
  const { kind, level, checked, colour, dir, tone } = node.attrs;
  for (const name of [...dom.classList])
    if (name.startsWith('cgw-') && name !== 'cgw-body' && name !== `cgw-${kind}`)
      dom.classList.remove(name);
  if (!dom.classList.contains('cgw-body')) dom.classList.add('cgw-body');
  if (!dom.classList.contains(`cgw-${kind}`)) dom.classList.add(`cgw-${kind}`);
  const set = (name: string, value: string | null) => {
    if (value === null) {
      if (dom.hasAttribute(name)) dom.removeAttribute(name);
    } else if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
  };
  set('data-body', 'textBody');
  set('data-kind', String(kind));
  set('dir', dir === 'ltr' || dir === 'rtl' ? dir : 'auto');
  set('data-level', kind === 'heading' ? String(level ?? 1) : null);
  set('data-checked', kind === 'checkItem' ? String(Boolean(checked)) : null);
  set('data-colour', typeof colour === 'string' ? colour : null);
  set('data-tone', kind === 'callout' ? String(tone ?? 'info') : null);
}

export function textBodyView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = document.createElement(tagFor(node));
    const contentDOM = document.createElement('div');
    contentDOM.className = 'cgw-text';
    let marker: HTMLElement | null = null;
    let unsubscribe: (() => void) | null = null;

    const blockId = (): string | null => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (pos === undefined) return null;
      const $pos = editor.state.doc.resolve(pos);
      return $pos.depth > 0 ? ($pos.node($pos.depth).attrs.id as string | null) : null;
    };

    const syncToggle = () => {
      if (node.attrs.kind !== 'toggle' || !marker) return;
      const id = blockId();
      const open = id ? (host().toggles?.isOpen(id) ?? true) : true;
      dom.dataset.open = String(open);
      marker.setAttribute('aria-expanded', String(open));
      const strings = host().strings;
      if (strings)
        marker.setAttribute('aria-label', open ? strings.toggleClose : strings.toggleOpen);
    };

    const build = () => {
      marker?.remove();
      marker = null;
      unsubscribe?.();
      unsubscribe = null;
      delete dom.dataset.open;
      const strings = host().strings;
      const kind = node.attrs.kind;
      if (kind === 'checkItem') {
        marker = document.createElement('span');
        marker.className = 'cgw-check';
        marker.setAttribute('role', 'checkbox');
        marker.setAttribute('aria-checked', String(Boolean(node.attrs.checked)));
        if (strings) marker.setAttribute('aria-label', strings.checkItem);
        marker.addEventListener('mousedown', (event) => {
          event.preventDefault();
          if (!editor.isEditable || typeof getPos !== 'function') return;
          const pos = getPos();
          if (pos === undefined) return;
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              checked: !node.attrs.checked,
            }),
          );
        });
      } else if (kind === 'toggle') {
        marker = document.createElement('button');
        marker.className = 'cgw-toggle-arrow';
        marker.setAttribute('type', 'button');
        marker.tabIndex = -1;
        marker.addEventListener('mousedown', (event) => event.preventDefault());
        marker.addEventListener('click', () => {
          const id = blockId();
          if (id) host().toggles?.flip(id);
        });
        unsubscribe = host().toggles?.subscribe(syncToggle) ?? null;
      } else if (kind === 'callout') {
        marker = document.createElement('span');
        marker.className = 'cgw-callout-icon';
        marker.textContent =
          typeof node.attrs.icon === 'string' && node.attrs.icon ? node.attrs.icon : '💡';
      }
      if (marker) {
        marker.contentEditable = 'false';
        dom.prepend(marker);
      }
      syncToggle();
    };

    applyAttrs(dom, node);
    dom.append(contentDOM);
    build();
    // The block id is known once the view is in the document.
    queueMicrotask(syncToggle);

    return {
      dom,
      contentDOM,
      update(next) {
        if (next.type !== node.type || tagFor(next) !== tagFor(node)) return false;
        const rebuild = next.attrs.kind !== node.attrs.kind || next.attrs.icon !== node.attrs.icon;
        node = next;
        applyAttrs(dom, node);
        if (rebuild) build();
        else if (marker && node.attrs.kind === 'checkItem')
          marker.setAttribute('aria-checked', String(Boolean(node.attrs.checked)));
        else syncToggle();
        return true;
      },
      // The view's own attributes (open state, markers) are not content: ProseMirror must not
      // re-read them, or setting one would re-render the node and set it again, for ever.
      ignoreMutation: (mutation) =>
        mutation.type !== 'selection' &&
        ((mutation.type === 'attributes' && mutation.target === dom) ||
          (!!marker && (mutation.target === marker || marker.contains(mutation.target as Node)))),
      stopEvent: (event) => !!marker && marker.contains(event.target as Node),
      destroy: () => unsubscribe?.(),
    };
  };
}
