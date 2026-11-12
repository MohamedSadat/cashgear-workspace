// What the slash menu, the block menu and the palette can do to a block. The shell registers each
// one as a command with labels from its catalogues; the editor only knows how to apply it.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { newBlockId, type TextKind } from '@cgw/doc';
import { blockAt, currentBlock, firstBody, turnInto, type BlockInfo } from './blocks';
import type { DatabaseRef, EditorHost } from './host';
import { mentionKey } from './mention';

export type BlockActionName =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'todo'
  | 'toggle'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider'
  | 'table'
  | 'image'
  | 'file'
  | 'bookmark'
  | 'childPage'
  | 'pageLink'
  | 'tableOfContents'
  | 'database'
  | 'linkedView';

export interface BlockAction {
  name: BlockActionName;
  /** A glyph for the menu until Track U8's block icons land in CgIcon. */
  glyph: string;
  /** Text kinds and code can be a "turn into" target; the rest only insert. */
  turnInto: boolean;
  /** Whether the host gives what the action needs (absent: always); the shell's `when` reads it. */
  available?(host: EditorHost): boolean;
  apply(editor: Editor, host: EditorHost): void | Promise<void>;
}

const textKind =
  (kind: TextKind, attrs: Record<string, unknown> = {}) =>
  (editor: Editor) =>
    setKind(editor, kind, attrs);

/** Turns the current block into a text kind, keeping its id, text and children. */
export function setKind(editor: Editor, kind: TextKind, attrs: Record<string, unknown> = {}) {
  const block = currentBlock(editor.state);
  if (!block) return;
  const tr = turnInto(editor.state, block, { kind, attrs });
  if (tr) editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
}

const isEmptyParagraph = (body: { node: PMNode } | null) =>
  !!body &&
  body.node.type.name === 'textBody' &&
  body.node.attrs.kind === 'paragraph' &&
  body.node.content.size === 0;

/**
 * Puts a body in the document: in place of the current block's body when that is an empty
 * paragraph (the block keeps its id), else in a new block after the current one. Atoms get an
 * empty paragraph after them when nothing follows, so typing can go on.
 */
