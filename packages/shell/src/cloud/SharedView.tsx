// `#/s/{token}`: a page shared by link (M2.6), read without an account. The token goes only in a
// request header (it is in the address's hash, which browsers never send), and the page is drawn
// read-only from its document; nothing is stored on this device.
import { fragmentToJSON, type DocJSON } from '@cgw/doc';
import { BlockEditorView, type EditorHost, type EditorStrings } from '@cgw/editor';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { navigate } from '../route';
import { fromBase64 } from '@cgw/workspace';

interface SharedPage {
  id: string;
  title: string;
  icon: string | null;
  parentPageId?: string | null;
  orderKey?: string;
}

async function call<T>(apiBase: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${apiBase}/api/v1/shared${path}`, {
    headers: { 'X-Share-Token': token },
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as T;
}

/** The page's document from the shared pull: the snapshot (by its signed URL) and the updates. */
async function loadDoc(apiBase: string, token: string, pageId: string): Promise<DocJSON> {
  const doc = new Y.Doc();
  let after = 0;
  for (;;) {
    const pull = await call<{
      cursor: number | string;
      more: boolean;
      snapshot: { url: string } | null;
      updates: { data: string }[];
    }>(apiBase, token, `/pages/${pageId}/doc?after=${after}`);
    if (pull.snapshot) {
      const response = await fetch(pull.snapshot.url, { credentials: 'omit' });
      if (response.ok) Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
    }
    for (const update of pull.updates) Y.applyUpdate(doc, fromBase64(update.data));
    after = Number(pull.cursor);
    if (!pull.more) break;
  }
  const json = fragmentToJSON(doc.getXmlFragment('content'));
  doc.destroy();
  return json;
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
  const { t } = useTranslation();
  const [tree, setTree] = useState<{ page: SharedPage; pages: SharedPage[] } | null>(null);
  const [content, setContent] = useState<{ id: string; json: DocJSON } | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = pageId ?? tree?.page.id ?? null;
  // Images of the shared pages, by the link's own signed URLs; titles of linked pages if shared.
  const host: EditorHost = {
    strings: t('editor', { returnObjects: true }) as unknown as EditorStrings,
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
    void loadDoc(apiBase, token, shown).then(
      (json) => live && setContent({ id: shown, json }),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [apiBase, token, shown]);

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
