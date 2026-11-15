// What AI needs of the editor (Phase 7; INTEGRATIONS.md, AI, Proposals): the selection's text,
// and an accepted proposal put into the page as an ordinary edit by the person, one transaction,
// undoable and in history. The editor never calls the network for it: the shell asks the API and
// hands the answer here only when the person accepts it.
import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { newBlockId, parseMarkdown, type DocJSON } from '@cgw/doc';
import { blockAt, isBlock } from './blocks';
import type { EditorHost } from './host';

/** A selection as AI is asked about it: its range when asked, and its plain text. */
export interface AiSelectionRange {
  from: number;
  to: number;
  text: string;
}

/** A leaf's text in a selection: a line break, a page's title, `@` and a person's name now. */
function leafText(host: EditorHost | undefined) {
  return (node: PMNode): string => {
    if (node.type.name === 'hardBreak') return '\n';
    if (node.type.name === 'pageMention')
      return host?.pages?.title(String(node.attrs.pageId ?? '')) ?? '';
    if (node.type.name === 'userMention') {
      const id = node.attrs.userId as string | null;
      return `@${(id && host?.people?.name(id)) || ''}`;
    }
    return node.type.spec.leafText?.(node) ?? '';
  };
}

/** The text between two positions, as AI is given it. */
export function textOfRange(editor: Editor, from: number, to: number, host?: EditorHost): string {
  const size = editor.state.doc.content.size;
  return editor.state.doc.textBetween(
    Math.max(0, Math.min(from, size)),
    Math.max(0, Math.min(to, size)),
    '\n',
    leafText(host),
  );
}

/** The selection with its text, or null when nothing (or only white space) is selected. */
export function selectionForAi(editor: Editor, host?: EditorHost): AiSelectionRange | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = textOfRange(editor, from, to, host);
  return text.trim() ? { from, to, text } : null;
}

/** Where an accepted proposal goes. */
export type AiPlace =
  /** In place of what was selected, if it still reads the same; else after its block. */
  | { kind: 'replace'; from: number; to: number; expect: string }
  /** As blocks after the block holding `pos`. */
  | { kind: 'after'; pos: number }
  /** As blocks at the top of the page. */
  | { kind: 'top' }
  /** As blocks at the end of the page. */
  | { kind: 'end' };

export type AiInsertResult = 'replaced' | 'inserted' | 'refused';

/**
 * A node with a fresh id on every block in it, minted here in the person's own edit (D4). Left to
 * the id plugin, the ids would come in an appended transaction that is kept out of history, and
 * the binding would write the whole change out of history with it: Undo would not take it back.
 */
function withFreshIds(node: PMNode): PMNode {
  if (node.isText || (!isBlock(node) && !node.childCount)) return node;
  const children: PMNode[] = [];
  node.forEach((child) => children.push(withFreshIds(child)));
  const attrs = isBlock(node) ? { ...node.attrs, id: newBlockId() } : node.attrs;
  return node.type.create(attrs, Fragment.from(children), node.marks);
}

/** Blocks from Markdown, or from blocks given as JSON, each with a fresh id. */
function blocksOf(editor: Editor, content: string | DocJSON[]): PMNode[] {
  const json: DocJSON =
    typeof content === 'string' ? parseMarkdown(content) : { type: 'doc', content };
  const doc = editor.schema.nodeFromJSON(json);
  const out: PMNode[] = [];
  doc.forEach((node) => out.push(withFreshIds(node)));
  return out;
}

/** Where blocks go after the block holding `pos` (the end of the page when there is none). */
function afterBlock(doc: PMNode, pos: number): number {
  const block = blockAt(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))));
  return block ? block.pos + block.node.nodeSize : doc.content.size;
}

/**
 * Puts Markdown (or blocks) into the page at `place`, as one ordinary edit. A replacement whose
 * range no longer reads `expect` (someone changed it meanwhile) goes after its block instead, so
 * nothing anyone typed is overwritten. `refused` when the editor is not editable or there is
 * nothing to put in.
 */
export function insertAiContent(
  editor: Editor,
  place: AiPlace,
  content: string | DocJSON[],
  host?: EditorHost,
): AiInsertResult {
  if (!editor.isEditable || editor.isDestroyed) return 'refused';
  const blocks = blocksOf(editor, content);
  if (!blocks.length) return 'refused';
  const { state } = editor;
  const tr = state.tr;
  let result: AiInsertResult = 'inserted';
  if (place.kind === 'replace') {
    const size = state.doc.content.size;
    const from = Math.min(place.from, size);
    const to = Math.min(place.to, size);
    const same = from < to && textOfRange(editor, from, to, host) === place.expect;
    if (same) {
      tr.setSelection(TextSelection.create(tr.doc, from, to));
      const single =
        blocks.length === 1 &&
        blocks[0].childCount === 1 &&
        blocks[0].firstChild!.type.name === 'textBody' &&
        blocks[0].firstChild!.attrs.kind === 'paragraph';
      // One paragraph goes in as text, as a paste does; more as blocks.
      tr.replaceSelection(
        single
          ? new Slice(blocks[0].firstChild!.content, 0, 0)
          : new Slice(Fragment.from(blocks), 0, 0),
      );
      result = 'replaced';
    } else tr.insert(afterBlock(tr.doc, to), Fragment.from(blocks));
  } else if (place.kind === 'after')
    tr.insert(afterBlock(tr.doc, place.pos), Fragment.from(blocks));
  else if (place.kind === 'top') tr.insert(0, Fragment.from(blocks));
  else tr.insert(tr.doc.content.size, Fragment.from(blocks));
  editor.view.dispatch(tr.scrollIntoView());
  return result;
}

/** The ids of the page's top-level blocks, in order (for tests and for placing after a block). */
export function topBlockIds(editor: Editor): (string | null)[] {
  const ids: (string | null)[] = [];
  editor.state.doc.forEach((node) => {
    if (isBlock(node)) ids.push(node.attrs.id as string | null);
  });
  return ids;
}
