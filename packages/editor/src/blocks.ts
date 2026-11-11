// Block operations as single ProseMirror transactions, written to be gentle on Yjs and to keep
// block ids (D4): a split keeps the id on the half with the content and the children with the
// original; a move keeps the id; a merge keeps the id of the block merged into; a duplicate clears
// ids so the id plugin mints new ones. Adapted from Phase 0's bench/editor/src/commands.ts.
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { newBlockId, type TextKind } from '@cgw/doc';

export interface BlockInfo {
  node: PMNode;
  pos: number;
  /** -1 when the parent is the document. */
  parentPos: number;
  index: number;
  depth: number;
  id: string | null;
}

export const isBody = (node: PMNode) => node.type.spec.group === 'body';
export const isBlock = (node: PMNode) => node.type.name === 'block';

export function listBlocks(doc: PMNode): BlockInfo[] {
  const out: BlockInfo[] = [];
  const walk = (node: PMNode, contentStart: number, parentPos: number, depth: number) => {
    node.forEach((child, offset, index) => {
      const pos = contentStart + offset;
      if (isBlock(child)) {
        out.push({ node: child, pos, parentPos, index, depth, id: child.attrs.id });
        walk(child, pos + 1, pos, depth + 1);
      }
    });
  };
  walk(doc, 0, -1, 0);
  return out;
}

/** The block at a document position: the innermost block containing it. */
export function blockAt($pos: ResolvedPos): BlockInfo | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (!isBlock(node)) continue;
    const pos = $pos.before(depth);
    let parentPos = -1;
    for (let d = depth - 1; d > 0; d--)
      if (isBlock($pos.node(d))) {
        parentPos = $pos.before(d);
        break;
      }
    return {
      node,
      pos,
      parentPos,
      index: $pos.index(depth - 1),
      depth: $pos.depth,
      id: node.attrs.id,
    };
  }
  return null;
}

export function blockInfoAt(doc: PMNode, pos: number): BlockInfo | null {
  const node = doc.nodeAt(pos);
  if (!node || !isBlock(node)) return null;
  return blockAt(doc.resolve(pos + 1));
}

/** The block the selection is in (or the selected block itself). */
export function currentBlock(state: EditorState): BlockInfo | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && isBlock(selection.node))
    return blockInfoAt(state.doc, selection.from);
  return blockAt(selection.$from);
}

/** The block's first body and its position, if it has one. */
export function firstBody(block: {
  node: PMNode;
  pos: number;
}): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  block.node.forEach((child, offset) => {
    if (!found && isBody(child)) found = { node: child, pos: block.pos + 1 + offset };
  });
  return found;
}

export function textKind(block: { node: PMNode; pos: number }): TextKind | null {
  const body = firstBody(block);
  return body?.node.type.name === 'textBody' ? (body.node.attrs.kind as TextKind) : null;
}

const parentOf = (state: EditorState, block: BlockInfo) =>
  block.parentPos < 0 ? state.doc : state.doc.nodeAt(block.parentPos)!;

/** Where a block's first child block would go: after its bodies. */
export function childBlocksStart(block: { node: PMNode; pos: number }): number {
  let offset = 0;
  block.node.forEach((child, childOffset) => {
    if (isBody(child) && offset === childOffset) offset = childOffset + child.nodeSize;
  });
  return block.pos + 1 + offset;
}

const hasChildBlocks = (node: PMNode) => {
  let found = false;
  node.forEach((child) => {
    if (isBlock(child)) found = true;
  });
  return found;
};

/** A copy of a subtree with every id cleared, so the id plugin mints fresh ones. */
export function withoutIds(node: PMNode): PMNode {
  if (node.isText || (!isBlock(node) && !node.childCount)) return node;
  const children: PMNode[] = [];
  node.forEach((child) => children.push(withoutIds(child)));
  const attrs = isBlock(node) ? { ...node.attrs, id: null } : node.attrs;
  return node.type.create(attrs, Fragment.from(children), node.marks);
}

export function newTextBlock(
  state: EditorState,
  kind: TextKind = 'paragraph',
  attrs = {},
  content?: Fragment,
) {
  const { nodes } = state.schema;
  return nodes.block.create(
    { id: newBlockId() },
    nodes.textBody.create({ kind, ...attrs }, content),
  );
}

