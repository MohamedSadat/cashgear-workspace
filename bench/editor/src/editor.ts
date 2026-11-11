import { Editor, type AnyExtension } from '@tiptap/core';
import { createBlockEditor } from '@cgw/editor';
import type * as Y from 'yjs';
import { isRemoteChange, yjsExtension, type BindingKind } from './binding';
import { BlockIds, newStats, type BlockIdStats } from './ids';
import {
  isProductSchema,
  schemaExtensions,
  type SchemaAdditions,
  type SchemaVariant,
} from './schema';

export interface SpikeEditorOptions {
  doc: Y.Doc;
  binding: BindingKind;
  schema: SchemaVariant;
  element?: HTMLElement;
  /** S2: what a newer build adds to the schema. */
  additions?: SchemaAdditions;
  editable?: boolean;
  schedule?: (task: () => void) => void;
  /** More extensions, for the browser spikes (block handle). */
  extraExtensions?: AnyExtension[];
  /** Leave the id plugin out (S6: what a keystroke costs without it). */
  withoutIds?: boolean;
}

export interface SpikeEditor {
  editor: Editor;
  stats: BlockIdStats;
  /** Content the binding found the schema could not hold (Tiptap's content check). */
  contentErrors: Error[];
  fragment: Y.XmlFragment;
}

/** The Yjs document's shared types, as DATA_MODEL.md names them. */
export const CONTENT = 'content';
export const META = 'meta';

/**
 * The product's configuration (its schema, id plugin and binding) is the product's editor,
 * @cgw/editor, so the harnesses test what ships. The configurations S1 rejected, and S2's newer
 * builds, are assembled here from their parts.
 */
export function createSpikeEditor(options: SpikeEditorOptions): SpikeEditor {
  const fragment = options.doc.getXmlFragment(CONTENT);
  const element = options.element ?? document.createElement('div');
  if (
    options.binding === 'tiptap-ids' &&
    isProductSchema(options.schema) &&
    !options.additions &&
    !options.withoutIds
  ) {
    const product = createBlockEditor({
      element,
      fragment,
      editable: options.editable ?? true,
      schedule: options.schedule,
      extensions: options.extraExtensions ? () => options.extraExtensions! : undefined,
    });
    return {
      editor: product.editor,
      stats: product.stats,
      contentErrors: product.contentErrors,
      fragment,
    };
  }
  const stats = newStats();
  const contentErrors: Error[] = [];
  const editor = new Editor({
    element,
    extensions: [
      ...schemaExtensions(options.schema, options.additions),
      ...(options.withoutIds
        ? []
        : [
            BlockIds.configure({
              isRemote: (tr) => isRemoteChange(options.binding, tr),
              stats: () => stats,
              schedule: options.schedule ?? ((task) => queueMicrotask(task)),
            }),
          ]),
      yjsExtension(options.binding, fragment, (error) => contentErrors.push(error)),
      ...(options.extraExtensions ?? []),
    ],
    enableInputRules: false,
    enablePasteRules: false,
    injectCSS: false,
    editable: options.editable ?? true,
    enableContentCheck: options.binding !== 'upstream',
    onContentError: ({ error }) => contentErrors.push(error),
  });
  return { editor, stats, contentErrors, fragment };
}
