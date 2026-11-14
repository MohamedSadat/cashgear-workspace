// `#/workbooks`: the open workspace's workbooks the person may read (the server's list, which
// checks each one), found by name; each opens in Cash Gear Sheet, and may be renamed, moved to the
// trash and restored, and given its own access list by the pages' rules (WorkbookPermissions).
// Workbooks are not in the change feed: the list is read by route, online, and read again after
// each change. The server decides every action; a refused one says so.
import { normaliseText, searchTerms, type Id } from '@cgw/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import { useShell } from '../context';
import { Dialog } from '../Dialog';
import type { WorkspaceSession } from '../session';
import { canEditWorkbook, failureCode, workbookApi, type Workbook } from './api';
import { openInSheet } from './launch';
import { requestNewWorkbook } from './requests';
import { useUnavailable } from './WorkbookPicker';
import { WorkbookPermissions } from './WorkbookPermissions';
import './sheet.css';

const accessKey = (access: string) =>
  access === 'full'
    ? 'share.levelFull'
    : access === 'edit'
      ? 'share.levelEdit'
      : access === 'comment'
        ? 'share.levelComment'
        : 'share.levelView';

export function WorkbooksView({
  session,
  cloud,
}: {
  session: WorkspaceSession;
  cloud: Cloud | null;
}) {
  const { t, i18n } = useTranslation();
  const { platform } = useShell();
  const unavailable = useUnavailable(session, cloud);
  const api = useMemo(() => (cloud ? workbookApi(cloud.api) : null), [cloud]);
  const workspaceId = session.workspaceId;
  const [trash, setTrash] = useState(false);
  const [list, setList] = useState<Workbook[] | null>(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [renaming, setRenaming] = useState<Workbook | null>(null);
  const [sharing, setSharing] = useState<Workbook | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    if (!api || !workspaceId || unavailable) return;
    let live = true;
    setList(null);
    api.list(workspaceId, { trashed: trash }).then(
      (found) => live && setList(found),
      (error: unknown) => {
        if (!live) return;
        setList([]);
        setMessage({
          text: failureCode(error) === 'offline' ? t('sheets.offlineNone') : t('sheets.listFailed'),
          alert: true,
        });
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, unavailable, trash, revision, t]);

  const terms = searchTerms(normaliseText(query));
  const shown = (list ?? []).filter((w) => {
    if (!terms.length) return true;
    const words = normaliseText(w.name).split(' ');
    return terms.every((term) => words.some((word) => word.startsWith(term)));
  });
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const act = async (run: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await run();
      setMessage({ text: done, alert: false });
      reload();
    } catch (error) {
      const code = failureCode(error);
      setMessage({
        text:
          code === 'offline'
            ? t('sheets.offlineNone')
            : code === 'access.denied'
              ? t('sheets.refused')
              : code === 'version.conflict'
                ? t('errors.conflict')
                : t('errors.generic'),
        alert: true,
      });
    }
  };

  return (
    <section className="cgw-workbooks" aria-labelledby="cgw-workbooks-title">
      <h1 id="cgw-workbooks-title">{t('sheets.screenTitle')}</h1>
      <p className="cgw-workbooks-muted">{t('sheets.screenNote')}</p>
      {unavailable ? (
        <p role="status" className="cgw-workbooks-muted" data-testid="workbooks-unavailable">
          {t(
            unavailable === 'local'
              ? 'sheets.local'
              : unavailable === 'signedOut'
                ? 'sheets.signIn'
                : 'sheets.offlineNone',
          )}
        </p>
      ) : (
        <>
          <div className="cgw-workbooks-bar">
            <input
              className="cgw-input"
              type="search"
              dir="auto"
              aria-label={t('sheets.screenSearch')}
              placeholder={t('sheets.screenSearch')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div role="group" aria-label={t('sheets.screenShow')} className="cgw-workbooks-bar">
              <button
                type="button"
                className={`cgw-button${trash ? '' : ' is-primary'}`}
                aria-pressed={!trash}
                onClick={() => setTrash(false)}
              >
                {t('sheets.screenLive')}
              </button>
              <button
                type="button"
                className={`cgw-button${trash ? ' is-primary' : ''}`}
                aria-pressed={trash}
                onClick={() => setTrash(true)}
              >
                {t('sheets.screenTrash')}
              </button>
            </div>
            {!trash && session.current?.role !== 'guest' ? (
              <button
                type="button"
                className="cgw-button"
                onClick={() => void requestNewWorkbook().then((made) => made && reload())}
              >
                {t('sheets.newTitle')}
              </button>
            ) : null}
          </div>
          {message ? (
            <p
              className="cgw-workbooks-muted"
              role={message.alert ? 'alert' : 'status'}
              data-testid="workbooks-message"
            >
              {message.text}
            </p>
          ) : null}
          {list === null ? (
            <p aria-busy="true" className="cgw-workbooks-muted">
              {t('app.loading')}
            </p>
          ) : shown.length === 0 ? (
            <p className="cgw-workbooks-muted" data-testid="workbooks-empty">
              {t(
                list.length
                  ? 'sheets.pickNone'
                  : trash
                    ? 'sheets.screenTrashEmpty'
                    : 'sheets.pickEmpty',
              )}
            </p>
          ) : (
            <table className="cgw-workbooks-table" data-testid="workbooks-table">
              <caption className="cgw-visually-hidden">
                {t(trash ? 'sheets.screenTrash' : 'sheets.screenLive')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('sheets.columnName')}</th>
                  <th scope="col">{t(trash ? 'sheets.columnTrashed' : 'sheets.columnSaved')}</th>
                  <th scope="col">{t('sheets.columnAccess')}</th>
                  <th scope="col">
                    <span className="cgw-visually-hidden">{t('sheets.columnActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => {
                  const editor = canEditWorkbook(w.access);
                  return (
                    <tr key={w.id} data-workbook={w.id}>
                      <td dir="auto">{w.name}</td>
                      <td className="cgw-workbooks-muted">
                        {trash && w.trashedAt
                          ? format.format(new Date(w.trashedAt))
                          : w.savedAt
                            ? format.format(new Date(w.savedAt))
                            : t('sheets.empty')}
                      </td>
                      <td className="cgw-workbooks-muted">{t(accessKey(w.access))}</td>
                      <td>
                        <div className="cgw-workbooks-actions">
                          {trash ? (
                            editor && (
                              <button
                                type="button"
                                className="cgw-button cgw-sheet-button"
                                aria-label={t('sheets.restoreNamed', { name: w.name })}
                                onClick={() =>
                                  void act(
                                    () => api!.update(w.id, { trashed: false }, w.version),
                                    t('sheets.restored', { name: w.name }),
                                  )
                                }
                              >
                                {t('sheets.restore')}
                              </button>
                            )
                          ) : (
                            <>
                              <button
                                type="button"
                                className="cgw-button cgw-sheet-button"
                                aria-label={t('sheets.openNamed', { name: w.name })}
                                onClick={() =>
                                  void openInSheet(api!, w.id, platform).catch(() =>
                                    setMessage({ text: t('sheets.openFailed'), alert: true }),
                                  )
                                }
                              >
                                {t('sheets.open')}
                              </button>
                              {editor && (
                                <button
                                  type="button"
                                  className="cgw-button cgw-sheet-button"
                                  aria-label={t('sheets.renameNamed', { name: w.name })}
                                  onClick={() => setRenaming(w)}
                                >
                                  {t('sheets.rename')}
                                </button>
                              )}
                              <button
                                type="button"
                                className="cgw-button cgw-sheet-button"
                                aria-label={t('sheets.permissionsNamed', { name: w.name })}
                                onClick={() => setSharing(w)}
                              >
                                {t('sheets.permissions')}
                              </button>
                              {editor && (
                                <button
                                  type="button"
                                  className="cgw-button cgw-sheet-button is-danger"
                                  aria-label={t('sheets.trashNamed', { name: w.name })}
                                  onClick={() =>
                                    void act(
                                      () => api!.update(w.id, { trashed: true }, w.version),
                                      t('sheets.trashedNamed', { name: w.name }),
                                    )
                                  }
                                >
                                  {t('sheets.trashIt')}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      {renaming && api ? (
        <RenameWorkbook
          workbook={renaming}
          onClose={() => setRenaming(null)}
          onRename={(name) => {
            const target = renaming;
            setRenaming(null);
            void act(
              () => api.update(target.id, { name }, target.version),
              t('sheets.renamed', { name }),
            );
          }}
        />
      ) : null}
      {sharing && cloud && workspaceId ? (
        <WorkbookPermissions
          cloud={cloud}
          workspaceId={workspaceId}
          workbook={sharing}
          onClose={() => setSharing(null)}
        />
      ) : null}
    </section>
  );
}

function RenameWorkbook({
  workbook,
  onClose,
  onRename,
}: {
  workbook: Workbook;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(workbook.name);
  const id: Id = workbook.id;
  const clean = name.trim();
  return (
    <Dialog title={t('sheets.renameTitle', { name: workbook.name })} onClose={onClose}>
      <form
        className="cgw-workbook-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (clean) onRename(clean);
        }}
      >
        <label htmlFor={`cgw-rename-${id}`}>{t('sheets.newName')}</label>
        <input
          id={`cgw-rename-${id}`}
          className="cgw-input"
          dir="auto"
          autoFocus
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('frame.cancel')}
        </button>
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={!clean || clean === workbook.name}
          onClick={() => onRename(clean)}
        >
          {t('sheets.rename')}
        </button>
      </div>
    </Dialog>
  );
}