/** What kind the block made by Enter takes. */
function continuationKind(kind: TextKind): TextKind {
  return kind === 'bulletItem' ||
    kind === 'numberedItem' ||
    kind === 'checkItem' ||
    kind === 'toggle'
    ? kind
    : 'paragraph';
}

/**
 * Enter inside a text body. At the start of a non-empty block: an empty block above, and this one
 * keeps its id. Elsewhere: the head keeps the id and the children; the tail becomes a new block,
 * the first child when the block has children (as an open toggle or a list would show it), else
 * the next sibling.
 */
export function splitBlock(
  state: EditorState,
  toggleOpen: (id: string) => boolean,
): Transaction | null {
  const { $from, $to } = state.selection;
  if ($from.parent.type.name !== 'textBody' || $from.parent !== $to.parent) return null;
  const block = blockAt($from);
  if (!block) return null;
  const body = $from.parent;
  const kind = body.attrs.kind as TextKind;
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const $at = tr.selection.$from;
  const offset = $at.parentOffset;
  const size = $at.parent.content.size;
  const bodyStart = $at.start();

  // An empty list item, quote or heading turns back into a paragraph first, as editors do.
  if (size === 0 && kind !== 'paragraph') {
    return tr.setNodeMarkup($at.before(), undefined, {
      ...body.attrs,
      kind: 'paragraph',
      level: null,
      checked: null,
    });
  }
  const nextKind = continuationKind(kind);
  const nextAttrs = nextKind === 'checkItem' ? { checked: false } : {};
  if (offset === 0 && size > 0) {
    tr.insert(
      block.pos,
      newTextBlock(state, kind === 'heading' ? 'paragraph' : nextKind, nextAttrs),
    );
    return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(bodyStart)));
  }
  const tail = $at.parent.content.cut(offset);
  const fresh = newTextBlock(state, nextKind, { ...nextAttrs, dir: body.attrs.dir }, tail);
  const blockNode = tr.doc.nodeAt(block.pos)!;
  const intoChildren =
    hasChildBlocks(blockNode) && (kind !== 'toggle' || (block.id ? toggleOpen(block.id) : true));
  const insertAt = intoChildren
    ? childBlocksStart({ node: blockNode, pos: block.pos })
    : block.pos + blockNode.nodeSize;
  tr.insert(insertAt, fresh);
  if (offset < size) tr.delete(bodyStart + offset, bodyStart + size);
  const freshPos = tr.mapping.map(insertAt, -1);
  return tr.setSelection(TextSelection.create(tr.doc, freshPos + 2));
}

/** The block drawn just above this one: the previous sibling's deepest last descendant, else the parent. */
function visuallyPrevious(state: EditorState, block: BlockInfo): BlockInfo | null {
  if (block.index === 0)
    return block.parentPos >= 0 ? blockInfoAt(state.doc, block.parentPos) : null;
  const parent = parentOf(state, block);
  const previous = parent.child(block.index - 1);
  if (!isBlock(previous))
    return block.parentPos >= 0 ? blockInfoAt(state.doc, block.parentPos) : null;
  let info = blockInfoAt(state.doc, block.pos - previous.nodeSize)!;
  for (;;) {
    let last: { node: PMNode; offset: number } | null = null;
    info.node.forEach((child, offset) => {
      if (isBlock(child)) last = { node: child, offset };
    });
    if (!last) return info;
    info = blockInfoAt(state.doc, info.pos + 1 + (last as { offset: number }).offset)!;
  }
}

/**
 * Backspace at the start of a text body. A kind other than paragraph turns into a paragraph
 * first. Otherwise the block merges into the text block drawn above it: that block keeps its id,
 * this block's text joins its body, and this block's children follow as its children.
 */
