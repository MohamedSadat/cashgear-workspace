// Comments in the page (Phase 6, contracts sections 3 and 6). A thread is anchored relationally:
// its block by id, and in it the range's ends as Yjs relative positions, with the text it was
// made on as the fallback; the document never changes. Each open thread the host gives
// (`comments.threads()`) is found by the rule of section 3 (`resolveAnchor`, pure and tested) and
// drawn as decorations: an inline highlight (stronger for the panel's `active` one) with a small
// marker button at its end, or, when only its block is found, a tint on the block's body and the
// marker. Clicking a highlight or a marker, or Enter or Space on a focused marker, calls
// `comments.open`. "Comment" (bubble toolbar, block menu, Ctrl+Alt+M by `event.code`) computes an
// anchor from the selection (`commentAnchorFor`) and gives it to `comments.create`. As presence's
// cursors, they are made again only when the threads or the document under them change
// (sourced.ts): no React render and no embed frame made again per keystroke.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { absolutePosition, dateMentionText, relativePosition } from '@cgw/doc';
import { blockAt, blockInfoAt, firstBody, isBlock, isBody } from './blocks';
import { selectedBlocks } from './blockSelection';
import {
  editorString,
  type AnchorFound,
  type CommentAnchor,
  type CommentThreadAnchor,
  type EditorHost,
  type OnHostChange,
} from './host';
import { refresher, sourcedStep, staleAfter } from './sourced';

/** The most text a thread keeps as its quote (contracts section 3: `Quote` nvarchar(1000)). */
export const QUOTE_MAX = 1000;

/** Where a thread was found (`anchorsInOrder`), with what is drawn for it. */
export interface ResolvedAnchor {
  threadId: string;
  found: AnchorFound;
  /** The range drawn, for `range` and `quote`; null otherwise. */
  from: number | null;
  to: number | null;
  /** The block's position, null when it is missing. */
  block: number | null;
}

/** What `resolveAnchor` reads the document through. */
export interface AnchorContext {
  doc: PMNode;
  /** Block id → the position of the (first) block with it. */
  blocks: ReadonlyMap<string, number>;
  /** Where a relative position (base64) is now, or null when it does not resolve. */
  position(encoded: string): number | null;
  /** The text an inline leaf reads as in a quote (a line break, a date, a mention). */
  leafText?(node: PMNode): string;
  /** Where in its block's text the thread was last found: "nearest the old place". */
  lastOffset?(threadId: string): number | undefined;
}

/** A node's text, with the position each character starts and ends at in the document. */
export interface PositionedText {
  text: string;
  starts: number[];
  ends: number[];
}

/** A leaf's text in a quote: a line break, a date as stored, otherwise its `leafText`. */
const defaultLeafText = (node: PMNode): string =>
  node.type.name === 'hardBreak'
    ? '\n'
    : node.type.name === 'dateMention'
      ? dateMentionText(node.attrs)
      : (node.type.spec.leafText?.(node) ?? '');

/**
 * The text inside `node`, whose content starts at `contentStart`: its text, its inline leaves'
 * text (`leaf`), a line between two text blocks (table cells). Each character's start and end.
 */
export function positionedText(
  node: PMNode,
  contentStart: number,
  leaf: (node: PMNode) => string = defaultLeafText,
): PositionedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let lines = 0;
  node.descendants((child, offset) => {
    const at = contentStart + offset;
    if (child.isText) {
      const value = child.text ?? '';
      for (let i = 0; i < value.length; i++) {
        starts.push(at + i);
        ends.push(at + i + 1);
      }
      text += value;
      return false;
    }
    if (child.isLeaf) {
      const value = leaf(child);
      for (let i = 0; i < value.length; i++) {
        starts.push(at);
        ends.push(at + child.nodeSize);
      }
      text += value;
      return false;
    }
    if (child.isTextblock && lines++ > 0) {
      text += '\n';
      starts.push(at);
      ends.push(at);
    }
    return true;
  });
  return { text, starts, ends };
}

/** The character index where `pos` falls in a positioned text (the first one at or after it). */
function offsetOf(text: PositionedText, pos: number): number {
  let low = 0;
  let high = text.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (text.starts[mid] < pos) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Finds a thread in the document by the rule of contracts section 3: the block by id; the
 * range's ends resolved, if both land inside that block's body in order (`start` before `end`:
 * a range whose text is all gone is not one); else, if the quote is not empty and is in the
 * block's text, its occurrence nearest the old place (where it was last found here, else where
 * `start` landed in the block, else the first); else the whole block. No block with that id:
 * `missing`.
 */
