// Local page history (M1.7): snapshots kept on a schedule (after 200 saved updates or 10 minutes
// of editing) and on request. A version is previewed read-only; restoring it is a forward edit,
// undoable, after the current state is kept as a version of its own.
import { fragmentToJSON, stopUndoCapturing, type DocJSON, type PageDocument } from '@cgw/doc';
import { BlockEditorView, type BlockEditor, type EditorHost } from '@cgw/editor';
import type { HistoryEntry } from '@cgw/workspace';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { Dialog } from '../Dialog';
import type { WorkspaceSession } from '../session';

export function HistoryDialog({
  session,
  doc,
  editor,
  host,
  onClose,
}: {
  session: WorkspaceSession;
  doc: PageDocument;
  editor: BlockEditor | null;
  host: EditorHost;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; json: DocJSON } | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });

  const load = useCallback(
    () => void session.store.listHistory(doc.pageId).then(setEntries),
    [session, doc.pageId],
  );
  useEffect(load, [load]);

  const preview = async (entry: HistoryEntry) => {
    const bytes = await session.store.getHistory(entry.id);
    if (!bytes) return;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, bytes);
    setSelected({ id: entry.id, json: fragmentToJSON(ydoc.getXmlFragment('content')) });
    ydoc.destroy();
  };

  const restore = async () => {
    if (!selected || !editor) return;
    await doc.flush();
    await doc.keepHistory();
    // A forward edit through the editor: it syncs like any edit and Ctrl+Z takes it back.
    stopUndoCapturing(editor.editor.state);
    editor.editor.commands.setContent(selected.json as never, { emitUpdate: true });
    stopUndoCapturing(editor.editor.state);
    await doc.flush();
    onClose();
  };

  return (
    <Dialog title={t('history.open')} onClose={onClose}>
      <div className="cgw-history">
        <div className="cgw-history-list" role="listbox" aria-label={t('history.versions')}>
          {entries === null ? (
            <p>{t('app.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="cgw-muted">{t('history.none')}</p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                role="option"
                tabIndex={0}
                aria-selected={selected?.id === entry.id}
                className="cgw-history-item"
                onClick={() => void preview(entry)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void preview(entry);
                  }
                }}
              >
                {format.format(new Date(entry.createdAt))}
              </div>
            ))
          )}
        </div>
        <div className="cgw-history-preview">
          {selected ? (
            <BlockEditorView
              key={selected.id}
              readOnlyContent={selected.json as never}
              host={host}
              label={t('history.preview')}
              className="cgw-history-editor"
            />
          ) : (
            <p className="cgw-muted">{t('history.pick')}</p>
          )}
        </div>
      </div>
      <div className="cgw-dialog-buttons">
        <button
          type="button"
          className="cgw-button"
          onClick={() => void doc.keepHistory().then(load)}
        >
          {t('history.keepNow')}
        </button>
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('frame.close')}
        </button>
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={!selected || doc.readOnly}
          onClick={() => void restore()}
        >
          {t('history.restore')}
        </button>
      </div>
      <p className="cgw-muted">{t('history.note')}</p>
    </Dialog>
  );
}
