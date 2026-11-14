import { fragmentToJSON, readOnlyView, type DocJSON, type PageDocument } from '@cgw/doc';
import {
  BlockEditorView,
  EditorOverlays,
  type BlockEditor,
  type DatabaseMountOptions,
  type EditorHost,
  type EditorStrings,
} from '@cgw/editor';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { unreachable } from '../cloud/cloud';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { useDatabaseHost } from '../database/context';
import { canAsk, requestDatabasePick, requestNewDatabase } from '../database/dialogs';
import type { ShellDatabaseHost } from '../database/host';
import { emptyRowsOps, newDatabaseOps } from '../database/make';
import { mountDatabase } from '../database/mount';
import { useWorkbooksHost } from '../sheet/host';
import { useErpHost } from '../erp/host';
import { formatShortcut } from '../shortcuts';
import {
  NewerDocumentError,
  NotOnDeviceError,
  isRowRecord,
  type AnyPage,
  type WorkspaceSession,
} from '../session';
import { registerBlockCommands, slashItems } from './blockCommands';
import { assetsOf, editorHost, ToggleState } from './editorHost';
import { exportAndSave } from '../exchange/DataPanel';
import { HistoryDialog } from './HistoryDialog';
import { PageHeader } from './PageHeader';
import { pageEvents, takeHistoryRequest } from './PageMenu';
import { TitleField } from './TitleField';
import { usePageDoc } from './usePageDoc';

// A row's properties above its body: the database views' chunk, loaded with the first row.
const RowProperties = lazy(() =>
  import('@cgw/database').then((m) => ({ default: m.RowProperties })),
);

export interface PageViewProps {
  session: WorkspaceSession;
  /** A page, or a row (its properties are drawn above its body). */
  page: AnyPage;
  onEditor?: (editor: BlockEditor | null, doc: PageDocument | null) => void;
}

/** Empty rows an inline database starts with when it is made empty. */
const INLINE_ROWS = 3;

/**
 * An inline database ("Database" in the slash menu): its page under this page, chosen in the
 * template dialog (empty, or from a template); an empty one starts with three empty rows. Null
 * when cancelled or refused (the person has been told why).
 */
async function createInlineDatabase(
  session: WorkspaceSession,
  host: ShellDatabaseHost,
  page: AnyPage,
  names: { title: string; table: string },
) {
  const place = {
    workspaceId: page.workspaceId,
    sectionId: page.sectionId,
    parentPageId: page.id,
    orderKey: session.keyFor(page.sectionId, page.id),
  };
  try {
    if (!canAsk()) {
      const made = newDatabaseOps(place, names, { rows: INLINE_ROWS });
      await host.apply(made.ops);
      return { databaseId: made.databaseId, viewId: made.viewId };
    }
    const made = await requestNewDatabase(place);
    if (!made) return null;
    if (!session.mirror.rowsOf(made.databaseId).length)
      await host.apply(
        emptyRowsOps(
          { id: made.databaseId, workspaceId: place.workspaceId, sectionId: place.sectionId },
          INLINE_ROWS,
        ),
      );
    return made;
  } catch {
    return null;
  }
}

/** One page: its title (a field on the page record, D6) and its document in the editor. */
export function PageView({ session, page, onEditor }: PageViewProps) {
  const state = usePageDoc(session, page.id);
  const { t } = useTranslation();
  const services = useShell();
  // The block commands come with the editor; the palette lists them while a page is open.
  useEffect(() => registerBlockCommands(services, t), [services, t]);
  if (state.status === 'loading') return <div className="cgw-page-loading">{t('app.loading')}</div>;
  if (state.status === 'error') {
    if (state.error instanceof NotOnDeviceError)
      return <NotOnDevice reason={state.error.reason} onRetry={state.retry} />;
    if (state.error instanceof NewerDocumentError)
      return <NewerPage key={page.id} session={session} page={page} />;
    return (
      <div className="cgw-page-error" role="alert">
        {t('page.openFailed')}
      </div>
    );
  }
  return (
    <LoadedPage key={page.id} session={session} page={page} doc={state.doc} onEditor={onEditor} />
  );
}

/**
 * A page this device holds nothing of, opened with no way to fetch it. It says so, and opens by
 * itself when the server can be reached again (the sync status leaves offline or signed out).
 */
