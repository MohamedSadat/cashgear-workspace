// The block editor over a given Y.Doc fragment. It is given the document and callbacks; it never
// saves, loads or calls the network (ARCHITECTURE.md, dependency rules).
import { Editor, type AnyExtension, type JSONContent } from '@tiptap/core';
import {
  BlockIds,
  isRemoteChange,
  newStats,
  schemaExtensions,
  yjsBinding,
  type BlockIdStats,
} from '@cgw/doc';
import type * as Y from 'yjs';
import { BlockSelection } from './blockSelection';
import { Clipboard } from './clipboard';
import { DateMentions, dateMentionView, type DateUi } from './dates';
import { BlockDecorations, StableTyping } from './decorations';
import { BlockHandle, type HandleUi } from './handle';
import type { EditorHost, OnHostChange } from './host';
import { MarkdownShortcuts } from './inputRules';
import { BlockKeymap } from './keymap';
import { Mentions, pageMentionView } from './mention';
import { SlashCommands, type SlashKeys } from './slash';
import { bookmarkView, childPageView, codeBlockView, fileView, imageView } from './nodeviews/atoms';
import { databaseViewView } from './nodeviews/database';
import { erpViewView } from './nodeviews/erp';
import { sheetEmbedView } from './nodeviews/sheet';
import { textBodyView } from './nodeviews/textBody';
import { Tables } from './tables';
import { TableOfContents, tableOfContentsView } from './toc';

export interface BlockEditorOptions {
  element: HTMLElement;
  /** The page's content. Absent with `readOnlyContent`: a newer document, shown and never bound. */
  fragment?: Y.XmlFragment;
  readOnlyContent?: JSONContent;
  host?: EditorHost;
  /** More behaviour (menus, handle, tables), added by later layers of this package. */
  extensions?: (host: () => EditorHost) => AnyExtension[];
  editable?: boolean;
  /** Runs the id repair after a remote change (tests pass their own scheduler). */
  schedule?: (task: () => void) => void;
  onInvalidContent?: (error: Error) => void;
  /** Accessible name for the editable area. */
  label?: string;
}

/** What the overlays (menus, toolbars, the date picker) hand to the editor's plugins. */
export interface EditorUi extends HandleUi, DateUi {
  slashKeys: SlashKeys | null;
  mentionKeys: SlashKeys | null;
}

export interface BlockEditor {
  editor: Editor;
  ui: EditorUi;
  stats: BlockIdStats;
  /** Content the binding or schema check refused. */
  contentErrors: Error[];
  /** The callbacks the editor was given, as they are now. */
  host(): EditorHost;
  setHost(host: EditorHost): void;
  destroy(): void;
}

export function createBlockEditor(options: BlockEditorOptions): BlockEditor {
  let host: EditorHost = options.host ?? {};
  const getHost = () => host;
  // Node views that draw from the host (a date in the interface language, a database view's,
  // workbook's or ERP view's frame) are told when it is replaced: nothing else would draw them.
  const hostListeners = new Set<() => void>();
  const onHostChange: OnHostChange = (listener) => {
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  };
  const stats = newStats();
  const contentErrors: Error[] = [];
  const bound = !!options.fragment && !options.readOnlyContent;
  const ui: EditorUi = {
    slashKeys: null,
    mentionKeys: null,
    openBlockMenu: null,
    openDatePicker: null,
  };

  const views: Record<string, (host: () => EditorHost) => ReturnType<typeof textBodyView>> = {
    textBody: textBodyView,
    codeBlock: codeBlockView,
    image: imageView,
    file: fileView,
    bookmark: bookmarkView,
    childPage: childPageView,
    tableOfContents: tableOfContentsView,
    databaseView: (h) => databaseViewView(h, onHostChange),
    sheetEmbed: (h) => sheetEmbedView(h, onHostChange),
    erpView: (h) => erpViewView(h, onHostChange),
    pageMention: pageMentionView,
    dateMention: (h) => dateMentionView(h, () => ui, onHostChange),
  };
  const schema = schemaExtensions().map((extension) => {
    const view = views[extension.name];
    return view ? extension.extend({ addNodeView: () => view(getHost) }) : extension;
  });

  const editor = new Editor({
    element: options.element,
    extensions: [
      ...schema,
      BlockIds.configure({
        isRemote: isRemoteChange,
        stats: () => stats,
        schedule: options.schedule ?? ((task) => queueMicrotask(task)),
        // The repair is written to Yjs in place when the editor is bound (ids.ts).
        fragment: () => (bound ? options.fragment! : null),
      }),
      ...(bound
        ? [
            yjsBinding({
              fragment: options.fragment!,
              onInvalidContent: (error) => {
                contentErrors.push(error);
                options.onInvalidContent?.(error);
              },
            }),
          ]
        : []),
      BlockKeymap.configure({ host: getHost, ui: () => ui }),
      BlockDecorations.configure({ host: getHost }),
      StableTyping,
      MarkdownShortcuts,
      SlashCommands.configure({ keys: () => ui.slashKeys }),
      Mentions.configure({ keys: () => ui.mentionKeys }),
      DateMentions.configure({ ui: () => ui }),
      BlockSelection,
      Tables,
      TableOfContents,
      Clipboard.configure({ host: getHost }),
      BlockHandle.configure({ host: getHost, ui: () => ui }),
      ...(options.extensions?.(getHost) ?? []),
    ],
    content: bound ? undefined : (options.readOnlyContent ?? null),
    editable: bound && (options.editable ?? true),
    injectCSS: false,
    enableInputRules: true,
    enablePasteRules: false,
    enableContentCheck: true,
    onContentError: ({ error, disableCollaboration }) => {
      contentErrors.push(error);
      // Never let an editor that cannot hold the document write to it (S2).
      disableCollaboration();
      editor.setEditable(false);
      options.onInvalidContent?.(error);
    },
    editorProps: {
      attributes: {
        class: 'cgw-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        ...(options.label ? { 'aria-label': options.label } : {}),
        spellcheck: 'true',
      },
    },
  });

  return {
    editor,
    ui,
    stats,
    contentErrors,
    host: getHost,
    setHost(next) {
      if (next === host) return;
      host = next;
      for (const listener of [...hostListeners]) listener();
    },
    destroy() {
      editor.destroy();
    },
  };
}