export function mergeBackward(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty || selection.$from.parentOffset !== 0) return null;
  const $from = selection.$from;
  if ($from.parent.type.name !== 'textBody') return null;
  const block = blockAt($from);
  if (!block) return null;
  const from = firstBody(block);
  if (!from || from.node !== $from.parent) return null;
  if (from.node.attrs.kind !== 'paragraph')
    return state.tr.setNodeMarkup(from.pos, undefined, {
      ...from.node.attrs,
      kind: 'paragraph',
      level: null,
      checked: null,
    });
  if (block.index === 0 && block.parentPos >= 0) {
    // The first child of a block: outdent rather than vanish into the parent.
    return outdent(state, block);
  }
  const target = visuallyPrevious(state, block);
  if (!target) return null;
  const into = firstBody(target);
  if (!into || !into.node.isTextblock || into.node.type.spec.code) {
    // An atom (divider, image) above: select it, so a second Backspace deletes it.
    if (into && !into.node.isTextblock)
      return state.tr.setSelection(NodeSelection.create(state.doc, into.pos));
    return null;
  }
  const rest: PMNode[] = [];
  block.node.forEach((child) => {
    if (child !== from.node) rest.push(child);
  });
  const tr = state.tr;
  const joinAt = into.pos + 1 + into.node.content.size;
  tr.delete(block.pos, block.pos + block.node.nodeSize);
  const targetNode = tr.doc.nodeAt(tr.mapping.map(target.pos))!;
  const targetPos = tr.mapping.map(target.pos);
  if (rest.length) tr.insert(targetPos + targetNode.nodeSize - 1, rest);
  if (from.node.content.size) tr.insert(tr.mapping.map(joinAt, -1), from.node.content);
  return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(joinAt, -1)));
}

/** Delete at the end of a text body: the next block drawn below merges into this one. */
export function mergeForward(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name !== 'textBody' || $from.parentOffset !== $from.parent.content.size)
    return null;
  const blocks = listBlocks(state.doc);
  const index = blocks.findIndex((b) => b.pos === blockAt($from)?.pos);
  const next = blocks[index + 1];
  if (!next) return null;
  const body = firstBody(next);
  if (!body || body.node.type.name !== 'textBody') return null;
  const shifted = state.apply(state.tr.setSelection(TextSelection.create(state.doc, body.pos + 1)));
  const asParagraph =
    body.node.attrs.kind === 'paragraph'
      ? shifted
      : shifted.apply(
          shifted.tr.setNodeMarkup(body.pos, undefined, { ...body.node.attrs, kind: 'paragraph' }),
        );
  const merged = mergeBackward(asParagraph);
  if (!merged) return null;
  // Rebuild as one transaction on the original state.
  const tr = state.tr;
  if (body.node.attrs.kind !== 'paragraph')
    tr.setNodeMarkup(body.pos, undefined, { ...body.node.attrs, kind: 'paragraph' });
  for (const step of merged.steps) tr.step(step);
  return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(selection.from, -1)));
}

/** Moves a block (and its subtree) to a position; the id goes with it. */
export function moveBlock(
  state: EditorState,
  block: BlockInfo,
  targetPos: number,
): Transaction | null {
  const end = block.pos + block.node.nodeSize;
  if (targetPos >= block.pos && targetPos <= end) return null;
  const tr = state.tr;
  let newPos: number;
  if (targetPos > end) {
    tr.insert(targetPos, block.node);
    tr.delete(block.pos, end);
    newPos = targetPos - block.node.nodeSize;
  } else {
    tr.delete(block.pos, end);
    tr.insert(targetPos, block.node);
    newPos = targetPos;
  }
  // A caret inside the moved block goes with it, as the block does on screen.
  const { from, to } = state.selection;
  if (from > block.pos && to < end && !(state.selection instanceof NodeSelection)) {
    const shift = newPos - block.pos;
    tr.setSelection(TextSelection.create(tr.doc, from + shift, to + shift));
  } else if (state.selection instanceof NodeSelection && from >= block.pos && to <= end) {
    tr.setSelection(NodeSelection.create(tr.doc, from + newPos - block.pos));
  }
  return tr;
}

/** Tab: the block becomes the last child of the block above it. */
export function indent(state: EditorState, block: BlockInfo): Transaction | null {
  if (block.index === 0) return null;
  const parent = parentOf(state, block);
  const previous = parent.child(block.index - 1);
  if (!isBlock(previous)) return null;
  const previousPos = block.pos - previous.nodeSize;
  return moveBlock(state, block, previousPos + previous.nodeSize - 1);
}

/**
 * Shift+Tab: the block moves out to follow its parent, and the siblings that came after it become
 * its children, so nothing jumps on screen.
 */