export function insertBody(
  editor: Editor,
  body: PMNode,
  select: 'inside' | 'node' | 'after' = 'inside',
) {
  const { state } = editor;
  const { schema } = state;
  const block = currentBlock(state);
  const tr = state.tr;
  let bodyPos: number;
  let blockInfo: { pos: number; size: number };
  const current = block && firstBody(block);
  if (block && current && isEmptyParagraph(current)) {
    tr.replaceWith(current.pos, current.pos + current.node.nodeSize, body);
    bodyPos = current.pos;
    blockInfo = { pos: block.pos, size: tr.doc.nodeAt(block.pos)!.nodeSize };
  } else {
    const at = block ? block.pos + block.node.nodeSize : state.doc.content.size;
    const fresh = schema.nodes.block.create({ id: newBlockId() }, body);
    tr.insert(at, fresh);
    bodyPos = at + 1;
    blockInfo = { pos: at, size: fresh.nodeSize };
  }
  const after = blockInfo.pos + blockInfo.size;
  if (body.isAtom || select === 'after') {
    const next = tr.doc.resolve(Math.min(after, tr.doc.content.size)).nodeAfter;
    if (!next)
      tr.insert(
        after,
        schema.nodes.block.create({ id: newBlockId() }, schema.nodes.textBody.create()),
      );
  }
  if (select === 'node' && body.isAtom) tr.setSelection(NodeSelection.create(tr.doc, bodyPos));
  else if (select === 'after' || body.isAtom)
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 2)));
  else tr.setSelection(TextSelection.near(tr.doc.resolve(bodyPos + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
}

function emptyTable(editor: Editor, rows = 3, cols = 3): PMNode {
  const { table, tableRow, tableCell } = editor.schema.nodes;
  const row = () =>
    tableRow.create(
      null,
      Array.from({ length: cols }, () => tableCell.create()),
    );
  return table.create({ headerRow: true }, Array.from({ length: rows }, row));
}

export const BLOCK_ACTIONS: readonly BlockAction[] = [
  { name: 'paragraph', glyph: '¶', turnInto: true, apply: textKind('paragraph') },
  { name: 'heading1', glyph: 'H1', turnInto: true, apply: textKind('heading', { level: 1 }) },
  { name: 'heading2', glyph: 'H2', turnInto: true, apply: textKind('heading', { level: 2 }) },
  { name: 'heading3', glyph: 'H3', turnInto: true, apply: textKind('heading', { level: 3 }) },
  { name: 'bulletList', glyph: '•', turnInto: true, apply: textKind('bulletItem') },
  { name: 'numberedList', glyph: '1.', turnInto: true, apply: textKind('numberedItem') },
  { name: 'todo', glyph: '☐', turnInto: true, apply: textKind('checkItem') },
  { name: 'toggle', glyph: '▸', turnInto: true, apply: textKind('toggle') },
  { name: 'quote', glyph: '❝', turnInto: true, apply: textKind('quote') },
  {
    name: 'callout',
    glyph: '💡',
    turnInto: true,
    apply: textKind('callout', { icon: '💡', tone: 'info' }),
  },
  {
    name: 'code',
    glyph: '</>',
    turnInto: true,
    apply: (editor) => {
      const block = currentBlock(editor.state);
      const body = block && firstBody(block);
      if (block && body && body.node.type.name === 'textBody' && body.node.content.size > 0) {
        const tr = turnInto(editor.state, block, 'codeBlock');
        if (tr) editor.view.dispatch(tr);
        return;
      }
      insertBody(editor, editor.schema.nodes.codeBlock.create());
    },
  },
  {
    name: 'divider',
    glyph: '—',
    turnInto: false,
    apply: (editor) => insertBody(editor, editor.schema.nodes.divider.create(), 'after'),
  },
  {
    name: 'table',
    glyph: '▦',
    turnInto: false,
    apply: (editor) => insertBody(editor, emptyTable(editor)),
  },
  {
    name: 'image',
    glyph: '🖼',
    turnInto: false,
    apply: async (editor, host) => {
      const files =
        (await host.assets?.pick(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])) ?? [];
      await insertFiles(editor, host, files);
    },
  },
  {
    name: 'file',
    glyph: '📎',
    turnInto: false,
    apply: async (editor, host) => {
      const files = (await host.assets?.pick([])) ?? [];
      await insertFiles(editor, host, files, 'file');
    },
  },
  {
    name: 'bookmark',
    glyph: '🔖',
    turnInto: false,
    apply: (editor) =>
      insertBody(editor, editor.schema.nodes.bookmark.create({ url: null }), 'node'),
  },
  {
    name: 'childPage',
    glyph: '📄',
    turnInto: false,
    apply: async (editor, host) => {
      const pageId = await host.pages?.create();
      if (pageId) insertBody(editor, editor.schema.nodes.childPage.create({ pageId }), 'node');
    },
  },
  {
    name: 'pageLink',
    glyph: '↗',
    turnInto: false,
    apply: (editor) => {
      // Opens the page picker at the caret (mention.ts).
      const { from, to } = editor.state.selection;
      editor.view.dispatch(
        editor.state.tr
          .insertText('@', from, to)
          .setMeta(mentionKey, { active: true, from, query: '' }),
      );
      editor.commands.focus();
    },
  },
  {
    // Schema version 2: the page's headings, as links (toc.ts).
    name: 'tableOfContents',
    glyph: '☰',
    turnInto: false,
    apply: (editor) => insertBody(editor, editor.schema.nodes.tableOfContents.create(), 'after'),
  },
  {
    // Schema version 3: a new inline database under this page, made by the host with its first
    // view, then shown here (nodeviews/database.ts).
    name: 'database',
    glyph: '▤',
    turnInto: false,
    available: (host) => !!host.databases?.create,
    apply: async (editor, host) => {
      const made = await host.databases?.create?.();
      if (made && !editor.isDestroyed) insertDatabaseView(editor, made);
    },
  },
  {
    // Schema version 3: another view of a database that exists, picked by the host.
    name: 'linkedView',
    glyph: '⧉',
    turnInto: false,
    available: (host) => !!host.databases?.pick,
    apply: async (editor, host) => {
      const picked = await host.databases?.pick?.();
      if (picked && !editor.isDestroyed) insertDatabaseView(editor, picked);
    },
  },
];

/** Puts a database view in the document as a block of its own, the caret after it. */
export function insertDatabaseView(editor: Editor, ref: DatabaseRef) {
  insertBody(
    editor,
    editor.schema.nodes.databaseView.create({
      databaseId: ref.databaseId,
      viewId: ref.viewId ?? null,
    }),
    'after',
  );
}

export const actionByName = (name: string) => BLOCK_ACTIONS.find((a) => a.name === name);

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

/** Stores files through the host and inserts an image or file block for each. */
export async function insertFiles(
  editor: Editor,
  host: EditorHost,
  files: File[],
  as: 'auto' | 'file' = 'auto',
  at?: number,
) {
  if (!host.assets) return;
  if (at !== undefined) {
    const $at = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
    const block = blockAt($at);
    if (block) editor.commands.setTextSelection(firstBody(block)!.pos + 1);
  }
  for (const file of files) {
    const stored = await host.assets.store(file);
    if (!stored) continue;
    const { schema } = editor;
    const node =
      as === 'auto' && IMAGE.test(file.type)
        ? schema.nodes.image.create({
            assetId: stored.assetId,
            width: stored.width ? Math.min(stored.width, 720) : null,
          })
        : schema.nodes.file.create({ assetId: stored.assetId });
    insertBody(editor, node, 'after');
  }
}

/** The block menu's moves on one block, for the mobile toolbar and the handle. */
export function blockOf(editor: Editor, pos: number): BlockInfo | null {
  return blockAt(editor.state.doc.resolve(pos));
}
