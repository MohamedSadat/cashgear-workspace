// Spike S2: the schema-version gate (D7). A build older than the document never binds the
// editor to it: it shows a read-only copy built from the content's JSON, so it cannot write.
import { Editor, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { CONTENT, META } from './editor';
import { schemaExtensions, type SchemaVariant } from './schema';

export const documentVersion = (doc: Y.Doc): number =>
  (doc.getMap(META).get('schemaVersion') as number | undefined) ?? 1;

export function stampVersion(doc: Y.Doc, version: number): void {
  doc.getMap(META).set('schemaVersion', version);
}

export type OpenMode = 'edit' | 'readOnly';

export const openMode = (doc: Y.Doc, buildVersion: number): OpenMode =>
  documentVersion(doc) > buildVersion ? 'readOnly' : 'edit';

export const PLACEHOLDER = 'This block needs a newer version of Cash Gear Workspace.';

/** The document as JSON this schema can draw: unknown nodes become placeholders. */
export function readableJSON(fragment: Y.XmlFragment, schema: Schema): JSONContent {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type && !schema.nodes[node.type])
      return { type: 'paragraph', content: [{ type: 'text', text: PLACEHOLDER }] };
    const marks = node.marks?.filter((mark) => schema.marks[mark.type]);
    return { ...node, marks, content: node.content?.map(visit) };
  };
  return visit(yXmlFragmentToProsemirrorJSON(fragment) as JSONContent);
}

/** Opens a document too new for this build: not editable, and not connected to the Yjs doc. */
export function openReadOnly(doc: Y.Doc, variant: SchemaVariant): Editor {
  const element = document.createElement('div');
  const probe = new Editor({ element, extensions: schemaExtensions(variant), injectCSS: false });
  const content = readableJSON(doc.getXmlFragment(CONTENT), probe.schema);
  probe.destroy();
  return new Editor({
    element,
    extensions: schemaExtensions(variant),
    content,
    editable: false,
    injectCSS: false,
  });
}
