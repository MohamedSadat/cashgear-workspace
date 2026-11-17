// Ctrl+K: search page titles and text, open a result, or run a command. Titles come from the
// mirror at once; text matches come from the local store's index (M1.8), normalised the same way.
// Drawn by the library's command menu (Track U1) in place, with its own search box.
// Phase 10: once the person pauses, with search by meaning on, the pages the words did not find
// that the question means follow under "Related by meaning" (`meaning.ts`), each marked so for a
// screen reader.
import { CgCommandMenu, type CgCommandMenuItem } from '@cashgear/ui';
import { normaliseText } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { Dialog } from '../Dialog';
import type { ShellDatabaseHost } from '../database/host';
import { pageGlyph } from '../database/make';
import { useAi } from '../ai/context';
import { openAi } from '../ai/open';
import { navigate, parseRoute } from '../route';
import { isRowRecord, type RemoteSearchHit, type WorkspaceSession } from '../session';
import { formatShortcut } from '../shortcuts';
import { relatedByMeaning, useMeaning } from './meaning';

interface Item {
  id: string;
  kind: 'page' | 'command';
  /** A page only meaning found (Phase 10). */
  meaning?: boolean;
  label: string;
  detail?: string;
  icon: string;
  shortcut?: string;
  run: () => void;
}

