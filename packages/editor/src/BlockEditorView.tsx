import type { JSONContent } from '@tiptap/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';
import { createBlockEditor, type BlockEditor } from './editor';
import type { EditorHost } from './host';

export interface BlockEditorViewProps {
  /** The page's content, or for a document newer than this build, JSON to show read-only. */
  fragment?: Y.XmlFragment;
  readOnlyContent?: JSONContent;
  host: EditorHost;
  label: string;
  /** Called once the editor exists, and with null when it is destroyed. */
  onEditor?: (editor: BlockEditor | null) => void;
  /** Menus and toolbars drawn over the editor (later milestones). */
  overlays?: (editor: BlockEditor) => ReactNode;
  extensions?: Parameters<typeof createBlockEditor>[0]['extensions'];
  className?: string;
}

/**
 * Mounts the editor once per document. React draws only the overlays; the editor's own DOM is
 * never re-rendered by React, so typing does not go through it (ARCHITECTURE.md, Performance).
 */
export function BlockEditorView({
  fragment,
  readOnlyContent,
  host,
  label,
  onEditor,
  overlays,
  extensions,
  className,
}: BlockEditorViewProps) {
  const element = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<BlockEditor | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;

  useEffect(() => {
    if (!element.current) return;
    const created = createBlockEditor({
      element: element.current,
      fragment,
      readOnlyContent,
      host: hostRef.current,
      label,
      extensions,
    });
    setEditor(created);
    onEditorRef.current?.(created);
    return () => {
      onEditorRef.current?.(null);
      created.destroy();
      setEditor(null);
    };
    // A new editor only for a new document; the host and callbacks are read through refs.
  }, [fragment, readOnlyContent]);

  useEffect(() => {
    editor?.setHost(host);
  }, [editor, host]);

  return (
    <div className={className ?? 'cgw-editor-frame'}>
      <div ref={element} />
      {editor && overlays?.(editor)}
    </div>
  );
}
