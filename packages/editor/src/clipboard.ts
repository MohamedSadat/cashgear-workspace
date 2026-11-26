// Copy, cut and paste (ARCHITECTURE.md, Clipboard). Copy writes our own format, HTML and
// Markdown as the plain text. Paste prefers our format, then HTML through the schema's parser
// (scripts, handlers and unknown attributes do not survive it), then Markdown, then plain text.
// Pasted blocks always get new ids; whole blocks go beside the caret's block, never inside it
// (`pasteBlocks`); pasted files become image and file blocks.
import { Extension } from '@tiptap/core';
import { DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  looksLikeMarkdown,
  parseMarkdown,
  toMarkdown,
  type DocJSON,
  type TextContext,
} from '@cgw/doc';
import { insertFiles } from './actions';
import { isBlock, isBody, pasteBlocks, withoutIds } from './blocks';
import { blockSelectionKey, blockSelectionSlice } from './blockSelection';
import type { EditorHost } from './host';

export const CLIPBOARD_TYPE = 'application/x-cgw-slice+json';
const FORMAT = 'cgw-slice';

/** The slice as a document, for Markdown: loose text goes into a paragraph. */
function sliceAsDoc(slice: Slice, schema: Schema): DocJSON {
  const blocks: DocJSON[] = [];
  let loose: PMNode[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    blocks.push(
      schema.nodes.block
        .create(null, schema.nodes.textBody.create(null, loose))
        .toJSON() as DocJSON,
    );
    loose = [];
  };
  slice.content.forEach((node) => {
    if (node.type.name === 'block') {
      flushLoose();
      blocks.push(node.toJSON() as DocJSON);
    } else if (node.type.spec.group === 'body') {
      flushLoose();
      blocks.push(schema.nodes.block.create(null, node).toJSON() as DocJSON);
    } else if (node.isInline) loose.push(node);
    else if (node.isTextblock) node.forEach((child) => loose.push(child));
  });
  flushLoose();
  return { type: 'doc', content: blocks };
}

/**
 * The text of an inline leaf in copied plain text: a line break, a date as stored (its
 * `leafText`), a page mention's title now, a person's mention as `@` and their name now.
 */
function leafText(host: () => EditorHost) {
  return (node: PMNode): string => {
    if (node.type.name === 'hardBreak') return '\n';
    if (node.type.name === 'pageMention')
      return host().pages?.title(String(node.attrs.pageId ?? '')) ?? '';
    if (node.type.name === 'userMention') {
      const id = node.attrs.userId as string | null;
      return `@${(id && host().people?.name(id)) || ''}`;
    }
    return node.type.spec.leafText?.(node) ?? '';
  };
}

/** Copied Markdown names the people mentioned, as the host has them now. */
const markdownContext = (host: () => EditorHost): TextContext => ({
  userName: (userId) => host().people?.name(userId),
});

function writeClipboard(
  view: EditorView,
  event: ClipboardEvent,
  slice: Slice,
  host: () => EditorHost,
) {
  const data = event.clipboardData!;
  const { schema } = view.state;
  const json = { format: FORMAT, version: 1, slice: slice.toJSON() };
  const holder = document.createElement('div');
  holder.append(DOMSerializer.fromSchema(schema).serializeFragment(slice.content));
  data.clearData();
  data.setData(CLIPBOARD_TYPE, JSON.stringify(json));
  data.setData('text/html', holder.innerHTML);
  const doc = sliceAsDoc(slice, schema);
  const blocks = doc.content?.length ?? 0;
  data.setData(
    'text/plain',
    blocks > 1
      ? toMarkdown(doc, markdownContext(host)).trimEnd()
      : slice.content.textBetween(0, slice.content.size, '\n', leafText(host)),
  );
}

/**
 * Every block in a pasted slice loses its id, so the id plugin mints new ones (D4). Bodies at the
 * slice's top (lines of plain text, bare paragraphs of HTML, as ProseMirror reads them beside the
 * caret's body) each go in a block of their own, one level more open: a block holds one body, and
 * a body placed as it was became a second body of the caret's block.
 */
function freshIds(slice: Slice, schema: Schema): Slice {
  const nodes: PMNode[] = [];
  slice.content.forEach((node) =>
    nodes.push(withoutIds(isBody(node) ? schema.nodes.block.create(null, node) : node)),
  );
  const wrapped = (node: PMNode | null, open: number) =>
    node && isBody(node) && open > 0 ? open + 1 : open;
  return new Slice(
    Fragment.from(nodes),
    wrapped(slice.content.firstChild, slice.openStart),
    wrapped(slice.content.lastChild, slice.openEnd),
  );
}

/**
 * A slice of whole blocks (blocks selected and copied, Markdown, HTML starting with a picture):
 * blocks whose first is not open into its text, so nothing of it joins the caret's text.
 */
