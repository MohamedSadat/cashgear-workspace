// Two things drawn that the document does not store: numbered-list numbers (computed when drawn,
// DATA_MODEL.md) and the placeholder in the empty block holding the caret. Neither draws one
// decoration per block: numbers go only on numbered items and are rebuilt only when the block
// structure changes; the placeholder is one decoration (S6: a decoration per block re-made on
// every change costs about 95 ms a keystroke at 5,000 blocks).
import { Extension } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorHost } from './host';

const numberKey = new PluginKey<DecorationSet>('cgwNumbers');

function numberDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  const walk = (node: PMNode, start: number) => {
    let count = 0;
    node.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type.name !== 'block') return;
      const body = child.firstChild;
      if (body?.type.name === 'textBody' && body.attrs.kind === 'numberedItem') {
        count = count === 0 && Number(body.attrs.start) > 0 ? Number(body.attrs.start) : count + 1;
        decorations.push(
          Decoration.node(pos + 1, pos + 1 + body.nodeSize, { 'data-number': `${count}.` }),
        );
      } else count = 0;
      walk(child, pos + 1);
    });
  };
  walk(doc, 0);
  return DecorationSet.create(doc, decorations);
}

/** Whether a transaction only typed or deleted text inside one text body. */
function textOnly(tr: Transaction): boolean {
  let doc = tr.before;
  for (const step of tr.steps) {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      doc = step.apply(doc).doc ?? doc;
      continue;
    }
    // Attribute steps can change a kind; around-steps wrap and unwrap blocks.
    if (!(step instanceof ReplaceStep)) return false;
    const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
    let structural = false;
    slice.content.forEach((node) => {
      if (!node.isInline) structural = true;
    });
    if (structural) return false;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    if ($from.parent !== $to.parent || !$from.parent.isTextblock) return false;
    doc = step.apply(doc).doc ?? doc;
  }
  return true;
}

const numbers = new Plugin<DecorationSet>({
  key: numberKey,
  state: {
    init: (_, state) => numberDecorations(state.doc),
    apply: (tr, set) => {
      if (!tr.docChanged) return set;
      if (textOnly(tr)) return set.map(tr.mapping, tr.doc);
      return numberDecorations(tr.doc);
    },
  },
  props: { decorations: (state) => numberKey.getState(state) },
});

function placeholder(host: () => EditorHost) {
  return new Plugin({
    key: new PluginKey('cgwPlaceholder'),
    props: {
      decorations(state) {
        const { $from, empty } = state.selection;
        const strings = host().strings;
        if (!empty || !strings) return null;
        const parent = $from.parent;
        if (!parent.isTextblock || parent.content.size > 0) return null;
        const kind = parent.attrs.kind as string | undefined;
        const text =
          parent.type.name === 'codeBlock'
            ? strings.placeholderCode
            : kind === 'heading'
              ? strings.placeholderHeading
              : kind === 'bulletItem' || kind === 'numberedItem'
                ? strings.placeholderList
                : kind === 'checkItem'
                  ? strings.placeholderTodo
                  : kind === 'toggle'
                    ? strings.placeholderToggle
                    : kind === 'quote'
                      ? strings.placeholderQuote
                      : kind === 'callout'
                        ? strings.placeholderCallout
                        : parent.type.name === 'textBody'
                          ? strings.placeholder
                          : null;
        if (!text) return null;
        const pos = $from.before();
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + parent.nodeSize, {
            class: 'is-empty',
            'data-placeholder': text,
          }),
        ]);
      },
    },
  });
}

export const BlockDecorations = Extension.create<{ host: () => EditorHost }>({
  name: 'cgwDecorations',
  addOptions: () => ({ host: () => ({}) }),
  addProseMirrorPlugins() {
    return [numbers, placeholder(this.options.host)];
  },
});

/**
 * Top-level blocks have content-visibility auto (D26), and Chrome may not have laid out a block
 * made a moment ago: a key typed before the next frame then lands at the start of that block
 * ("Two" became "woT"). For two frames after a change to the block structure, typed characters
 * are inserted by the editor at its own selection instead of by the browser. Input rules and the
 * slash menu still see them; IME composition is never touched.
 */
export const StableTyping = Extension.create({
  name: 'cgwStableTyping',
  addProseMirrorPlugins() {
    let fresh = 0;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      fresh = 2;
      const tick = () => {
        if (--fresh > 0) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    return [
      new Plugin({
        key: new PluginKey('cgwStableTyping'),
        view: () => ({
          update(view, previous) {
            if (
              view.state.doc !== previous.doc &&
              view.state.doc.childCount !== previous.doc.childCount
            )
              settle();
            else if (view.state.doc !== previous.doc) {
              const now = view.state.selection.$from;
              const before = previous.selection.$from;
              if (now.depth > 0 && (before.depth === 0 || now.before(1) !== before.before(1)))
                settle();
            }
          },
          destroy: () => cancelAnimationFrame(frame),
        }),
        props: {
          handleDOMEvents: {
            beforeinput(view, event) {
              const input = event as InputEvent;
              if (
                fresh <= 0 ||
                input.inputType !== 'insertText' ||
                input.isComposing ||
                !input.data
              )
                return false;
              const { from, to } = view.state.selection;
              const text = input.data;
              input.preventDefault();
              const handled = view.someProp('handleTextInput', (f) =>
                f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
              );
              if (!handled)
                view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
              return true;
            },
          },
        },
      }),
    ];
  },
});
