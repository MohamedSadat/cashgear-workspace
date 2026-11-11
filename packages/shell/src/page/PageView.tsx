import { fragmentToJSON, knownTypes, readableJSON, type PageDocument } from '@cgw/doc';
import { BlockEditorView, EditorOverlays, type BlockEditor, type EditorStrings } from '@cgw/editor';
import type { PageRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell } from '../context';
import { formatShortcut } from '../shortcuts';
import type { WorkspaceSession } from '../session';
import { registerBlockCommands, slashItems } from './blockCommands';
import { editorHost, ToggleState } from './editorHost';
import { PageHeader } from './PageHeader';
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
  if (state.status === 'error')
    return (
      <div className="cgw-page-error" role="alert">
        {t('page.openFailed')}
      </div>
    );
  return (
    <LoadedPage key={page.id} session={session} page={page} doc={state.doc} onEditor={onEditor} />
  );
}

function LoadedPage({ session, page, doc, onEditor }: PageViewProps & { doc: PageDocument }) {
  const { t } = useTranslation();
  const services = useShell();
  const { platform } = services;
  const editorRef = useRef<BlockEditor | null>(null);
  const strings = t('editor', { returnObjects: true }) as unknown as EditorStrings;
  const toggles = useMemo(() => new ToggleState(session, page.id), [session, page.id]);
  const host = useMemo(
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
  // Saved text goes into the search index a moment after typing stops (M1.8).
  useEffect(() => doc.onSaved(() => session.scheduleIndex(page.id)), [doc, session, page.id]);

  const readOnlyContent = useMemo(
    () =>
      doc.readOnly
        ? readableJSON(fragmentToJSON(doc.fragment), knownTypes(), t('editor.readOnlyBlock'))
        : undefined,
    [doc, t],
  );

  return (
    <article className="cgw-page" aria-label={page.title || t('page.untitled')}>
      {doc.readOnly && (
        <div className="cgw-page-notice" role="status">
          {t('page.newerVersion')}
        </div>
      )}
      <PageHeader session={session} page={page} readOnly={doc.readOnly} />
      <TitleField
        session={session}
        page={page}
        readOnly={doc.readOnly}
        onEnter={() => editorRef.current?.editor.commands.focus('start')}
      />
      <BlockEditorView
        fragment={doc.readOnly ? undefined : doc.fragment}
        readOnlyContent={readOnlyContent}
        host={host}
        label={t('page.content')}
        overlays={(editor) => <EditorOverlays editor={editor} host={host} />}
        onEditor={(editor) => {
          editorRef.current = editor;
          services.editor.current = editor;
          onEditor?.(editor, editor ? doc : null);
        }}
      />
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

  useEffect(() => {
    if (!editing.current) setDraft(page.title);
  }, [page.title]);

  const commit = (value: string) => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
    if (value !== page.title) void session.updatePage(page.id, { title: value });
  };

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  return (
    <textarea
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
        commit(draft);
      }}
      onChange={(event) => {
        const value = event.target.value.replace(/\n/g, ' ');
        setDraft(value);
        if (pending.current !== null) clearTimeout(pending.current);
        pending.current = window.setTimeout(() => commit(value), 400);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit(draft);
          onEnter();
        }
      }}
    />
  );
}