function wholeBlocks(slice: Slice): Fragment | null {
  if (slice.openStart > 1 || !slice.content.childCount) return null;
  let blocks = true;
  slice.content.forEach((node) => {
    if (!isBlock(node)) blocks = false;
  });
  return blocks ? slice.content : null;
}

/**
 * Puts a pasted slice in: whole blocks beside the caret's block (`pasteBlocks`), never inside it;
 * anything else by ProseMirror's own replace, which joins its open ends to the text at the caret.
 */
function pasteSlice(view: EditorView, slice: Slice, host: () => EditorHost) {
  const blocks = wholeBlocks(slice);
  const tr = blocks
    ? pasteBlocks(view.state, blocks, (id) => host().toggles?.isOpen(id) ?? true)
    : view.state.tr.replaceSelection(slice);
  if (tr) view.dispatch(tr.scrollIntoView());
}

export const Clipboard = Extension.create<{ host: () => EditorHost }>({
  name: 'cgwClipboard',
  addOptions: () => ({ host: () => ({}) }),
  addProseMirrorPlugins() {
    const host = this.options.host;
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('cgwClipboard'),
        props: {
          transformPasted: (slice, view) => freshIds(slice, view.state.schema),
          clipboardTextSerializer: (slice, view) => {
            const doc = sliceAsDoc(slice, view.state.schema);
            return (doc.content?.length ?? 0) > 1
              ? toMarkdown(doc, markdownContext(host)).trimEnd()
              : slice.content.textBetween(0, slice.content.size, '\n', leafText(host));
          },
          handleDOMEvents: {
            copy: (view, event) => {
              const slice =
                blockSelectionSlice(view.state) ??
                (view.state.selection.empty ? null : view.state.selection.content());
              if (!slice || !event.clipboardData) return false;
              writeClipboard(view, event, slice, host);
              event.preventDefault();
              return true;
            },
            cut: (view, event) => {
              const slice =
                blockSelectionSlice(view.state) ??
                (view.state.selection.empty ? null : view.state.selection.content());
              if (!slice || !event.clipboardData || !view.editable) return false;
              writeClipboard(view, event, slice, host);
              event.preventDefault();
              const blockSel = blockSelectionKey.getState(view.state);
              if (blockSel) {
                const from = Math.min(blockSel.anchor, blockSel.head);
                const toNode = view.state.doc.nodeAt(Math.max(blockSel.anchor, blockSel.head))!;
                view.dispatch(
                  view.state.tr
                    .delete(from, Math.max(blockSel.anchor, blockSel.head) + toNode.nodeSize)
                    .setMeta(blockSelectionKey, 'clear'),
                );
              } else view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
              return true;
            },
          },
          handlePaste: (view, event, pasted) => {
            const data = event.clipboardData;
            if (!data || !view.editable) return false;
            const { schema } = view.state;
            const files = [...data.files];
            if (files.length && !data.getData('text/html')) {
              void insertFiles(editor, host(), files);
              return true;
            }
            // In code, what was copied goes in as its text (ProseMirror reads it so).
            const inCode = !!view.state.selection.$from.parent.type.spec.code;
            const ours = inCode ? '' : data.getData(CLIPBOARD_TYPE);
            if (ours) {
              let slice: Slice | null = null;
              try {
                const parsed = JSON.parse(ours) as { format: string; slice: unknown };
                if (parsed.format === FORMAT)
                  slice = freshIds(
                    Slice.fromJSON(schema, parsed.slice as Parameters<typeof Slice.fromJSON>[1]),
                    schema,
                  );
              } catch {
                // Not ours after all: fall through to HTML.
              }
              if (slice) {
                pasteSlice(view, slice, host);
                return true;
              }
            }
            // HTML: ProseMirror has parsed it through the schema into `pasted`.
            if (data.getData('text/html')) {
              if (inCode || !wholeBlocks(pasted)) return false;
              pasteSlice(view, pasted, host);
              return true;
            }
            const text = data.getData('text/plain');
            if (!text || inCode) return false;
            if (!looksLikeMarkdown(text)) return false; // plain text: ProseMirror's own handling
            const doc = schema.nodeFromJSON(parseMarkdown(text));
            // A single paragraph pastes as inline text into the current block.
            if (doc.childCount === 1 && doc.firstChild!.firstChild?.attrs.kind === 'paragraph') {
              view.dispatch(
                view.state.tr
                  .replaceSelection(new Slice(doc.firstChild!.firstChild!.content, 0, 0))
                  .scrollIntoView(),
              );
              return true;
            }
            pasteSlice(view, freshIds(new Slice(doc.content, 0, 0), schema), host);
            return true;
          },
          handleDrop: (view, event) => {
            const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
            if (!files.length || !view.editable) return false;
            event.preventDefault();
            const at = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            });
            void insertFiles(editor, host(), files, 'auto', at?.pos);
            return true;
          },
        },
      }),
    ];
  },
});
