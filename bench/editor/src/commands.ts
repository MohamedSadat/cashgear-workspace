// Block operations as single ProseMirror transactions, written to be gentle on Yjs:
// a split keeps the children where they are, a merge moves only what it must.
import { Fragment, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TEXT_KINDS, type SchemaVariant } from './schema';

export interface BlockInfo {
  node: PMNode;
  pos: number;
  /** -1 when the parent is the document. */
  parentPos: number;
  index: number;
  depth: number;
  id: string | null;
}

export function listBlocks(doc: PMNode): BlockInfo[] {
  const out: BlockInfo[] = [];
  const walk = (node: PMNode, contentStart: number, parentPos: number, depth: number) => {
    node.forEach((child, offset, index) => {
      const pos = contentStart + offset;
      if (child.type.name === 'block') {
        out.push({ node: child, pos, parentPos, index, depth, id: child.attrs.id });
        walk(child, pos + 1, pos, depth + 1);
      }
    });
  };
  walk(doc, 0, -1, 0);
  return out;
}

const isBody = (node: PMNode) => node.type.spec.group === 'body';

/** The block's first body and its position, if it has one. */
export function firstBody(block: BlockInfo): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  block.node.forEach((child, offset) => {
    if (!found && isBody(child)) found = { node: child, pos: block.pos + 1 + offset };
  });
  return found;
}

export function blockText(block: PMNode): string {
  let text = '';
  block.forEach((child) => {
    if (isBody(child)) text += child.textContent;
  });
  return text;
}

export type Random = () => number;
export const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)];
export const between = (random: Random, low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));

/** mulberry32: a small seeded generator, so a failing run can be replayed. */
export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ops {
  variant: SchemaVariant;
  textBlocks(state: EditorState): { block: BlockInfo; body: { node: PMNode; pos: number } }[];
  newBlock(state: EditorState, text: string, kind?: string): PMNode;
  typeText(state: EditorState, blockPos: number, offset: number, text: string): Transaction;
  split(state: EditorState, block: BlockInfo, offset: number): Transaction | null;
  merge(state: EditorState, block: BlockInfo): Transaction | null;
  move(state: EditorState, block: BlockInfo, targetPos: number): Transaction | null;
  indent(state: EditorState, block: BlockInfo): Transaction | null;
  outdent(state: EditorState, block: BlockInfo): Transaction | null;
  convert(state: EditorState, block: BlockInfo, kind: string): Transaction | null;
  insertBlocks(state: EditorState, targetPos: number, blocks: PMNode[]): Transaction;
  duplicate(state: EditorState, block: BlockInfo): Transaction;
  deleteBlock(state: EditorState, block: BlockInfo): Transaction;
  /** Places a block may be inserted at, as document positions, outside `exclude`. */
  slots(state: EditorState, exclude?: BlockInfo): number[];
}

/** A copy of a block's subtree with every id cleared, so the id plugin mints fresh ones. */
export function withoutIds(node: PMNode): PMNode {
  if (node.type.name !== 'block' && !node.childCount) return node;
  const children: PMNode[] = [];
  node.forEach((child) => children.push(withoutIds(child)));
  const attrs = node.type.name === 'block' ? { ...node.attrs, id: null } : node.attrs;
  return node.isText ? node : node.type.create(attrs, Fragment.from(children), node.marks);
}