export function resolveAnchor(
  thread: Pick<CommentThreadAnchor, 'id' | 'blockId' | 'start' | 'end' | 'quote'>,
  context: AnchorContext,
): ResolvedAnchor {
  const none = { threadId: thread.id, from: null, to: null };
  const blockPos = context.blocks.get(thread.blockId);
  const block = blockPos === undefined ? null : context.doc.nodeAt(blockPos);
  if (blockPos === undefined || !block || !isBlock(block))
    return { ...none, found: 'missing', block: null };
  const whole: ResolvedAnchor = { ...none, found: 'block', block: blockPos };
  const body = block.firstChild;
  if (!body || !isBody(body) || body.isLeaf) return whole;
  const bodyPos = blockPos + 1;
  const contentFrom = bodyPos + 1;
  const contentTo = bodyPos + body.nodeSize - 1;
  const inside = (pos: number | null): pos is number =>
    pos !== null && pos >= contentFrom && pos <= contentTo;

  const start = thread.start ? context.position(thread.start) : null;
  const end = thread.end ? context.position(thread.end) : null;
  if (inside(start) && inside(end) && start < end)
    return { ...whole, found: 'range', from: start, to: end };

  if (!thread.quote) return whole;
  const text = positionedText(body, contentFrom, context.leafText);
  const occurrences: number[] = [];
  for (
    let at = text.text.indexOf(thread.quote);
    at >= 0;
    at = text.text.indexOf(thread.quote, at + 1)
  )
    occurrences.push(at);
  if (!occurrences.length) return whole;
  const old = context.lastOffset?.(thread.id) ?? (inside(start) ? offsetOf(text, start) : 0);
  let best = occurrences[0];
  for (const at of occurrences) if (Math.abs(at - old) < Math.abs(best - old)) best = at;
  const from = text.starts[best];
  const to = text.ends[best + thread.quote.length - 1];
  return from < to ? { ...whole, found: 'quote', from, to } : whole;
}

/** Block id → position, for every block (the first of two with one id, until it is repaired). */
export function blockPositions(doc: PMNode): Map<string, number> {
  const blocks = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!isBlock(node)) return false;
    const id = node.attrs.id as string | null;
    if (id && !blocks.has(id)) blocks.set(id, pos);
    return true;
  });
  return blocks;
}

/** A leaf's text in this editor's quotes: a person's mention as `@` and their name. */
export function leafTextFor(host: EditorHost) {
  return (node: PMNode): string => {
    if (node.type.name === 'userMention') {
      const id = node.attrs.userId as string | null;
      return `@${(id && host.people?.name(id)) || ''}`;
    }
    if (node.type.name === 'pageMention')
      return host.pages?.title(String(node.attrs.pageId ?? '')) ?? '';
    return defaultLeafText(node);
  };
}

/** A quote of at most `QUOTE_MAX` characters, never ending inside a surrogate pair. */
function cutQuote(text: string): string {
  if (text.length <= QUOTE_MAX) return text;
  const code = text.charCodeAt(QUOTE_MAX - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? QUOTE_MAX - 1 : QUOTE_MAX);
}

/**
 * The anchor "Comment" makes from the selection: the selection's first block; inside its body's
 * text, the selected part of the first line of text the selection starts in (its ends as relative
 * positions: the start sticks to the first character, the end to the last, so text typed at
 * either edge stays out), with that text as the quote. A collapsed caret, a block selected whole
 * (or blocks: the first), an atom block, or an editor not bound to Yjs: the whole block (`start`
 * and `end` null, quote ""). Null when there is no block with an id there.
 */
export function commentAnchorFor(state: EditorState, host: EditorHost): CommentAnchor | null {
  const { selection } = state;
  const chosen = selectedBlocks(state)[0];
  const block =
    chosen ??
    (selection instanceof NodeSelection && isBlock(selection.node)
      ? blockInfoAt(state.doc, selection.from)
      : (blockAt(selection.$from) ?? blockInfoAt(state.doc, selection.from)));
  if (!block?.id) return null;
  const whole: CommentAnchor = { blockId: block.id, start: null, end: null, quote: '' };
  if (chosen || selection.empty || selection instanceof NodeSelection) return whole;
  const { $from } = selection;
  const body = firstBody(block);
  if (!body || !$from.parent.inlineContent) return whole;
  // Text of the block's own body, not of a child block's.
  if ($from.pos <= body.pos || $from.pos >= body.pos + body.node.nodeSize) return whole;
  const from = $from.pos;
  const to = Math.min(selection.to, $from.end());
  if (to <= from) return whole;
  const text = positionedText(body.node, body.pos + 1, leafTextFor(host));
  let quote = '';
  for (let i = offsetOf(text, from); i < text.starts.length && text.ends[i] <= to; i++)
    quote += text.text[i];
  const start = relativePosition(state, from, 0);
  const end = relativePosition(state, to, -1);
  if (!start || !end || !quote) return whole;
  return { blockId: block.id, start, end, quote: cutQuote(quote) };
}

