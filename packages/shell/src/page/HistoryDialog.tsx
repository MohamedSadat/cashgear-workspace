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
import { useAccount, useCloud } from '../cloud/CloudUi';

interface ServerVersion {
  id: string;
  kind: string;
  name: string | null;
  status: string;
  createdAt: string;
}

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
  const cloud = useCloud();
  const account = useAccount(cloud);
  const workspace = session.current;
  const synced = !!cloud && !!account && workspace?.localOnly === false;
  const admin = workspace?.role === 'owner' || workspace?.role === 'admin';
  const [server, setServer] = useState<ServerVersion[] | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<{ id: string; json: DocJSON } | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });

  const load = useCallback(() => {
    void session.store.listHistory(doc.pageId).then(setEntries);
    if (synced)
      void cloud!.versions(doc.pageId).then(
        (list) =>
          setServer(
            list.map((v) => ({
              id: v.id,
              kind: v.kind,
              name: v.name ?? null,
              status: v.status,
              createdAt: v.createdAt,
            })),
          ),
        () => setServer([]),
      );
  }, [session, doc.pageId, synced, cloud]);
  useEffect(load, [load]);

  const previewServer = async (version: ServerVersion) => {
    const bytes = await cloud!.versionBytes(doc.pageId, version.id).catch(() => null);
    if (!bytes) return;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, bytes);
    setSelected({
      id: `server:${version.id}`,
      json: fragmentToJSON(ydoc.getXmlFragment('content')),
    });
    ydoc.destroy();
  };

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
    // The state before the restore is kept in the account too (SYNC_DESIGN.md, restore).
    if (synced) await cloud!.nameVersion(doc.pageId, null, 'preRestore').catch(() => undefined);
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
          {synced && (
            <>
              <div className="cgw-palette-group">{t('versions.server')}</div>
              {(server ?? []).map((version) => (
                <div
                  key={version.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={selected?.id === `server:${version.id}`}
                  className="cgw-history-item"
                  onClick={() => version.status === 'ready' && void previewServer(version)}
                  onKeyDown={(event) => {
                    if (
                      (event.key === 'Enter' || event.key === ' ') &&
                      version.status === 'ready'
                    ) {
                      event.preventDefault();
                      void previewServer(version);
                    }
                  }}
                >
                  {version.name ??
                    t(
                      version.kind === 'named'
                        ? 'versions.named'
                        : version.kind === 'preRestore'
                          ? 'versions.preRestore'
                          : 'versions.auto',
                    )}
                  {' · '}
                  {version.status === 'ready'
                    ? format.format(new Date(version.createdAt))
                    : t('versions.pending')}
                </div>
              ))}
              <div className="cgw-palette-group">{t('versions.local')}</div>
            </>
          )}
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
        {synced && (
          <>
            <input
              className="cgw-input"
              aria-label={t('versions.name')}
              placeholder={t('versions.namePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              className="cgw-button"
              disabled={!name.trim()}
              onClick={() =>
                void doc
                  .flush()
                  .then(() => cloud!.nameVersion(doc.pageId, name.trim()))
                  .then(() => {
                    setName('');
                    load();
                  })
              }
            >
              {t('versions.name')}
            </button>
          </>
        )}
        {synced && admin && selected?.id.startsWith('server:') && (
          <button
            type="button"
            className="cgw-button"
            title={t('versions.hardRestoreNote')}
            onClick={() => void cloud!.hardRestore(doc.pageId, selected.id.slice(7)).then(onClose)}
          >
            {t('versions.hardRestore')}
          </button>
        )}
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
