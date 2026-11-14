// Presence (Phase 6, contracts sections 4 and 6): the others' cursors on this page, from the host
// (`presence.cursors()`), drawn as ProseMirror decorations: a caret in the person's colour with
// their name over it, their selection tinted, an outline on a block they selected whole. Each end
// is a Yjs relative position (base64), resolved through the binding (`absolutePosition`, the sync
// plugin's mapping). They are made again only when the host says the cursors changed or the
// document changed under them (sourced.ts); never React, never a node view made again, so no
// embed's frame is touched. This editor's own selection goes to the host as two relative positions
// (`presence.setLocal`) at most every 50 ms while it has focus, and null when it loses it.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { absolutePosition, relativePosition } from '@cgw/doc';
import type { EditorHost, OnHostChange, PresenceCursor } from './host';
import { refresher, sourcedStep, staleAfter } from './sourced';

export const presenceKey = new PluginKey<PresenceState>('cgwPresence');

interface PresenceState {
  set: DecorationSet;
  /** A local change mapped the cursors past what mapping keeps right: the view asks again. */
  stale: boolean;
}

const init = (): PresenceState => ({ set: DecorationSet.empty, stale: false });

/** How long a selection waits before it is told, so typing names it once per 50 ms at most. */
export const LOCAL_DELAY_MS = 50;

/**
 * A colour for a style: a theme token by name (`--cgw-presence-3`) or as `var(...)`, or a plain
 * colour value. Anything that could end the declaration is refused (the theme's accent instead).
 */
export function presenceColour(value: string): string {
  if (/^--[\w-]+$/.test(value)) return `var(${value})`;
  return /^[\w#%(),.\s-]+$/.test(value) ? value : 'var(--cg-accent)';
}

/** A caret: an empty mark in the line, its name drawn by CSS (not text in the page). */
function caret(cursor: PresenceCursor, colour: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'cgw-presence-caret';
  element.contentEditable = 'false';
  element.setAttribute('aria-hidden', 'true');
  element.dataset.name = cursor.name;
  element.dataset.userId = cursor.userId;
  element.style.setProperty('--cgw-presence-colour', colour);
  return element;
}

/** The decorations for the cursors that resolve in this document; the others are left out. */
export function cursorDecorations(state: EditorState, cursors: PresenceCursor[]): DecorationSet {
  const decorations: Decoration[] = [];
  const size = state.doc.content.size;
  for (const cursor of cursors) {
    const anchor = absolutePosition(state, cursor.anchor);
    const head = absolutePosition(state, cursor.head);
    if (anchor === null || head === null || anchor > size || head > size) continue;
    const colour = presenceColour(cursor.colour);
    const style = `--cgw-presence-colour: ${colour}`;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const selected: PMNode | null = from < to ? state.doc.nodeAt(from) : null;
    if (selected && selected.isAtom && !selected.isInline && from + selected.nodeSize === to) {
      // A block selected whole (an image, an embed): outlined, its name beside it.
      decorations.push(
        Decoration.node(from, to, {
          class: 'is-presence-selected',
          'data-presence-name': cursor.name,
          style,
        }),
      );
      continue;
    }
    if (from < to)
      decorations.push(
        Decoration.inline(from, to, { class: 'cgw-presence-selection', style }, { presence: true }),
      );
    if (state.doc.resolve(head).parent.inlineContent)
      decorations.push(
        Decoration.widget(head, () => caret(cursor, colour), {
          // A new caret each time it moves, so its name shows again (CSS fades it).
          key: `presence:${cursor.key}:${cursor.head}:${cursor.name}:${colour}`,
          side: 10,
          ignoreSelection: true,
        }),
      );
  }
  return DecorationSet.create(state.doc, decorations);
}

class PresenceView {
  private unsubscribe: (() => void) | null = null;
  private readonly offHost: () => void;
  private readonly refresh: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What the host was last told (JSON), so the same selection is not told twice. */
  private told = 'null';

  constructor(
    private readonly view: EditorView,
    private readonly host: () => EditorHost,
    onHostChange: OnHostChange,
  ) {
    this.refresh = refresher(view, presenceKey);
    this.subscribe();
    this.offHost = onHostChange(() => {
      this.subscribe();
      this.refresh();
      this.told = 'null';
      this.queueLocal();
    });
  }

  private subscribe() {
    this.unsubscribe?.();
    this.unsubscribe = this.host().presence?.subscribe(this.refresh) ?? null;
  }

  update(view: EditorView, previous: EditorState) {
    if (presenceKey.getState(view.state)?.stale) this.refresh();
    if (!view.state.selection.eq(previous.selection) || view.state.doc !== previous.doc)
      this.queueLocal();
  }

  /** The selection, once the burst of changes settles (the host throttles what it sends). */
  queueLocal() {
    if (!this.host().presence || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tellLocal();
    }, LOCAL_DELAY_MS);
  }

  tellLocal() {
    const presence = this.host().presence;
    if (!presence || this.view.isDestroyed) return;
    let cursor: { anchor: string; head: string } | null = null;
    if (this.view.hasFocus()) {
      const { state } = this.view;
      const anchor = relativePosition(state, state.selection.anchor);
      const head = relativePosition(state, state.selection.head);
      if (anchor && head) cursor = { anchor, head };
    }
    const told = JSON.stringify(cursor);
    if (told === this.told) return;
    this.told = told;
    presence.setLocal(cursor);
  }

  blur() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.told === 'null') return;
    this.told = 'null';
    this.host().presence?.setLocal(null);
  }

  destroy() {
    this.blur();
    this.unsubscribe?.();
    this.offHost();
  }
}

export const Presence = Extension.create<{ host: () => EditorHost; onHostChange: OnHostChange }>({
  name: 'cgwPresence',
  addOptions: () => ({ host: () => ({}), onHostChange: () => () => {} }),
  addProseMirrorPlugins() {
    const { host, onHostChange } = this.options;
    let current: PresenceView | null = null;
    return [
      new Plugin<PresenceState>({
        key: presenceKey,
        state: {
          init,
          apply(tr, value, _old, state) {
            const presence = host().presence;
            if (!presence) return value.set === DecorationSet.empty ? value : init();
            const step = sourcedStep(tr, presenceKey);
            if (step === 'compute')
              return { set: cursorDecorations(state, presence.cursors()), stale: false };
            if (step === 'keep' || value.set === DecorationSet.empty) return value;
            return { set: value.set.map(tr.mapping, tr.doc), stale: value.stale || staleAfter(tr) };
          },
        },
        view: (view) => (current = new PresenceView(view, host, onHostChange)),
        props: {
          decorations: (state) => presenceKey.getState(state)?.set ?? null,
          handleDOMEvents: {
            focus: () => {
              current?.queueLocal();
              return false;
            },
            blur: () => {
              current?.blur();
              return false;
            },
          },
        },
      }),
    ];
  },
});
