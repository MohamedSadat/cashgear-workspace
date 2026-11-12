// The dialogs that make or choose a database, asked for from anywhere (the editor's "Database" and
// "Linked view", the sidebar's "New database" and "Import a CSV", the palette) and drawn once
// inside the frame: a request is an event with the answer's callback; with no frame listening,
// it answers null at once.
import type { DatabaseRef as BlockRef } from '@cgw/editor';
import { normaliseText, searchTerms, type Id } from '@cgw/workspace';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { WorkspaceSession } from '../session';
import { useMirror } from '../sidebar/Sidebar';
import type { ShellDatabaseHost } from './host';
import { DATABASE_GLYPH, type DatabasePlace } from './make';

const TemplatePicker = lazy(() =>
  import('@cgw/database').then((m) => ({ default: m.TemplatePicker })),
);
const ImportDialog = lazy(() => import('@cgw/database').then((m) => ({ default: m.ImportDialog })));

type Made = { databaseId: Id; viewId: Id };
type Request =
  | { kind: 'pick'; answer: (ref: BlockRef | null) => void }
  | { kind: 'new'; place: DatabasePlace; answer: (made: Made | null) => void }
  | { kind: 'import'; place: DatabasePlace; answer: (made: { databaseId: Id } | null) => void };

const requests = new EventTarget();
let listening = 0;

function ask<T>(make: (answer: (value: T | null) => void) => Request): Promise<T | null> {
  if (!listening) return Promise.resolve(null);
  return new Promise((resolve) => {
    requests.dispatchEvent(new CustomEvent('request', { detail: make(resolve) }));
  });
}

/** Whether the frame's dialogs are there to ask (else a request answers null at once). */
export const canAsk = () => listening > 0;

/** Asks which database of the workspace a linked view shows; null when cancelled. */
export const requestDatabasePick = () =>
  ask<BlockRef>((answer) => ({ kind: 'pick', answer }) as Request);

/** Makes a database (empty, or from a template) at a place; null when cancelled. */
export const requestNewDatabase = (place: DatabasePlace) =>
  ask<Made>((answer) => ({ kind: 'new', place, answer }) as Request);

/** Makes a database at a place from a CSV file (the import dialog); null when cancelled. */
export const requestCsvImport = (place: DatabasePlace) =>
  ask<{ databaseId: Id }>((answer) => ({ kind: 'import', place, answer }) as Request);

export function DatabaseDialogs({
  session,
  host,
}: {
  session: WorkspaceSession;
  host: ShellDatabaseHost;
}) {
  const [request, setRequest] = useState<Request | null>(null);
  const current = useRef<Request | null>(null);
  useEffect(() => {
    const take = (event: Event) => {
      const next = (event as CustomEvent<Request>).detail;
      // One at a time: an earlier one still open is cancelled.
      current.current?.answer(null);
      current.current = next;
      setRequest(next);
    };
    requests.addEventListener('request', take);
    listening++;
    return () => {
      listening--;
      requests.removeEventListener('request', take);
    };
  }, []);
  if (!request) return null;
  const done = () => {
    current.current = null;
    setRequest(null);
  };
  if (request.kind === 'pick')
    return (
      <PickDatabase
        session={session}
        onDone={(ref) => {
          done();
          request.answer(ref);
        }}
      />
    );
  if (request.kind === 'import')
    return (
      <Suspense fallback={null}>
        <ImportDialog
          host={host}
          databaseId={null}
          place={request.place}
          onClose={(result) => {
            done();
            request.answer(result ? { databaseId: result.databaseId } : null);
          }}
        />
      </Suspense>
    );
  return (
    <Suspense fallback={null}>
      <TemplatePicker
        host={host}
        place={request.place}
        onCreated={(made) => {
          done();
          request.answer({ databaseId: made.databaseId, viewId: made.viewId });
        }}
        onCancel={() => {
          done();
          request.answer(null);
        }}
      />
    </Suspense>
  );
}

/** The databases of the open workspace, found by title; Enter or a click chooses one. */
function PickDatabase({
  session,
  onDone,
}: {
  session: WorkspaceSession;
  onDone: (ref: BlockRef | null) => void;
}) {
  const { t } = useTranslation();
  const revision = useMirror(session);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const all = useMemo(() => {
    const { mirror } = session;
    const out: { id: Id; title: string; icon: string | null; where: string }[] = [];
    for (const database of mirror.databases.values()) {
      const page = mirror.pages.get(database.id);
      if (!page || page.trashedAt || database.workspaceId !== session.workspaceId) continue;
      const trail = mirror.ancestors(page.id).map((p) => p.title || t('page.untitled'));
      const section = mirror.sections.get(page.sectionId)?.name ?? '';
      out.push({
        id: page.id,
        title: page.title || t('database.untitledDatabase'),
        icon: page.icon,
        where: [section, ...trail].filter(Boolean).join(' › '),
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
    // The mirror changes in place; its revision says when.
  }, [session, t, revision]);
  const terms = searchTerms(normaliseText(query));
  const found = terms.length
    ? all.filter((d) => {
        const words = normaliseText(d.title).split(' ');
        return terms.every((term) => words.some((word) => word.startsWith(term)));
      })
    : all;
  const choose = (id: Id) => onDone({ databaseId: id, viewId: null });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(found.length - 1, i + step)));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (found[active]) choose(found[active].id);
    }
  };
  return (
    <Dialog title={t('databases.pickTitle')} onClose={() => onDone(null)}>
      <input
        className="cgw-input cgw-palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="cgw-db-pick-list"
        aria-activedescendant={found.length ? `cgw-db-pick-${active}` : undefined}
        aria-label={t('databases.pickSearch')}
        placeholder={t('databases.pickSearch')}
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
        id="cgw-db-pick-list"
        role="listbox"
        aria-label={t('databases.pickTitle')}
        className="cgw-palette-list"
      >
        {found.map((d, i) => (
          <div
            key={d.id}
            id={`cgw-db-pick-${i}`}
            role="option"
            aria-selected={i === active}
            className="cgw-palette-item"
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(d.id)}
          >
            <span className="cgw-palette-icon" aria-hidden="true">
              {d.icon ?? DATABASE_GLYPH}
            </span>
            <span className="cgw-palette-text">
              <span className="cgw-palette-label" dir="auto">
                {d.title}
              </span>
              {d.where && (
                <span className="cgw-palette-detail" dir="auto">
                  {d.where}
                </span>
              )}
            </span>
          </div>
        ))}
        {found.length === 0 && (
          <div className="cgw-palette-empty">
            {t(all.length ? 'databases.pickNone' : 'databases.pickEmpty')}
          </div>
        )}
      </div>
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={() => onDone(null)}>
          {t('frame.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
