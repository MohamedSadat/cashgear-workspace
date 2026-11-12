import { fragmentToJSON, readOnlyView, type DocJSON, type PageDocument } from '@cgw/doc';
import {
  BlockEditorView,
  EditorOverlays,
  type BlockEditor,
  type EditorHost,
  type EditorStrings,
} from '@cgw/editor';
import type { PageRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { unreachable } from '../cloud/cloud';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { formatShortcut } from '../shortcuts';
import { NewerDocumentError, NotOnDeviceError, type WorkspaceSession } from '../session';
import { registerBlockCommands, slashItems } from './blockCommands';
import { editorHost, ToggleState } from './editorHost';
import { exportAndSave } from '../exchange/DataPanel';
import { HistoryDialog } from './HistoryDialog';
import { PageHeader } from './PageHeader';
import { pageEvents, takeHistoryRequest } from './PageMenu';
import { usePageDoc } from './usePageDoc';

export interface PageViewProps {
  session: WorkspaceSession;
  page: PageRecord;
  onEditor?: (editor: BlockEditor | null, doc: PageDocument | null) => void;
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
function usePageHost(session: WorkspaceSession, page: PageRecord): EditorHost {
  const { t } = useTranslation();
  const services = useShell();
  const { platform } = services;
  const strings = t('editor', { returnObjects: true }) as unknown as EditorStrings;
  const toggles = useMemo(() => new ToggleState(session, page.id), [session, page.id]);
  return useMemo(
    () => ({
      ...editorHost({
        session,
        pageId: page.id,
        strings,
        toggles,
        openExternal: (url) => void platform.openExternal(url),
        saveAsset: () => {},
        createChildPage: async () => {
          const child = await session.createPage({
            sectionId: page.sectionId,
            parentPageId: page.id,
          });
          return child.id;
        },
      }),
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
    [session, page.id, page.sectionId, strings, toggles, platform, services, t],
  );
}

/**
 * A page saved by a newer build whose document this device does not hold: the server's derived
 * JSON, read-only, with the banner asking to update. Nothing is stored or pushed (the engine holds
 * such pages back). Offline, it says the page is not on this device yet.
 */
function NewerPage({ session, page }: { session: WorkspaceSession; page: PageRecord }) {
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
  const [readOnly, setReadOnly] = useState(doc.readOnly);
  useEffect(() => {
    setReadOnly(doc.readOnly);
    return doc.onEvent((event) => event.kind === 'newerVersion' && setReadOnly(true));
  }, [doc]);
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

  const readOnlyContent = useMemo(
    () =>
      readOnly
        ? readOnlyJSON(fragmentToJSON(doc.fragment), {
            block: t('editor.readOnlyBlock'),
            inline: t('editor.readOnlyInline'),
          })
        : undefined,
    [doc, readOnly, t],
  );

  return (
    <article className="cgw-page" aria-label={page.title || t('page.untitled')}>
      {readOnly && (
        <div className="cgw-page-notice" role="status">
          {t('page.newerVersion')}
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
      <BlockEditorView
        fragment={readOnly ? undefined : doc.fragment}
        readOnlyContent={readOnlyContent}
        host={host}
        label={t('page.content')}
        overlays={(editor) => <EditorOverlays editor={editor} host={host} />}
        onEditor={(editor) => {
          // The cold-start budget's end: the first editable page (bench/phase1.mjs reads it).
          if (editor && !performance.getEntriesByName('cgw-editable').length)
            performance.mark('cgw-editable');
          editorRef.current = editor;
          services.editor.current = editor;
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
          onClose={() => setHistory(false)}
        />
      )}
    </article>
  );
}

/** The page title, edited in place; saved as a page.update after a short pause. */
function TitleField({
  session,
  page,
  readOnly,
  onEnter,
}: {
  session: WorkspaceSession;
  page: PageRecord;
  readOnly: boolean;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(page.title);
  const pending = useRef<number | null>(null);
  const editing = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);

  // A page just made, from the sidebar's button, its row menu or a key, starts in its title.
  useEffect(() => {
    if (session.takeFresh(page.id)) field.current?.focus();
  }, [session, page.id]);

  useEffect(() => {
    if (!editing.current) setDraft(page.title);
  }, [page.title]);

  const commit = (value: string): Promise<void> | undefined => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
    if (value !== page.title) return session.updatePage(page.id, { title: value });
  };

  // Leaving the page with a title still waiting to be saved saves it now; so does the session's
  // flush (the page hiding, the window closing, an upload), which waits for it to be stored.
  const latest = useRef({ draft, commit });
  latest.current = { draft, commit };
  useEffect(
    () => () => {
      if (pending.current !== null) void latest.current.commit(latest.current.draft);
    },
    [],
  );
  useEffect(
    () =>
      session.onFlush(() =>
        pending.current !== null ? latest.current.commit(latest.current.draft) : undefined,
      ),
    [session],
  );

  return (
    <textarea
      ref={field}
      className="cgw-title"
      rows={1}
      dir="auto"
      value={draft}
      readOnly={readOnly}
      placeholder={t('page.untitled')}
      aria-label={t('page.title')}
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        void commit(draft);
      }}
      onChange={(event) => {
        const value = event.target.value.replace(/\n/g, ' ');
        setDraft(value);
        if (pending.current !== null) clearTimeout(pending.current);
        pending.current = window.setTimeout(() => void commit(value), 400);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void commit(draft);
          onEnter();
        }
      }}
    />
  );
}
