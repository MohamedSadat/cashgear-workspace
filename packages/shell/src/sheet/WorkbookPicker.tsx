// "Existing workbook": the workbooks of the open workspace the person may read (the server's
// list, which checks each one), found by name; Enter or a click chooses one. "New workbook": a
// name, then a workbook with no version, which Sheet opens blank. Both need the account and a
// connection: a local workspace or no network says so and makes nothing.
import type { WorkbookRef } from '@cgw/editor';
import { normaliseText, searchTerms, uuidv7 } from '@cgw/workspace';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount } from '../cloud/CloudUi';
import type { Cloud } from '../cloud/cloud';
import { Dialog } from '../Dialog';
import type { WorkspaceSession } from '../session';
import { failureCode, workbookApi, type Workbook } from './api';
import './sheet.css';

type Unavailable = 'local' | 'signedOut' | 'offline' | null;

/** Why workbooks cannot be reached now, or null when they can. */
export function useUnavailable(session: WorkspaceSession, cloud: Cloud | null): Unavailable {
  const account = useAccount(cloud);
  if (!cloud || session.current?.localOnly !== false) return 'local';
  if (account === null) return 'signedOut';
  if (cloud.status.state === 'offline') return 'offline';
  return null;
}

const unavailableText = {
  local: 'sheets.local',
  signedOut: 'sheets.signIn',
  offline: 'sheets.offlineNone',
} as const;

export function PickWorkbook({
  session,
  cloud,
  onDone,
}: {
  session: WorkspaceSession;
  cloud: Cloud | null;
  onDone: (ref: WorkbookRef | null) => void;
}) {
  const { t } = useTranslation();
  const unavailable = useUnavailable(session, cloud);
  const [list, setList] = useState<Workbook[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const workspaceId = session.workspaceId;
  useEffect(() => {
    if (unavailable || !cloud || !workspaceId) return;
    let live = true;
    workbookApi(cloud.api)
      .list(workspaceId)
      .then(
        (found) => live && setList([...found].sort((a, b) => a.name.localeCompare(b.name))),
        (error: unknown) =>
          live &&
          setFailed(
            failureCode(error) === 'offline' ? t('sheets.offlineNone') : t('sheets.listFailed'),
          ),
      );
    return () => {
      live = false;
    };
  }, [unavailable, cloud, workspaceId, t]);
  const all = useMemo(() => list ?? [], [list]);
  const terms = searchTerms(normaliseText(query));
  const found = terms.length
    ? all.filter((w) => {
        const words = normaliseText(w.name).split(' ');
        return terms.every((term) => words.some((word) => word.startsWith(term)));
      })
    : all;
  const choose = (workbook: Workbook) => onDone({ workbookId: workbook.id });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(found.length - 1, i + step)));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (found[active]) choose(found[active]);
    }
  };
  const format = new Intl.DateTimeFormat(document.documentElement.lang || 'en', {
    dateStyle: 'medium',
  });
  return (
    <Dialog title={t('sheets.pickTitle')} onClose={() => onDone(null)}>
      {unavailable ? (
        <p role="status" className="cgw-muted">
          {t(unavailableText[unavailable])}
        </p>
      ) : (
        <>
          <input
            className="cgw-input cgw-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="cgw-workbook-pick-list"
            aria-activedescendant={found.length ? `cgw-workbook-pick-${active}` : undefined}
            aria-label={t('sheets.pickSearch')}
            placeholder={t('sheets.pickSearch')}
            autoFocus
            dir="auto"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div
            id="cgw-workbook-pick-list"
            role="listbox"
            aria-label={t('sheets.pickTitle')}
            aria-busy={list === null && !failed}
            className="cgw-palette-list cgw-workbook-pick-list"
          >
            {found.map((w, i) => (
              <div
                key={w.id}
                id={`cgw-workbook-pick-${i}`}
                role="option"
                aria-selected={i === active}
                className="cgw-palette-item"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(w)}
              >
                <span className="cgw-palette-icon" aria-hidden="true">
                  ⊞
                </span>
                <span className="cgw-palette-text">
                  <span className="cgw-palette-label" dir="auto">
                    {w.name}
                  </span>
                  <span className="cgw-palette-detail">
                    {w.savedAt
                      ? t('sheets.saved', { when: format.format(new Date(w.savedAt)) })
                      : t('sheets.empty')}
                  </span>
                </span>
              </div>
            ))}
            {list !== null && found.length === 0 && (
              <div className="cgw-palette-empty">
                {t(all.length ? 'sheets.pickNone' : 'sheets.pickEmpty')}
              </div>
            )}
            {list === null && !failed && (
              <div className="cgw-palette-empty">{t('app.loading')}</div>
            )}
          </div>
          {failed && (
            <p role="alert" className="cgw-muted">
              {failed}
            </p>
          )}
        </>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={() => onDone(null)}>
          {t('frame.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

export function NewWorkbook({
  session,
  cloud,
  onDone,
}: {
  session: WorkspaceSession;
  cloud: Cloud | null;
  onDone: (ref: WorkbookRef | null) => void;
}) {
  const { t } = useTranslation();
  const unavailable = useUnavailable(session, cloud);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const workspaceId = session.workspaceId;
  const create = async () => {
    if (!cloud || !workspaceId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const made = await workbookApi(cloud.api).create(
        workspaceId,
        name.trim() || t('sheets.untitled'),
        uuidv7(),
      );
      onDone({ workbookId: made.id });
    } catch (error) {
      const code = failureCode(error);
      setMessage(
        code === 'offline'
          ? t('sheets.offlineNone')
          : code === 'access.denied'
            ? t('sheets.guestCannotCreate')
            : t('sheets.createFailed'),
      );
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('sheets.newTitle')} onClose={() => onDone(null)}>
      {unavailable ? (
        <p role="status" className="cgw-muted">
          {t(unavailableText[unavailable])}
        </p>
      ) : (
        <form
          className="cgw-workbook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor="cgw-workbook-name">{t('sheets.newName')}</label>
          <input
            id="cgw-workbook-name"
            className="cgw-input"
            dir="auto"
            autoFocus
            maxLength={200}
            placeholder={t('sheets.untitled')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="cgw-muted">{t('sheets.newNote')}</p>
          {message && (
            <p role="alert" className="cgw-muted">
              {message}
            </p>
          )}
        </form>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={() => onDone(null)}>
          {t('frame.cancel')}
        </button>
        {!unavailable && (
          <button
            type="button"
            className="cgw-button is-primary"
            disabled={busy}
            onClick={() => void create()}
          >
            {t('sheets.create')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
