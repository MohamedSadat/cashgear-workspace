// The table of contents (schema version 2): an atom body drawn as the page's headings, each a link
// that moves to its block. The headings are one list for the whole page, kept in a plugin's state
// and given to every table of contents on it; none of this is a decoration (D26: a decoration per
// block re-made on every change costs about 95 ms a keystroke at 5,000 blocks). The list is made
// again only when the block structure changes or text is typed in a heading, and only while the
// page has a table of contents at all; typing anywhere else costs a comparison.
import { Extension, type NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { textOnlyChange } from '@cgw/doc';
import type { EditorHost } from './host';

export interface Heading {
  id: string | null;
  level: number;
  text: string;
}

interface TocState {
  /** Whether the page holds a table of contents; nothing is listed while it does not. */
  present: boolean;
  headings: readonly Heading[];
}

export const tocKey = new PluginKey<TocState>('cgwTableOfContents');
const none: TocState = { present: false, headings: [] };

const levelOf = (body: PMNode) => Math.min(3, Math.max(1, Number(body.attrs.level) || 1));

/** The page's headings in document order, and whether it has a table of contents. */
export function scanHeadings(doc: PMNode): TocState {
  const headings: Heading[] = [];
  let present = false;
  const walk = (node: PMNode) => {
    node.forEach((child) => {
      if (child.type.name !== 'block') return;
      let first = true;
      child.forEach((body) => {
        if (body.type.name === 'block') return;
        if (body.type.name === 'tableOfContents') present = true;
        if (first && body.type.name === 'textBody' && body.attrs.kind === 'heading')
          headings.push({
            id: (child.attrs.id as string | null) ?? null,
            level: levelOf(body),
            text: body.textContent,
          });
        first = false;
      });
      walk(child);
    });
  };
  walk(doc);
  return { present, headings };
}

const sameHeadings = (a: readonly Heading[], b: readonly Heading[]) =>
  a.length === b.length &&
  a.every((h, i) => h.id === b[i].id && h.level === b[i].level && h.text === b[i].text);

/** Whether a slice brings a table of contents in. */
function bringsToc(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (node.type.name === 'tableOfContents') found = true;
    return !found && (node.type.name === 'block' || node.type.name === 'doc');
  });
  return found;
}

/** Whether a text-only transaction typed or formatted inside a heading. */
function touchesHeading(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    if (!(
      step instanceof ReplaceStep ||
      step instanceof AddMarkStep ||
      step instanceof RemoveMarkStep
    ))
      return true;
    const { from } = step as unknown as { from: number };
    const parent = tr.docs[i].resolve(from).parent;
    return parent.type.name === 'textBody' && parent.attrs.kind === 'heading';
  });
}

function nextState(tr: Transaction, value: TocState): TocState {
  if (!tr.docChanged) return value;
  if (textOnlyChange(tr)) {
    if (!value.present || !touchesHeading(tr)) return value;
  } else if (!value.present) {
    // A structural change on a page without one: look only at what it inserts.
    const inserts = tr.steps.some(
      (step) =>
        step instanceof ReplaceStep && bringsToc((step as unknown as { slice: Slice }).slice),
    );
    if (!inserts) return value;
  }
  const next = scanHeadings(tr.doc);
  if (!next.present) return none;
  return value.present && sameHeadings(value.headings, next.headings) ? value : next;
}

/** The tables of contents drawn in each editor view, told when the headings change. */
const listeners = new WeakMap<EditorView, Set<() => void>>();

function subscribe(view: EditorView, listener: () => void): () => void {
  let set = listeners.get(view);
  if (!set) listeners.set(view, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/** The position of the block with this id, or null. */
export function blockPosition(doc: PMNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== 'block') return false;
    if (node.attrs.id === id) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** Moves to a block: the caret at the start of its text, the block scrolled into view. */
export function goToBlock(view: EditorView, id: string): boolean {
  const pos = blockPosition(view.state.doc, id);
  if (pos === null) return false;
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)));
  view.dispatch(tr.scrollIntoView());
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  dom?.scrollIntoView?.({ block: 'start' });
  if (view.editable) view.focus();
  return true;
}

export const TableOfContents = Extension.create({
  name: 'cgwTableOfContents',
  addProseMirrorPlugins() {
    return [
      new Plugin<TocState>({
        key: tocKey,
        state: {
          init: (_, state) => {
            const scanned = scanHeadings(state.doc);
            return scanned.present ? scanned : none;
          },
          apply: (tr, value) => nextState(tr, value),
        },
        view: () => ({
          update(view, previous) {
            if (tocKey.getState(view.state) === tocKey.getState(previous)) return;
            for (const listener of listeners.get(view) ?? []) listener();
          },
        }),
      }),
    ];
  },
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The table of contents, in plain DOM: a list of links, one per heading. */
export function tableOfContentsView(host: () => EditorHost): NodeViewRenderer {
  return ({ editor }) => {
    const view = editor.view;
    const dom = el('nav', 'cgw-body cgw-tableOfContents');
    dom.dataset.body = 'tableOfContents';
    dom.contentEditable = 'false';
    const list = el('ol', 'cgw-toc-list');
    const empty = el('p', 'cgw-toc-empty');
    dom.append(list, empty);
    let drawn: readonly Heading[] | null = null;
    const draw = () => {
      const state = tocKey.getState(editor.state) ?? none;
      const strings = host().strings;
      dom.setAttribute('aria-label', strings?.tocLabel ?? '');
      empty.textContent = strings?.tocEmpty ?? '';
      if (state.headings === drawn) return;
      drawn = state.headings;
      list.replaceChildren(
        ...state.headings.map((heading) => {
          const item = el('li', 'cgw-toc-item');
          item.dataset.level = String(heading.level);
          const link = el('a', 'cgw-toc-link', heading.text || (strings?.untitled ?? ''));
          link.href = '#';
          link.dir = 'auto';
          if (heading.id) link.dataset.blockId = heading.id;
          item.append(link);
          return item;
        }),
      );
      empty.hidden = state.headings.length > 0;
      list.hidden = state.headings.length === 0;
    };
    dom.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest?.('a.cgw-toc-link');
      if (!link || !dom.contains(link)) return;
      event.preventDefault();
      const id = (link as HTMLElement).dataset.blockId;
      if (id) goToBlock(view, id);
    });
    const unsubscribe = subscribe(view, draw);
    draw();
    return {
      dom,
      update(next) {
        if (next.type.name !== 'tableOfContents') return false;
        draw();
        return true;
      },
      // Links take their own clicks and keys; the node is drawn, never edited.
      stopEvent: (event) => !!(event.target as HTMLElement | null)?.closest?.('a.cgw-toc-link'),
      ignoreMutation: () => true,
      destroy: unsubscribe,
    };
  };
}
