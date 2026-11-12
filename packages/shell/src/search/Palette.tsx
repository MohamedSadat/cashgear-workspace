// Ctrl+K: search page titles and text, open a result, or run a command. Titles come from the
// mirror at once; text matches come from the local store's index (M1.8), normalised the same way.
import { normaliseText, type SearchHit } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell } from '../context';
import { Dialog } from '../Dialog';
import type { ShellDatabaseHost } from '../database/host';
import { pageGlyph } from '../database/make';
import { navigate } from '../route';
import { isRowRecord, type WorkspaceSession } from '../session';
import { formatShortcut } from '../shortcuts';

interface Item {
  id: string;
  kind: 'page' | 'command';
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
  const [result, setResult] = useState<{ query: string; hits: SearchHit[] }>({
    query: '',
    hits: [],
  });
  const hits = result.hits;
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const workspaceId = session.workspaceId;
  const ready = !workspaceId || result.query === normaliseText(query);
  // Enter pressed before the results for what was typed are in: it acts when they arrive.
  const enterWhenReady = useRef(false);

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
      // Then the account's: pages this device holds no text for, local hits first (M2.7). A hit
      // the mirror has no page for is a row (rows are not in the tree); it is found when opened.
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
    const pages: Item[] = hits.map((hit) => {
      const page = session.record(hit.pageId);
      const row = isRowRecord(page) ? page : null;
      const database = row ? session.mirror.pages.get(row.databaseId) : undefined;
      const open = () => {
        if (session.mirror.pages.has(hit.pageId) || row || !databases)
          return navigate({ kind: 'page', pageId: hit.pageId });
        // A row this device does not hold: its database is found and the row pulled first.
        void databases
          .locateRow(hit.pageId, hit.title)
          .catch(() => false)
          .then(() => navigate({ kind: 'page', pageId: hit.pageId }));
      };
      return {
        id: `page:${hit.pageId}`,
        kind: 'page',
        label: page?.title || hit.title || t('page.untitled'),
        detail:
          hit.snippet ||
          (database
            ? t('databases.rowIn', { database: database.title || t('database.untitledDatabase') })
            : undefined),
        icon: pageGlyph(page),
        run: close(open),
      };
    });
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
    return [...pages, ...commands];
  }, [hits, query, session, services, t, onClose, workspaceId, databases]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!enterWhenReady.current || !ready) return;
    enterWhenReady.current = false;
    items[active]?.run();
  }, [ready, items, active]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      enterWhenReady.current = false;
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      enterWhenReady.current = false;
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (ready) items[active]?.run();
      else enterWhenReady.current = true;
    }
  };

  const pages = items.filter((i) => i.kind === 'page');
  const commands = items.filter((i) => i.kind === 'command');
  const row = (item: Item) => {
    const index = items.indexOf(item);
    return (
      <div
        key={item.id}
        id={`cgw-palette-${index}`}
        role="option"
        aria-selected={index === active}
        className="cgw-palette-item"
        onMouseEnter={() => setActive(index)}
        onClick={item.run}
      >
        <span className="cgw-palette-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="cgw-palette-text">
          <span className="cgw-palette-label" dir="auto">
            {item.label}
          </span>
          {item.detail && (
            <span className="cgw-palette-detail" dir="auto">
              {item.detail}
            </span>
          )}
        </span>
        {item.shortcut && <kbd className="cgw-kbd">{item.shortcut}</kbd>}
      </div>
    );
  };

  return (
    <Dialog title={t('search.title')} onClose={onClose}>
      <input
        className="cgw-palette-input cgw-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="cgw-palette-list"
        aria-activedescendant={items.length ? `cgw-palette-${active}` : undefined}
        aria-label={t('search.placeholder')}
        placeholder={t('search.placeholder')}
        autoFocus
        dir="auto"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div
        ref={list}
        id="cgw-palette-list"
        role="listbox"
        aria-label={t('search.results')}
        className="cgw-palette-list"
      >
        {pages.length > 0 && (
          <div role="group" aria-label={t(query ? 'search.pages' : 'workspace.recent')}>
            <div className="cgw-palette-group">
              {t(query ? 'search.pages' : 'workspace.recent')}
            </div>
            {pages.map(row)}
          </div>
        )}
        {commands.length > 0 && (
          <div role="group" aria-label={t('search.commands')}>
            <div className="cgw-palette-group">{t('search.commands')}</div>
            {commands.map(row)}
          </div>
        )}
        {items.length === 0 && <div className="cgw-palette-empty">{t('search.noResults')}</div>}
      </div>
    </Dialog>
  );
}
