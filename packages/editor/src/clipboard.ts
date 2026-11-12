// Copy, cut and paste (ARCHITECTURE.md, Clipboard). Copy writes our own format, HTML and
// Markdown as the plain text. Paste prefers our format, then HTML through the schema's parser
// (scripts, handlers and unknown attributes do not survive it), then Markdown, then plain text.
// Pasted blocks always get new ids; pasted files become image and file blocks.
import { Extension } from '@tiptap/core';
import { DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { looksLikeMarkdown, parseMarkdown, toMarkdown, type DocJSON } from '@cgw/doc';
import { insertFiles } from './actions';
import { withoutIds } from './blocks';
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
 * `leafText`), a page mention's title now.
 */
function leafText(host: () => EditorHost) {
  return (node: PMNode): string => {
    if (node.type.name === 'hardBreak') return '\n';
    if (node.type.name === 'pageMention')
      return host().pages?.title(String(node.attrs.pageId ?? '')) ?? '';
    return node.type.spec.leafText?.(node) ?? '';
  };
}

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
      ? toMarkdown(doc).trimEnd()
      : slice.content.textBetween(0, slice.content.size, '\n', leafText(host)),
  );
}

/** Every block in a pasted slice loses its id, so the id plugin mints new ones (D4). */
function freshIds(slice: Slice): Slice {
  const nodes: PMNode[] = [];
  slice.content.forEach((node) => nodes.push(withoutIds(node)));
  return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd);
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
          transformPasted: (slice) => freshIds(slice),
          clipboardTextSerializer: (slice, view) => {
            const doc = sliceAsDoc(slice, view.state.schema);
            return (doc.content?.length ?? 0) > 1
              ? toMarkdown(doc).trimEnd()
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
          handlePaste: (view, event) => {
            const data = event.clipboardData;
            if (!data || !view.editable) return false;
            const { schema } = view.state;
            const files = [...data.files];
            if (files.length && !data.getData('text/html')) {
              void insertFiles(editor, host(), files);
              return true;
            }
            const ours = data.getData(CLIPBOARD_TYPE);
            if (ours) {
              try {
                const parsed = JSON.parse(ours) as { format: string; slice: unknown };
                if (parsed.format === FORMAT) {
                  const slice = freshIds(
                    Slice.fromJSON(schema, parsed.slice as Parameters<typeof Slice.fromJSON>[1]),
                  );
                  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
                  return true;
                }
              } catch {
                // Not ours after all: fall through to HTML.
              }
            }
            if (data.getData('text/html')) return false; // ProseMirror parses it through the schema
            const text = data.getData('text/plain');
            if (!text || view.state.selection.$from.parent.type.spec.code) return false;
            if (!looksLikeMarkdown(text)) return false; // plain text: ProseMirror's own handling
            const doc = schema.nodeFromJSON(parseMarkdown(text));
            const slice = freshIds(new Slice(doc.content, 0, 0));
            // A single paragraph pastes as inline text into the current block.
            if (doc.childCount === 1 && doc.firstChild!.firstChild?.attrs.kind === 'paragraph') {
              view.dispatch(
                view.state.tr
                  .replaceSelection(new Slice(doc.firstChild!.firstChild!.content, 0, 0))
                  .scrollIntoView(),
              );
              return true;
            }
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
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