export function createOps(variant: SchemaVariant): Ops {
  const textKindNode = (state: EditorState, kind: string): { type: NodeType; attrs: object } => {
    const nodes = state.schema.nodes;
    if (variant.bodies === 'kind') return { type: nodes.textBody, attrs: { kind } };
    return { type: nodes[kind] ?? nodes.paragraph, attrs: {} };
  };

  const childBlocksStart = (block: BlockInfo): number => {
    // In the ordered variant child blocks come after every body.
    let offset = 0;
    if (variant.content === 'ordered') {
      block.node.forEach((child, childOffset) => {
        if (isBody(child)) offset = childOffset + child.nodeSize;
      });
    }
    return block.pos + 1 + offset;
  };

  const ops: Ops = {
    variant,
    textBlocks(state) {
      const out: { block: BlockInfo; body: { node: PMNode; pos: number } }[] = [];
      for (const block of listBlocks(state.doc)) {
        const body = firstBody(block);
        if (body && body.node.isTextblock) out.push({ block, body });
      }
      return out;
    },
    newBlock(state, text, kind = 'paragraph') {
      const { type, attrs } = textKindNode(state, kind);
      const body = type.create(attrs, text ? state.schema.text(text) : null);
      return state.schema.nodes.block.create({ id: null }, body);
    },
    typeText(state, at, _offset, text) {
      return state.tr.insertText(text, at);
    },
    split(state, block, offset) {
      const body = firstBody(block);
      if (!body || !body.node.isTextblock) return null;
      const size = body.node.content.size;
      const tr = state.tr;
      const kind = body.node.type.name === 'heading' ? 'paragraph' : body.node.type.name;
      if (offset === 0 && size > 0) {
        // Enter at the start: an empty block above; this block keeps its id and text.
        return tr.insert(block.pos, ops.newBlock(state, '', kind));
      }
      const tail = body.node.content.cut(offset);
      const start = body.pos + 1;
      const fresh = state.schema.nodes.block.create(
        { id: null },
        body.node.type.create(
          variant.bodies === 'kind' ? { ...body.node.attrs, level: null } : null,
          tail,
        ),
      );
      // The new block goes after this block's subtree; children stay with the original.
      tr.insert(block.pos + block.node.nodeSize, fresh);
      if (offset < size) tr.delete(start + offset, start + size);
      return tr;
    },
    merge(state, block) {
      if (block.index === 0) return null;
      const parent = block.parentPos < 0 ? state.doc : state.doc.nodeAt(block.parentPos)!;
      const previousNode = parent.child(block.index - 1);
      if (previousNode.type.name !== 'block') return null;
      const previousPos = block.pos - previousNode.nodeSize;
      const previous: BlockInfo = {
        node: previousNode,
        pos: previousPos,
        parentPos: block.parentPos,
        index: block.index - 1,
        depth: block.depth,
        id: previousNode.attrs.id,
      };
      const into = firstBody(previous);
      const from = firstBody(block);
      if (!into || !from || !into.node.isTextblock || !from.node.isTextblock) return null;
      if ((into.node.type.spec.code ?? false) !== (from.node.type.spec.code ?? false)) return null;
      const rest: PMNode[] = [];
      block.node.forEach((child) => {
        if (child !== from.node) rest.push(child);
      });
      const tr = state.tr;
      // Right to left, so earlier positions stay valid.
      tr.delete(block.pos, block.pos + block.node.nodeSize);
      if (rest.length) tr.insert(previousPos + previousNode.nodeSize - 1, rest);
      if (from.node.content.size)
        tr.insert(into.pos + 1 + into.node.content.size, from.node.content);
      return tr;
    },
    move(state, block, targetPos) {
      const end = block.pos + block.node.nodeSize;
      if (targetPos >= block.pos && targetPos <= end) return null;
      const tr = state.tr;
      if (targetPos > end) {
        tr.insert(targetPos, block.node);
        tr.delete(block.pos, end);
      } else {
        tr.delete(block.pos, end);
        tr.insert(targetPos, block.node);
      }
      return tr;
    },
    indent(state, block) {
      if (block.index === 0) return null;
      const parent = block.parentPos < 0 ? state.doc : state.doc.nodeAt(block.parentPos)!;
      const previous = parent.child(block.index - 1);
      if (previous.type.name !== 'block') return null;
      const previousPos = block.pos - previous.nodeSize;
      return ops.move(state, block, previousPos + previous.nodeSize - 1);
    },
    outdent(state, block) {
      if (block.parentPos < 0) return null;
      const parent = state.doc.nodeAt(block.parentPos)!;
      return ops.move(state, block, block.parentPos + parent.nodeSize);
    },
    convert(state, block, kind) {
      const body = firstBody(block);
      if (!body || !body.node.isTextblock || body.node.type.spec.code) return null;
      if (variant.bodies === 'kind') {
        if (body.node.attrs.kind === kind) return null;
        return state.tr.setNodeMarkup(body.pos, undefined, {
          ...body.node.attrs,
          kind,
          level: kind === 'heading' ? 1 : null,
        });
      }
      if (body.node.type.name === kind) return null;
      const { type } = textKindNode(state, kind);
      return state.tr.setNodeMarkup(body.pos, type, { dir: body.node.attrs.dir });
    },
    insertBlocks(state, targetPos, blocks) {
      return state.tr.insert(targetPos, blocks);
    },
    duplicate(state, block) {
      return state.tr.insert(block.pos + block.node.nodeSize, withoutIds(block.node));
    },
    deleteBlock(state, block) {
      return state.tr.delete(block.pos, block.pos + block.node.nodeSize);
    },
    slots(state, exclude) {
      const slots: number[] = [];
      const inside = (pos: number) =>
        exclude !== undefined && pos >= exclude.pos && pos <= exclude.pos + exclude.node.nodeSize;
      // Top level: before every block, and at the end.
      let pos = 0;
      state.doc.forEach((child) => {
        slots.push(pos);
        pos += child.nodeSize;
      });
      slots.push(pos);
      for (const block of listBlocks(state.doc)) {
        let at = childBlocksStart(block);
        slots.push(at);
        block.node.forEach((child, offset) => {
          const childPos = block.pos + 1 + offset;
          if (child.type.name === 'block' && childPos >= at) {
            at = childPos + child.nodeSize;
            slots.push(at);
          }
        });
      }
      return [...new Set(slots)].filter((slot) => !inside(slot));
    },
  };
  return ops;
}

export const TEXT_KIND_NAMES: readonly string[] = TEXT_KINDS;