/** "Comment" on the selection: the anchor to the host. False when it may not, or none. */
export function commentOnSelection(state: EditorState, host: EditorHost): boolean {
  const create = host.comments?.create;
  if (!create) return false;
  const anchor = commentAnchorFor(state, host);
  if (!anchor) return false;
  create(anchor);
  return true;
}

/** "Comment" on a whole block (the block menu). */
export function commentOnBlock(state: EditorState, host: EditorHost, blockPos: number): boolean {
  const create = host.comments?.create;
  const block = blockInfoAt(state.doc, blockPos);
  if (!create || !block?.id) return false;
  create({ blockId: block.id, start: null, end: null, quote: '' });
  return true;
}

export const commentsKey = new PluginKey<CommentsState>('cgwComments');

interface CommentsState {
  set: DecorationSet;
  /** Every thread drawn, as found, in the order the host gave them. */
  resolved: ResolvedAnchor[];
  stale: boolean;
}

const empty: CommentsState = { set: DecorationSet.empty, resolved: [], stale: false };

/** A marker at the end of a thread's range, or of its block: a button that opens it. */
function marker(host: () => EditorHost, threadId: string, active: boolean) {
  return () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = active ? 'cgw-commented-pin is-active' : 'cgw-commented-pin';
    button.contentEditable = 'false';
    button.dataset.commentThread = threadId;
    const label = editorString(host(), 'commentOpen');
    button.setAttribute('aria-label', label);
    button.title = label;
    // The editor keeps its selection; the host is told which thread.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      host().comments?.open(threadId);
    });
    return button;
  };
}

/** Every thread found, and its decorations. `offsets` keeps where each was last found. */
function computeComments(
  state: EditorState,
  host: () => EditorHost,
  offsets: Map<string, number>,
): CommentsState {
  const threads = host().comments?.threads() ?? [];
  if (!threads.length) {
    offsets.clear();
    return empty;
  }
  const leafText = leafTextFor(host());
  const context: AnchorContext = {
    doc: state.doc,
    blocks: blockPositions(state.doc),
    position: (encoded) => absolutePosition(state, encoded),
    leafText,
    lastOffset: (id) => offsets.get(id),
  };
  const resolved: ResolvedAnchor[] = [];
  const decorations: Decoration[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    const found = resolveAnchor(thread, context);
    resolved.push(found);
    const active = !!thread.active;
    if (found.from !== null && found.to !== null && found.block !== null) {
      const body = state.doc.nodeAt(found.block + 1)!;
      offsets.set(thread.id, offsetOf(positionedText(body, found.block + 2, leafText), found.from));
      decorations.push(
        Decoration.inline(
          found.from,
          found.to,
          {
            class: active ? 'cgw-commented is-active' : 'cgw-commented',
            'data-comment': thread.id,
          },
          { threadId: thread.id },
        ),
        Decoration.widget(found.to, marker(host, thread.id, active), {
          key: `comment:${thread.id}:${active}`,
          side: 1,
          stopEvent: () => true,
          ignoreSelection: true,
        }),
      );
    } else if (found.found === 'block' && found.block !== null) {
      const bodyPos = found.block + 1;
      const body = state.doc.nodeAt(bodyPos);
      if (!body) continue;
      // Not a `cgw-` class: a text body's view keeps only its own of those.
      decorations.push(
        Decoration.node(bodyPos, bodyPos + body.nodeSize, {
          class: active ? 'is-commented is-comment-active' : 'is-commented',
        }),
        Decoration.widget(
          body.inlineContent ? bodyPos + body.nodeSize - 1 : bodyPos + body.nodeSize,
          marker(host, thread.id, active),
          {
            key: `comment:${thread.id}:${active}`,
            side: body.inlineContent ? 1 : -1,
            stopEvent: () => true,
            ignoreSelection: true,
          },
        ),
      );
    }
  }
  return { set: DecorationSet.create(state.doc, decorations), resolved, stale: false };
}