export function outdent(state: EditorState, block: BlockInfo): Transaction | null {
  if (block.parentPos < 0) return null;
  const parent = state.doc.nodeAt(block.parentPos)!;
  const tr = state.tr;
  const followers: PMNode[] = [];
  let followersStart = block.pos + block.node.nodeSize;
  const parentEnd = block.parentPos + parent.nodeSize - 1;
  parent.forEach((child, offset, index) => {
    if (index > block.index && isBlock(child)) followers.push(child);
    if (index === block.index + 1) followersStart = block.parentPos + 1 + offset;
  });
  let moved = block.node;
  if (followers.length) {
    moved = block.node.copy(block.node.content.append(Fragment.from(followers)));
    tr.delete(followersStart, parentEnd);
  }
  tr.delete(block.pos, block.pos + block.node.nodeSize);
  const after = tr.mapping.map(block.parentPos + parent.nodeSize);
  tr.insert(after, moved);
  const { from, to } = state.selection;
  if (from > block.pos && to < block.pos + block.node.nodeSize)
    tr.setSelection(TextSelection.create(tr.doc, from - block.pos + after, to - block.pos + after));
  return tr;
}

/** Alt+Shift+Up and Down: swap with the sibling above or below. */
export function moveSibling(
  state: EditorState,
  block: BlockInfo,
  direction: -1 | 1,
): Transaction | null {
  const parent = parentOf(state, block);
  const neighbourIndex = block.index + direction;
  if (neighbourIndex < 0 || neighbourIndex >= parent.childCount) return null;
  const neighbour = parent.child(neighbourIndex);
  if (!isBlock(neighbour)) return null;
  const target =
    direction < 0
      ? block.pos - neighbour.nodeSize
      : block.pos + block.node.nodeSize + neighbour.nodeSize;
  return moveBlock(state, block, target);
}

export function duplicateBlock(state: EditorState, block: BlockInfo): Transaction {
  return state.tr.insert(block.pos + block.node.nodeSize, withoutIds(block.node));
}

export function deleteBlock(state: EditorState, block: BlockInfo): Transaction {
  return state.tr.delete(block.pos, block.pos + block.node.nodeSize);
}

export interface TurnInto {
  kind: TextKind;
  attrs?: Record<string, unknown>;
}

/**
 * "Turn into" between text kinds changes `kind` and keeps the id, the text, the marks and the
 * children. Into or out of a code block the body is replaced (DATA_MODEL.md): the text is kept,
 * the marks are not.
 */
export function turnInto(
  state: EditorState,
  block: BlockInfo,
  target: TurnInto | 'codeBlock',
): Transaction | null {
  const body = firstBody(block);
  if (!body) return null;
  const { schema } = state;
  const tr = state.tr;
  if (target === 'codeBlock') {
    if (body.node.type.name === 'codeBlock') return null;
    if (!body.node.isTextblock) return null;
    const text = body.node.textContent;
    tr.replaceWith(
      body.pos,
      body.pos + body.node.nodeSize,
      schema.nodes.codeBlock.create(null, text ? schema.text(text) : null),
    );
    return tr;
  }
  const attrs = {
    kind: target.kind,
    level: target.kind === 'heading' ? (target.attrs?.level ?? 1) : null,
    checked: target.kind === 'checkItem' ? false : null,
    ...target.attrs,
  };
  if (body.node.type.name === 'textBody') {
    return tr.setNodeMarkup(body.pos, undefined, { ...body.node.attrs, ...attrs });
  }
  if (body.node.type.name === 'codeBlock') {
    const text = body.node.textContent;
    // Lines of code become hard breaks, so nothing is lost.
    const parts: PMNode[] = [];
    text.split('\n').forEach((line, i) => {
      if (i) parts.push(schema.nodes.hardBreak.create());
      if (line) parts.push(schema.text(line));
    });
    tr.replaceWith(
      body.pos,
      body.pos + body.node.nodeSize,
      schema.nodes.textBody.create(attrs, parts),
    );
    return tr;
  }
  return null;
}

/** The sibling range a block selection covers, from one block to another under the same parent. */
export function siblingRange(state: EditorState, anchor: number, head: number): BlockInfo[] {
  const a = blockInfoAt(state.doc, anchor);
  const b = blockInfoAt(state.doc, head);
  if (!a || !b || a.parentPos !== b.parentPos) return a ? [a] : [];
  const [from, to] = a.pos <= b.pos ? [a, b] : [b, a];
  const out: BlockInfo[] = [];
  const parent = parentOf(state, from);
  let pos = from.parentPos < 0 ? 0 : from.parentPos + 1;
  parent.forEach((child, _offset, index) => {
    if (isBlock(child) && index >= from.index && index <= to.index)
      out.push({
        node: child,
        pos,
        parentPos: from.parentPos,
        index,
        depth: from.depth,
        id: child.attrs.id,
      });
    pos += child.nodeSize;
  });
  return out;
}
