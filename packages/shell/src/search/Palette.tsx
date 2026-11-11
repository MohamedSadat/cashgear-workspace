// Ctrl+K: search page titles and text, open a result, or run a command. Titles come from the
// mirror at once; text matches come from the local store's index (M1.8), normalised the same way.
import { normaliseText, type SearchHit } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell } from '../context';
import { Dialog } from '../Dialog';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
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

export function Palette({ session, onClose }: { session: WorkspaceSession; onClose: () => void }) {
  const { t } = useTranslation();
  const services = useShell();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const workspaceId = session.workspaceId;

  useEffect(() => {
    let live = true;
    const q = normaliseText(query);
    if (!workspaceId || !q) {
      setHits([]);
      return;
    }
    const started = performance.now();
    void session.search(q, 20).then((found) => {
      if (!live) return;
      setHits(found);
      performance.measure('cgw-search', { start: started, end: performance.now() });
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
      const page = session.mirror.pages.get(hit.pageId);
      return {
        id: `page:${hit.pageId}`,
        kind: 'page',
        label: page?.title || hit.title || t('page.untitled'),
        detail: hit.snippet,
        icon: page?.icon ?? '📄',
        run: close(() => navigate({ kind: 'page', pageId: hit.pageId })),
      };
    });
    if (!query.trim())
      for (const page of workspaceId ? session.mirror.recentOf(workspaceId, 6) : [])
        pages.push({
          id: `page:${page.id}`,
          kind: 'page',
          label: page.title || t('page.untitled'),
          icon: page.icon ?? '📄',
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
  }, [hits, query, session, services, t, onClose, workspaceId]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      items[active]?.run();
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
