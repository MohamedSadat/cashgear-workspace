// `#/s/{token}`: a page shared by link (M2.6), read without an account. The token goes only in a
// request header (it is in the address's hash, which browsers never send), and the page is drawn
// read-only from the worker's JSON of its document (never its Yjs updates, which still hold text
// deleted since the last compaction); nothing is stored on this device.
import { knownTypes, readableJSON, type DocJSON } from '@cgw/doc';
import { BlockEditorView, type EditorHost, type EditorStrings } from '@cgw/editor';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate } from '../route';
import { noAccessWorkbooks } from '../sheet/shared';

interface SharedPage {
  id: string;
  title: string;
  icon: string | null;
  parentPageId?: string | null;
  orderKey?: string;
}

class SharedError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

async function call<T>(apiBase: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${apiBase}/api/v1/shared${path}`, {
    headers: { 'X-Share-Token': token },
    credentials: 'omit',
  });
  if (!response.ok) throw new SharedError(response.status);
  return (await response.json()) as T;
}

/** A page written a moment ago is derived by the worker within seconds: asked again this often. */
const RETRIES = 5;
const RETRY_MS = 1500;

/**
 * The page's document as the worker derived it (the JSON `fragmentToJSON` gives). A 404 is a page
 * not derived yet, asked for again a few times; past that, or for any other answer, it fails.
 */
async function loadDoc(
  apiBase: string,
  token: string,
  pageId: string,
  live: () => boolean,
): Promise<DocJSON> {
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await call<{ json: string }>(apiBase, token, `/pages/${pageId}/json`);
      return JSON.parse(answer.json) as DocJSON;
    } catch (error) {
      if (!(error instanceof SharedError) || error.status !== 404 || attempt >= RETRIES || !live())
        throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

export function SharedView({
  apiBase,
  token,
  pageId,
}: {
  apiBase: string;
  token: string;
  pageId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [tree, setTree] = useState<{ page: SharedPage; pages: SharedPage[] } | null>(null);
  const [content, setContent] = useState<{ id: string; json: DocJSON } | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = pageId ?? tree?.page.id ?? null;
  // Images of the shared pages, by the link's own signed URLs; titles of linked pages if shared.
  const host: EditorHost = {
    strings: t('editor', { returnObjects: true }) as unknown as EditorStrings,
    locale: i18n.language,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    assets: {
      url: async (assetId) => {
        try {
          const answer = await call<{ url: string }>(apiBase, token, `/assets/${assetId}/url`);
          return answer.url;
        } catch {
          return null;
        }
      },
      info: () => undefined,
      store: async () => null,
      pick: async () => [],
      open: () => undefined,
    },
    // A database block: no shared route for databases in Phase 4, so it says where it is shown.
    databases: {
      mount: (element) => {
        const note = document.createElement('p');
        note.className = 'cgw-db-shared-note';
        note.setAttribute('role', 'note');
        note.textContent = t('databases.sharedPlaceholder');
        element.appendChild(note);
        return () => note.remove();
      },
    },
    // A workbook is never shared outside its workspace: no picture, only that (Phase 5).
    workbooks: noAccessWorkbooks(t('sheets.noAccess')),
    pages: {
      title: (id) => tree?.pages.find((p) => p.id === id)?.title,
      icon: (id) => tree?.pages.find((p) => p.id === id)?.icon,
      exists: (id) => !!tree?.pages.some((p) => p.id === id),
      open: (id) => navigate({ kind: 'shared', token, pageId: id }),
      create: async () => null,
      search: () => [],
      subscribe: () => () => {},
    },
  };

  useEffect(() => {
    void call<{ page: SharedPage; pages: SharedPage[] }>(apiBase, token, '').then(setTree, () =>
      setFailed(true),
    );
  }, [apiBase, token]);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    // Unknown blocks (a newer document) are drawn as a note, as a newer page is in the app.
    void loadDoc(apiBase, token, shown, () => live).then(
      (json) =>
        live &&
        setContent({
          id: shown,
          json: readableJSON(json, knownTypes(), t('editor.readOnlyBlock')),
        }),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [apiBase, token, shown, t]);

  if (failed)
    return (
      <main className="cgw-empty" role="alert">
        <h1>{t('share.sharedGone')}</h1>
      </main>
    );
  const page = tree?.pages.find((p) => p.id === shown) ?? tree?.page;
  const children = tree?.pages.filter((p) => p.parentPageId === shown) ?? [];
  return (
    <main className="cgw-shared" aria-labelledby="cgw-shared-title">
      <p className="cgw-muted" role="note">
        {t('share.sharedNote')}
      </p>
      <h1 id="cgw-shared-title" className="cgw-shared-title">
        {page?.icon ? `${page.icon} ` : ''}
        {page?.title || t('page.untitled')}
      </h1>
      {content && content.id === shown ? (
        <BlockEditorView
          host={host}
          key={content.id}
          readOnlyContent={content.json as never}
          label={t('share.sharedTitle')}
          className="cgw-shared-editor"
        />
      ) : (
        <p aria-busy="true">{t('app.loading')}</p>
      )}
      {children.length > 0 && (
        <ul className="cgw-shared-children">
          {children.map((child) => (
            <li key={child.id}>
              <a
                href={`#/s/${token}/${child.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ kind: 'shared', token, pageId: child.id });
                }}
              >
                {child.icon ? `${child.icon} ` : ''}
                {child.title || t('page.untitled')}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