function NotOnDevice({
  reason,
  onRetry,
}: {
  reason: 'offline' | 'signedOut';
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const cloud = useCloud();
  useEffect(() => {
    if (!cloud) return;
    const reachable = () => {
      const state = cloud.status.state;
      return !!cloud.account && (state === 'syncing' || state === 'synced');
    };
    if (reachable()) {
      onRetry();
      return;
    }
    return cloud.subscribe(() => reachable() && onRetry());
  }, [cloud, onRetry]);
  return (
    <div className="cgw-empty" role="status" data-testid="not-on-device">
      <h1>{t(reason === 'signedOut' ? 'page.notOnDeviceSignedOut' : 'page.notOnDevice')}</h1>
      <button type="button" className="cgw-button" onClick={onRetry}>
        {t('page.tryAgain')}
      </button>
    </div>
  );
}

/** The content a newer build saved, made into what this build can draw (D7), read-only. */
function readOnlyJSON(json: DocJSON, strings: { block: string; inline: string }) {
  return readOnlyView(json, strings).json;
}

/** The editor's host for a page: its assets, links, child pages, slash menu and strings. */
function usePageHost(session: WorkspaceSession, page: AnyPage): EditorHost {
  const { t, i18n } = useTranslation();
  const services = useShell();
  const { platform } = services;
  const databases = useDatabaseHost();
  // Workbooks (Phase 5): the block's frame and the dialogs that choose or make one.
  const workbooks = useWorkbooksHost(session, page.id);
  // ERP views (Phase 5): the block's frame, from the reader's own ERP session.
  const erp = useErpHost(session);
  const strings = t('editor', { returnObjects: true }) as unknown as EditorStrings;
  const toggles = useMemo(() => new ToggleState(session, page.id), [session, page.id]);
  const language = i18n.language;
  // Nothing sits under a row: a row's body holds no sub-page and no inline database (a linked
  // view of a database is fine).
  const row = page.kind === 'row';
  return useMemo(
    () => ({
      ...editorHost({
        session,
        pageId: page.id,
        strings,
        toggles,
        openExternal: (url) => void platform.openExternal(url),
        assets: assetsOf(session, (name, bytes, type) => platform.saveFile(name, bytes, type)),
        createChildPage: async () => {
          if (row) return null;
          const child = await session.createPage({
            sectionId: page.sectionId,
            parentPageId: page.id,
          });
          return child.id;
        },
      }),
      locale: language,
      databases: databases
        ? {
            mount: (element: HTMLElement, options: DatabaseMountOptions) =>
              mountDatabase(element, options, { host: databases, i18n }),
            ...(row
              ? {}
              : {
                  create: () =>
                    createInlineDatabase(session, databases, page, {
                      title: t('database.templates.titleProperty'),
                      table: t('database.viewType.table'),
                    }),
                }),
            pick: requestDatabasePick,
          }
        : undefined,
      workbooks,
      erp,
      slash: {
        list: (query: string) => slashItems(services, t, query),
        run: (id: string) => void services.commands.run(id, { services, toggleSidebar: () => {} }),
      },
      blockName: (name: string) => t(`blocks.${name}` as 'blocks.paragraph'),
      shortcut: (chord: string) => formatShortcut(chord),
      copyBlockLink: (blockId: string) =>
        void navigator.clipboard?.writeText(
          `${location.origin}${location.pathname}#/p/${page.id}/${blockId}`,
        ),
    }),
    // Strings change with the language; the rest with the page.
    [
      session,
      page.id,
      page.sectionId,
      row,
      strings,
      toggles,
      platform,
      services,
      t,
      language,
      databases,
      workbooks,
      erp,
    ],
  );
}

/**
 * A page saved by a newer build whose document this device does not hold: the server's derived
 * JSON, read-only, with the banner asking to update. Nothing is stored or pushed (the engine holds
 * such pages back). Offline, it says the page is not on this device yet.
 */
function NewerPage({ session, page }: { session: WorkspaceSession; page: AnyPage }) {
  const { t } = useTranslation();
  const cloud = useCloud();
  const host = usePageHost(session, page);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; json: DocJSON }
    | { kind: 'offline' }
    | { kind: 'failed' }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cloud) return setState({ kind: 'failed' });
    let live = true;
    cloud.docJson(page.id).then(
      (json) => live && setState({ kind: 'ready', json }),
      (error: unknown) => live && setState({ kind: unreachable(error) ? 'offline' : 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [cloud, page.id, attempt]);
  const content = useMemo(
    () =>
      state.kind === 'ready'
        ? readOnlyJSON(state.json, {
            block: t('editor.readOnlyBlock'),
            inline: t('editor.readOnlyInline'),
          })
        : undefined,
    [state, t],
  );
  if (state.kind === 'offline')
    return <NotOnDevice reason="offline" onRetry={() => setAttempt((n) => n + 1)} />;
  if (state.kind === 'failed')
    return (
      <div className="cgw-page-error" role="alert">
        {t('page.openFailed')}
      </div>
    );
  return (
    <article className="cgw-page" aria-label={page.title || t('page.untitled')}>
      <div className="cgw-page-notice" role="status">
        {t('page.newerVersion')}
      </div>
      <PageHeader session={session} page={page} readOnly />
      <TitleField session={session} page={page} readOnly onEnter={() => {}} />
      {content ? (
        <BlockEditorView readOnlyContent={content} host={host} label={t('page.content')} />
      ) : (
        <div className="cgw-page-loading">{t('app.loading')}</div>
      )}
    </article>
  );
}

function LoadedPage({ session, page, doc, onEditor }: PageViewProps & { doc: PageDocument }) {
  const { t } = useTranslation();
  const services = useShell();
  const { platform } = services;
  const editorRef = useRef<BlockEditor | null>(null);
  const host = usePageHost(session, page);
  // A pulled change can make the page newer than this build while it is open: it turns read-only.
  const [newer, setNewer] = useState(doc.readOnly);
  useEffect(() => {
    setNewer(doc.readOnly);
    return doc.onEvent((event) => event.kind === 'newerVersion' && setNewer(true));
  }, [doc]);
  // The account may only view (or comment on) the page: shown, never edited; it follows the page's
  // access in the mirror (a resync also opens the document again, session.reloadMirror). The
  // server is still the check.
  const viewOnly = !session.canEdit(page.id);
  const databases = useDatabaseHost();
  const readOnly = newer || viewOnly;
  // A notice's "Open the page history" may have come before the page was on screen.
  const [history, setHistory] = useState(false);
  const [editor, setEditor] = useState<BlockEditor | null>(null);
  useEffect(() => {
    if (takeHistoryRequest(page.id)) setHistory(true);
  }, [page.id]);
  useEffect(() => {
    const onHistory = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== page.id) return;
      takeHistoryRequest(page.id);
      setHistory(true);
    };
    const onExport = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== page.id) return;
      void exportAndSave(session, (n, b, ty) => platform.saveFile(n, b, ty), t('page.untitled'), [
        page.id,
      ]).catch((error: unknown) => console.error('Export failed:', error));
    };
    pageEvents.addEventListener('history', onHistory);
    pageEvents.addEventListener('export', onExport);
    return () => {
      pageEvents.removeEventListener('history', onHistory);
      pageEvents.removeEventListener('export', onExport);
    };
  }, [page.id, session, platform, t]);

  // Saved text goes into the search index a moment after typing stops (M1.8).
  useEffect(() => doc.onSaved(() => session.scheduleIndex(page.id)), [doc, session, page.id]);

  const strings = useMemo(
    () => ({ block: t('editor.readOnlyBlock'), inline: t('editor.readOnlyInline') }),
    [t],
  );
  const readOnlyContent = useMemo(
    () => (readOnly ? readOnlyJSON(fragmentToJSON(doc.fragment), strings) : undefined),
    [doc, readOnly, strings],
  );
  // Read-only, the editor is not bound to the document: others' edits as they arrive are shown by
  // setting its content again shortly after (the same editor, so the reader keeps their place).
  useEffect(() => {
    if (!readOnly) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer = null;
      const editor = editorRef.current?.editor;
      if (!editor || editor.isDestroyed) return;
      editor.commands.setContent(readOnlyJSON(fragmentToJSON(doc.fragment), strings) as never, {
        emitUpdate: false,
      });
    };
    const onUpdate = () => {
      timer ??= setTimeout(refresh, 300);
    };
    doc.doc.on('update', onUpdate);
    return () => {
      doc.doc.off('update', onUpdate);
      if (timer !== null) clearTimeout(timer);
    };
  }, [doc, readOnly, strings]);

  return (
    <article className="cgw-page" aria-label={page.title || t('page.untitled')}>
      {readOnly && (
        <div className="cgw-page-notice" role="status" data-testid="page-read-only">
          {t(newer ? 'page.newerVersion' : 'page.viewOnly')}
        </div>
      )}
      <PageHeader session={session} page={page} readOnly={readOnly} />
      <TitleField
        session={session}
        page={page}
        readOnly={readOnly}
        onEnter={() => {
          // Focus now, not on the next frame as Tiptap's focus does: a key typed at once must land
          // in the page, not in the title.
          const editor = editorRef.current?.editor;
          if (!editor) return;
          editor.view.focus();
          editor.commands.focus('start');
        }}
      />
      {isRowRecord(page) && databases && (
        <Suspense fallback={<div className="cgw-row-props-loading" />}>
          <RowProperties host={databases} rowId={page.id} editable={!readOnly} />
        </Suspense>
      )}
      <BlockEditorView
        fragment={readOnly ? undefined : doc.fragment}
        readOnlyContent={readOnlyContent}
        host={host}
        label={t('page.content')}
        // Read-only: no block handle, toolbar or menus, which would change what is shown.
        overlays={readOnly ? undefined : (editor) => <EditorOverlays editor={editor} host={host} />}
        onEditor={(editor) => {
          // The cold-start budget's end: the first editable page (bench/phase1.mjs reads it).
          if (editor && !performance.getEntriesByName('cgw-editable').length)
            performance.mark('cgw-editable');
          editorRef.current = editor;
          // The palette's block commands act on an editor that can be edited only.
          services.editor.current = readOnly ? null : editor;
          setEditor(editor);
          onEditor?.(editor, editor ? doc : null);
        }}
      />
      {history && (
        <HistoryDialog
          session={session}
          doc={doc}
          editor={editor}
          host={host}
          readOnly={readOnly}
          onClose={() => setHistory(false)}
        />
      )}
    </article>
  );
}