/** The threads in the order the page reads: by where each was found; missing ones last. */
export function anchorsInOrder(
  state: EditorState,
): { threadId: string; found: AnchorFound; pos: number | null }[] {
  const resolved = commentsKey.getState(state)?.resolved ?? [];
  return resolved
    .map((r, index) => ({ r, index, pos: r.from ?? r.block }))
    .sort((a, b) =>
      a.pos === null || b.pos === null
        ? (a.pos === null ? 1 : 0) - (b.pos === null ? 1 : 0) || a.index - b.index
        : a.pos - b.pos || a.index - b.index,
    )
    .map(({ r, pos }) => ({ threadId: r.threadId, found: r.found, pos }));
}

/** Scrolls the thread's range or block into the middle of the view; false when it is missing. */
export function scrollToThread(view: EditorView, threadId: string): boolean {
  const found = commentsKey.getState(view.state)?.resolved.find((r) => r.threadId === threadId);
  if (!found) return false;
  let element: Element | null;
  if (found.from !== null) {
    const { node } = view.domAtPos(found.from);
    element = node instanceof Element ? node : node.parentElement;
  } else if (found.block !== null) {
    const dom = view.nodeDOM(found.block);
    element = dom instanceof Element ? dom : null;
  } else return false;
  if (!element) return false;
  element.scrollIntoView?.({ block: 'center' });
  return true;
}

class CommentsView {
  private unsubscribe: (() => void) | null = null;
  private readonly offHost: () => void;
  readonly refresh: () => void;

  constructor(
    view: EditorView,
    private readonly host: () => EditorHost,
    onHostChange: OnHostChange,
  ) {
    this.refresh = refresher(view, commentsKey);
    this.subscribe();
    this.offHost = onHostChange(() => {
      this.subscribe();
      this.refresh();
    });
  }

  private subscribe() {
    this.unsubscribe?.();
    this.unsubscribe = this.host().comments?.subscribe(this.refresh) ?? null;
  }

  update(view: EditorView) {
    if (commentsKey.getState(view.state)?.stale) this.refresh();
  }

  destroy() {
    this.unsubscribe?.();
    this.offHost();
  }
}

/** Ctrl+Alt+M (Cmd+Option+M on a Mac), by the key's place, whatever the layout. */
export const isCommentKey = (event: KeyboardEvent) =>
  event.code === 'KeyM' && event.altKey && (event.ctrlKey || event.metaKey) && !event.shiftKey;

export const Comments = Extension.create<{ host: () => EditorHost; onHostChange: OnHostChange }>({
  name: 'cgwComments',
  addOptions: () => ({ host: () => ({}), onHostChange: () => () => {} }),
  addProseMirrorPlugins() {
    const { host, onHostChange } = this.options;
    // Where each thread was last found in its block's text, while this editor lives.
    const offsets = new Map<string, number>();
    return [
      new Plugin<CommentsState>({
        key: commentsKey,
        state: {
          init: (_, state) => (host().comments ? computeComments(state, host, offsets) : empty),
          apply(tr, value, _old, state) {
            if (!host().comments) return value === empty ? value : empty;
            const step = sourcedStep(tr, commentsKey);
            if (step === 'compute') return computeComments(state, host, offsets);
            if (step === 'keep' || !value.resolved.length) return value;
            const map = (pos: number | null, assoc: number) =>
              pos === null ? null : tr.mapping.map(pos, assoc);
            let collapsed = false;
            const resolved = value.resolved.map((r) => {
              const next = {
                ...r,
                from: map(r.from, 1),
                to: map(r.to, -1),
                block: map(r.block, 1),
              };
              if (next.from !== null && next.to !== null && next.from >= next.to) collapsed = true;
              return next;
            });
            return {
              set: value.set.map(tr.mapping, tr.doc),
              resolved,
              stale: value.stale || collapsed || staleAfter(tr),
            };
          },
        },
        view: (view) => new CommentsView(view, host, onHostChange),
        props: {
          decorations: (state) => commentsKey.getState(state)?.set ?? null,
          handleClick(view, pos, event) {
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest('.cgw-commented')) return false;
            const open = host().comments?.open;
            const hits = (commentsKey.getState(view.state)?.resolved ?? []).filter(
              (r) => r.from !== null && r.to !== null && r.from <= pos && pos <= r.to,
            );
            if (!open || !hits.length) return false;
            // The narrowest range under the pointer: the one drawn innermost.
            hits.sort((a, b) => a.to! - a.from! - (b.to! - b.from!));
            open(hits[0].threadId);
            return false;
          },
          handleKeyDown(view, event) {
            if (!isCommentKey(event)) return false;
            if (!commentOnSelection(view.state, host())) return false;
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