export function Palette({
  session,
  databases,
  onClose,
}: {
  session: WorkspaceSession;
  /** Finds a row a search hit names that this device does not hold yet (it is pulled). */
  databases?: ShellDatabaseHost | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const services = useShell();
  const [query, setQuery] = useState('');
  // The hits and the query they answer: while a search runs, the last hits stay in view.
  const [result, setResult] = useState<{ query: string; hits: RemoteSearchHit[] }>({
    query: '',
    hits: [],
  });
  const hits = result.hits;
  const workspaceId = session.workspaceId;
  // Until the results for what was typed are in, an Enter waits for them (the menu's `loading`).
  const ready = !workspaceId || result.query === normaliseText(query);
  // Phase 7: "Ask AI" about what was typed, answered in the AI panel of the page on screen.
  const ai = useAi(session, workspaceId);
  const route = parseRoute(location.hash);
  const aiPage = ai?.availability === 'ready' && route.kind === 'page' ? route.pageId : null;
  // Phase 10: the pages the question means, once the person pauses.
  const cloud = useCloud();
  const meaningHits = useMeaning(cloud, session, ai, query).hits;

  useEffect(() => {
    let live = true;
    const q = normaliseText(query);
    if (!workspaceId || !q) {
      setResult({ query: q, hits: [] });
      return;
    }
    const started = performance.now();
    void session.search(q, 20).then((found) => {
      if (!live) return;
      setResult({ query: q, hits: found });
      performance.measure('cgw-search', { start: started, end: performance.now() });
      // Then the account's: pages this device holds no text for, local hits first (M2.7). A row
      // this device does not hold (rows are not in the tree) is pulled from its database when
      // opened.
      void session.remoteSearch?.(q, 20).then((remote) => {
        if (!live || !remote.length) return;
        const seen = new Set(found.map((hit) => hit.pageId));
        const more = remote.filter(
          (hit) => !seen.has(hit.pageId) && !session.mirror.pages.get(hit.pageId)?.trashedAt,
        );
        if (more.length) setResult({ query: q, hits: [...found, ...more].slice(0, 30) });
      });
    });
    return () => {
      live = false;
    };
  }, [query, session, workspaceId]);

  const items = useMemo<Item[]>(() => {
    const close = (run: () => void) => () => {
      onClose();
      run();
    };
    const pageItem = (hit: RemoteSearchHit, byMeaning: boolean): Item => {
      const page = session.record(hit.pageId);
      const row = isRowRecord(page) ? page : null;
      const databaseId = row?.databaseId ?? hit.databaseId ?? null;
      const database = databaseId ? session.mirror.pages.get(databaseId) : undefined;
      const open = () => {
        // A hit the mirror has no page for is a row, unless the server says it is not.
        const pulled = !page && (hit.kind ?? 'row') === 'row';
        if (!pulled || !databases) return navigate({ kind: 'page', pageId: hit.pageId });
        // A row this device does not hold: the row is pulled from its database first.
        void databases
          .locateRow(hit.pageId, hit.title, databaseId)
          .catch(() => false)
          .then(() => navigate({ kind: 'page', pageId: hit.pageId }));
      };
      return {
        id: `${byMeaning ? 'meaning' : 'page'}:${hit.pageId}`,
        kind: 'page',
        ...(byMeaning ? { meaning: true } : {}),
        label: page?.title || hit.title || t('page.untitled'),
        detail:
          hit.snippet ||
          (database
            ? t('databases.rowIn', { database: database.title || t('database.untitledDatabase') })
            : undefined),
        icon: pageGlyph(page),
        run: close(open),
      };
    };
    const pages: Item[] = hits.map((hit) => pageItem(hit, false));
    // Phase 10: what meaning adds, once the words' results for the same text are in.
    if (query.trim() && ready)
      for (const hit of relatedByMeaning(
        hits,
        meaningHits,
        (id) => !!session.mirror.pages.get(id)?.trashedAt,
      ))
        pages.push(pageItem(hit, true));
    if (!query.trim())
      for (const page of workspaceId ? session.mirror.recentOf(workspaceId, 6) : [])
        pages.push({
          id: `page:${page.id}`,
          kind: 'page',
          label: page.title || t('page.untitled'),
          icon: pageGlyph(page),
          run: close(() => navigate({ kind: 'page', pageId: page.id })),
        });
    const context = { services, toggleSidebar: () => {} };
    const commands: Item[] = services.commands
      .list(context, query, ['app', 'navigation', 'page'])
      .filter((command) => command.id !== 'app.search')
      .slice(0, query ? 8 : 5)
      .map((command) => ({
        id: `command:${command.id}`,
        kind: 'command',
        label: command.label(),
        icon: '›',
        shortcut: command.shortcut ? formatShortcut(command.shortcut) : undefined,
        run: close(() => void services.commands.run(command.id, context)),
      }));
    const asks: Item[] =
      aiPage && query.trim()
        ? [
            {
              id: 'ai:ask',
              kind: 'command',
              label: t('ai.askAbout', { query: query.trim() }),
              icon: '✦',
              run: close(() => openAi({ pageId: aiPage, action: 'ask', question: query.trim() })),
            },
          ]
        : [];
    return [...pages, ...asks, ...commands];
  }, [
    hits,
    query,
    session,
    services,
    t,
    onClose,
    workspaceId,
    databases,
    aiPage,
    ready,
    meaningHits,
  ]);

  // Pages first (the results, or the recent pages before anything is typed), then those related
  // by meaning, then the commands: each kind a named group, in this order.
  const menuItems = useMemo<CgCommandMenuItem<Item>[]>(() => {
    const pagesGroup = t(query ? 'search.pages' : 'workspace.recent');
    return items.map((item) => ({
      key: item.id,
      label: item.label,
      group: item.meaning
        ? t('ai.meaningGroup')
        : item.kind === 'page'
          ? pagesGroup
          : t('search.commands'),
      // An element, so a page's icon is always drawn as written (a lowercase word would be read
      // as one of the library's icon names).
      icon: <span>{item.icon}</span>,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.shortcut ? { shortcut: item.shortcut } : {}),
      data: item,
    }));
  }, [items, query, t]);

  return (
    <Dialog title={t('search.title')} onClose={onClose}>
      {/* The dialog focuses the search box; Escape reaches the dialog, which closes. */}
      <CgCommandMenu<Item>
        items={menuItems}
        filter={false}
        searchable
        searchLabel={t('search.placeholder')}
        searchPlaceholder={t('search.placeholder')}
        query={query}
        onQueryChange={setQuery}
        loading={!ready}
        label={t('search.results')}
        emptyText={t('search.noResults')}
        maxHeight="52vh"
        onSelect={(item) => item.data?.run()}
        renderItem={({ item, defaultContent }) =>
          item.data?.meaning ? (
            <>
              {defaultContent}
              <span className="cgw-visually-hidden" data-testid="meaning-mark">
                {t('ai.meaningMark')}
              </span>
            </>
          ) : (
            defaultContent
          )
        }
      />
    </Dialog>
  );
}
