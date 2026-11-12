// A database with its views: the view tabs (add, rename, duplicate, delete, reorder), the
// toolbar (filter, sort, group, properties, wrap, search, New), notices (view only, rows on this
// device only, a failed fetch), and the active view, drawn by its type (views/registry.ts).
// Embedded in a page (a `databaseView` block) or as the database's own full page.
import {
  CgButton,
  CgContextMenu,
  CgTabs,
  type CgContextMenuActions,
  type CgContextMenuItem,
  type CgTabDescriptor,
} from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CellFlyout } from './cells/CellFlyout';
import { useCellEnv } from './cells/env';
import {
  DatabaseContext,
  useDatabase,
  useDatabaseContextValue,
  useHost,
  useRowSource,
  useViews,
} from './context';
import type { ViewRecord, ViewType } from './core';
import type { DatabaseHost, RowRequest } from './host';
import { useDbT } from './i18n';
import { propertyOf } from './model/properties';
import {
  conditionCount,
  emptyConfig,
  withCondition,
  withFilter,
  withGroup,
  withSorts,
} from './model/viewConfig';
import { MenuItem, MenuList } from './properties/MenuList';
import { FilterEditor, newCondition } from './toolbar/FilterEditor';
import { GroupEditor } from './toolbar/GroupEditor';
import { PropertiesEditor } from './toolbar/PropertiesEditor';
import { SortEditor } from './toolbar/SortEditor';
import { VIEW_ORDER, viewType } from './views/registry';
import { useViewsExtras } from './csv/extras';
import { rowTemplateItems } from './templates/rowTemplates';
import './database.css';

export interface DatabaseViewProps {
  host: DatabaseHost;
  databaseId: Id;
  /** The view shown first (a block's `viewId`); null or absent: the database's first view. */
  viewId?: Id | null;
  /** Told when the person picks another view (the shell may keep the choice per block). */
  onViewChange?(viewId: Id): void;
  /** Inside a page (its own scroll and a limited height) rather than the database's full page. */
  embedded?: boolean;
  /** False when the page around it is read-only; the host's `canEdit` decides the rest. */
  editable?: boolean;
  /** Shows the database's title above the tabs (default: when embedded). */
  showTitle?: boolean;
}

type Panel =
  | {
      kind: 'filter' | 'sort' | 'group' | 'properties' | 'addView' | 'layout';
      anchor: HTMLElement;
    }
  | { kind: 'rename'; anchor: HTMLElement; view: ViewRecord };

const SEARCH_DELAY = 250;

export function DatabaseView({
  host,
  databaseId,
  viewId = null,
  onViewChange,
  embedded = false,
  editable: pageEditable = true,
  showTitle,
}: DatabaseViewProps) {
  const { t } = useDbT();
  const database = useDatabase(host, databaseId);
  const storedViews = useViews(host, databaseId);
  const canEdit = useHost(host, () => host.canEdit(databaseId));
  const page = useHost(host, () => host.page(databaseId));
  const editable = pageEditable && canEdit;
  const context = useDatabaseContextValue(host, databaseId, editable);
  const env = useCellEnv(host, context.actions, editable);

  // A database with no view yet still shows a table: a view of that id is made by its first change.
  const [fallbackId] = useState(() => host.newId());
  const views = useMemo<ViewRecord[]>(() => {
    if (storedViews.length || !database) return storedViews;
    return [
      {
        id: fallbackId,
        workspaceId: database.workspaceId,
        databaseId,
        name: t('viewType.table'),
        type: 'table',
        orderKey: 'a0',
        config: emptyConfig('table'),
        version: 0,
        createdAt: database.createdAt,
      },
    ];
  }, [storedViews, database, fallbackId, databaseId, t]);

  const [chosen, setChosen] = useState<Id | null>(viewId);
  useEffect(() => setChosen(viewId), [viewId]);
  const view = views.find((v) => v.id === chosen) ?? views[0] ?? null;
  const pendingView = useRef<Id | null>(null);
  useEffect(() => {
    const id = pendingView.current;
    if (id && views.some((v) => v.id === id)) {
      pendingView.current = null;
      setChosen(id);
      onViewChange?.(id);
    }
  }, [views, onViewChange]);
  const choose = (id: Id) => {
    setChosen(id);
    onViewChange?.(id);
  };

  // ---- Search: the input is the browser's own; the query follows after a pause ------------------
  const [search, setSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const onSearchInput = (text: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(text.trim()), SEARCH_DELAY);
  };
  useEffect(() => () => void (searchTimer.current && clearTimeout(searchTimer.current)), []);

  // ---- Rows -------------------------------------------------------------------------------
  const request = useMemo<RowRequest | null>(
    () =>
      view && database
        ? {
            viewId: view.id,
            spec: {
              filter: view.config.filter,
              sorts: view.config.sorts,
              group: view.config.group,
              ...(search ? { search } : {}),
            },
            pageSize: 100,
          }
        : null,
    [view, database, search],
  );
  const { source, snapshot } = useRowSource(host, databaseId, request);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [newRowRequest, setNewRowRequest] = useState(0);
  const filterButton = useRef<HTMLButtonElement>(null);
  const viewMenu = useRef<CgContextMenuActions<ViewRecord>>(null);
  const templateMenu = useRef<CgContextMenuActions<null>>(null);
  const templates = useHost(host, () => host.rowTemplates(databaseId));
  // CSV import and export (views stream: csv/extras.tsx).
  const extras = useViewsExtras(host, databaseId, editable);

  if (!database || !view) {
    return (
      <section className="cgw-db" data-embedded={embedded || undefined}>
        <p className="cgw-db-notice">{database ? t('loading') : t('missing')}</p>
      </section>
    );
  }

  const definition = viewType(view.type);
  const View = definition.component;
  const actions = context.actions;
  const title = page?.title || t('untitledDatabase');
  const filters = conditionCount(view.config.filter);
  const groupDef = view.config.group
    ? propertyOf(database, view.config.group.propertyId)
    : undefined;

  const viewItems: CgContextMenuItem<ViewRecord>[] = [
    {
      key: 'rename',
      text: t('views.rename'),
      disabled: !editable,
      command: ({ invocation }) => {
        const anchor = document.querySelector<HTMLElement>(
          `[data-view-tab="${invocation.context.id}"]`,
        );
        if (anchor) setPanel({ kind: 'rename', anchor, view: invocation.context });
      },
    },
    {
      key: 'duplicate',
      text: t('views.duplicate'),
      disabled: !editable,
      command: async ({ invocation }) => {
        const id = await actions.duplicateView(
          invocation.context,
          t('views.copyName', { name: invocation.context.name }),
        );
        if (id) pendingView.current = id;
      },
    },
    {
      key: 'earlier',
      text: t('views.moveEarlier'),
      disabled: !editable || views.indexOf(view) <= 0,
      beginGroup: true,
      command: ({ invocation }) =>
        void actions.moveView(invocation.context, views.indexOf(invocation.context) - 1),
    },
    {
      key: 'later',
      text: t('views.moveLater'),
      disabled: !editable || views.indexOf(view) >= views.length - 1,
      command: ({ invocation }) =>
        void actions.moveView(invocation.context, views.indexOf(invocation.context) + 1),
    },
    {
      key: 'delete',
      text: t('views.delete'),
      intent: 'danger',
      beginGroup: true,
      disabled: !editable || storedViews.length <= 1,
      tooltip: storedViews.length <= 1 ? t('views.lastView') : undefined,
      command: ({ invocation }) => void actions.deleteView(invocation.context),
    },
    ...extras.menuItems,
  ];

  const createView = async (type: ViewType) => {
    setPanel(null);
    const base = t(`viewType.${type}`);
    const names = new Set(views.map((v) => v.name));
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    const id = await actions.createView(type, name, viewType(type).defaultConfig(database));
    if (id) pendingView.current = id;
  };

  const requestFilter = (propertyId: string) => {
    const def = propertyOf(database, propertyId);
    if (!def) return;
    void actions.updateView(view, withCondition(view.config, newCondition(database, def)));
    if (filterButton.current) setPanel({ kind: 'filter', anchor: filterButton.current });
  };

  const body: ReactNode = View ? (
    <View
      database={database}
      view={view}
      source={source}
      snapshot={snapshot}
      embedded={embedded}
      searching={search !== ''}
      newRowRequest={newRowRequest}
      requestFilter={editable ? requestFilter : undefined}
    />
  ) : (
    <div className="cgw-db-placeholder" role="note">
      {t('views.placeholder')}
    </div>
  );

  const tabs: CgTabDescriptor[] = views.map((v) => ({
    key: v.id,
    text: v.name || t(`viewType.${v.type}`),
    content: v.id === view.id ? body : null,
    contentClassName: 'cgw-db-panel',
    renderHeader: ({ tab }) => (
      <span className="cgw-view-tab" data-view-tab={v.id}>
        <span aria-hidden="true" className="cgw-view-glyph">
          {viewType(v.type).glyph}
        </span>
        <span dir="auto">{tab.text}</span>
      </span>
    ),
    headerAttributes: {
      onContextMenu: (event) => {
        event.preventDefault();
        void viewMenu.current?.showFromEvent(event, v);
      },
      onDoubleClick: (event) => {
        if (editable) setPanel({ kind: 'rename', anchor: event.currentTarget, view: v });
      },
      onKeyDown: (event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          void viewMenu.current?.showNear(event.currentTarget, v);
        } else if (event.key === 'F2' && editable) {
          event.preventDefault();
          setPanel({ kind: 'rename', anchor: event.currentTarget, view: v });
        }
      },
    },
  }));

  const toolbar = (
    <div className="cgw-db-toolbar" role="toolbar" aria-label={t('toolbar.label')}>
      {editable ? (
        <button
          type="button"
          className="cgw-icon-button"
          aria-label={t('views.add')}
          title={t('views.add')}
          onClick={(event) => setPanel({ kind: 'addView', anchor: event.currentTarget })}
        >
          <span aria-hidden="true">＋</span>
        </button>
      ) : null}
      <button
        type="button"
        className="cgw-icon-button"
        aria-label={t('views.menu', { name: view.name })}
        title={t('views.menu', { name: view.name })}
        onClick={(event) => void viewMenu.current?.showNear(event.currentTarget, view)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <span className="cgw-toolbar-gap" />
      <CgButton
        ref={filterButton}
        appearance="ghost"
        intent={filters ? 'primary' : 'neutral'}
        size="small"
        aria-haspopup="dialog"
        onClick={(event) => setPanel({ kind: 'filter', anchor: event.currentTarget })}
      >
        {filters ? t('toolbar.filterCount', { count: filters }) : t('toolbar.filter')}
      </CgButton>
      <CgButton
        appearance="ghost"
        intent={view.config.sorts.length ? 'primary' : 'neutral'}
        size="small"
        aria-haspopup="dialog"
        onClick={(event) => setPanel({ kind: 'sort', anchor: event.currentTarget })}
      >
        {view.config.sorts.length
          ? t('toolbar.sortCount', { count: view.config.sorts.length })
          : t('toolbar.sort')}
      </CgButton>
      {definition.supports.group ? (
        <CgButton
          appearance="ghost"
          intent={view.config.group ? 'primary' : 'neutral'}
          size="small"
          aria-haspopup="dialog"
          onClick={(event) => setPanel({ kind: 'group', anchor: event.currentTarget })}
        >
          {groupDef ? t('toolbar.groupBy', { name: groupDef.name }) : t('toolbar.group')}
        </CgButton>
      ) : null}
      {definition.supports.properties ? (
        <CgButton
          appearance="ghost"
          size="small"
          aria-haspopup="dialog"
          onClick={(event) => setPanel({ kind: 'properties', anchor: event.currentTarget })}
        >
          {t('toolbar.properties')}
        </CgButton>
      ) : null}
      {definition.settings ? (
        <CgButton
          appearance="ghost"
          size="small"
          aria-haspopup="dialog"
          onClick={(event) => setPanel({ kind: 'layout', anchor: event.currentTarget })}
        >
          {t('layout.button')}
        </CgButton>
      ) : null}
      {definition.supports.wrap ? (
        <button
          type="button"
          className="cgw-icon-button"
          aria-pressed={view.config.wrap === true}
          aria-label={t('toolbar.wrap')}
          title={view.config.wrap ? t('toolbar.noWrap') : t('toolbar.wrap')}
          disabled={!editable}
          onClick={() => void actions.updateView(view, { ...view.config, wrap: !view.config.wrap })}
        >
          <span aria-hidden="true">↵</span>
        </button>
      ) : null}
      <input
        ref={searchInput}
        type="search"
        className="cgw-db-search"
        aria-label={t('toolbar.searchLabel')}
        placeholder={t('toolbar.searchPlaceholder')}
        dir="auto"
        onChange={(event) => onSearchInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.value) {
            event.preventDefault();
            event.currentTarget.value = '';
            onSearchInput('');
          }
        }}
      />
      {editable ? (
        <span className="cgw-new-group">
          <CgButton intent="primary" size="small" onClick={() => setNewRowRequest((n) => n + 1)}>
            {t('toolbar.newRow')}
          </CgButton>
          {templates.length || editable ? (
            <button
              type="button"
              className="cgw-icon-button"
              aria-label={t('toolbar.newFromTemplate')}
              title={t('toolbar.newFromTemplate')}
              onClick={(event) => void templateMenu.current?.showNear(event.currentTarget, null)}
            >
              <span aria-hidden="true">▾</span>
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );

  const panelBody = (() => {
    if (!panel) return null;
    switch (panel.kind) {
      case 'filter':
        return (
          <FilterEditor
            database={database}
            filter={view.config.filter}
            editable={editable}
            onChange={(filter) => void actions.updateView(view, withFilter(view.config, filter))}
          />
        );
      case 'sort':
        return (
          <SortEditor
            database={database}
            sorts={view.config.sorts}
            editable={editable}
            onChange={(sorts) => void actions.updateView(view, withSorts(view.config, sorts))}
          />
        );
      case 'group':
        return (
          <GroupEditor
            database={database}
            group={view.config.group}
            shownKeys={snapshot.groups?.map((g) => g.key) ?? []}
            required={view.type === 'board'}
            editable={editable}
            env={env}
            onChange={(group) => void actions.updateView(view, withGroup(view.config, group))}
          />
        );
      case 'properties':
        return <PropertiesEditor database={database} view={view} />;
      case 'layout': {
        const Settings = definition.settings;
        return Settings ? <Settings database={database} view={view} /> : null;
      }
      case 'addView':
        return (
          <MenuList label={t('views.add')}>
            {VIEW_ORDER.map((type, i) => (
              <MenuItem
                key={type}
                glyph={viewType(type).glyph}
                initialFocus={i === 0}
                onSelect={() => void createView(type)}
              >
                {t(`viewType.${type}`)}
              </MenuItem>
            ))}
          </MenuList>
        );
      case 'rename':
        return (
          <input
            className="cgw-text-input"
            data-cg-initial-focus=""
            aria-label={t('views.name')}
            defaultValue={panel.view.name}
            dir="auto"
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name) void actions.renameView(panel.view, name);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                const name = event.currentTarget.value.trim();
                if (name) void actions.renameView(panel.view, name);
                setPanel(null);
              }
            }}
          />
        );
    }
  })();
  const panelLabel = panel
    ? {
        filter: t('filter.title'),
        sort: t('sort.title'),
        group: t('group.title'),
        properties: t('properties.title'),
        layout: t('layout.title'),
        addView: t('views.add'),
        rename: t('views.rename'),
      }[panel.kind]
    : '';

  const showsTitle = showTitle ?? embedded;
  return (
    <DatabaseContext.Provider value={context}>
      <section
        className="cgw-db"
        data-embedded={embedded || undefined}
        aria-label={title}
        aria-readonly={!editable || undefined}
      >
        {showsTitle ? (
          <div className="cgw-db-title">
            {page?.icon ? (
              <span className="cgw-db-icon" aria-hidden="true">
                {page.icon}
              </span>
            ) : null}
            <button
              type="button"
              className="cgw-db-title-text"
              title={t('openFull')}
              onClick={() => host.openPage(databaseId)}
            >
              <span dir="auto">{title}</span>
            </button>
            {!editable ? <span className="cgw-db-badge">{t('readOnly')}</span> : null}
          </div>
        ) : !editable ? (
          <div className="cgw-db-title">
            <span className="cgw-db-badge">{t('readOnly')}</span>
          </div>
        ) : null}
        {snapshot.localOnly ? (
          <p className="cgw-db-notice" role="status">
            {t('localOnly')}
          </p>
        ) : null}
        {snapshot.error ? (
          <p className="cgw-db-notice cgw-db-error" role="alert">
            {t('loadFailed')}{' '}
            <button type="button" className="cgw-text-button" onClick={() => source?.retry()}>
              {t('retry')}
            </button>
          </p>
        ) : null}
        <CgTabs
          className="cgw-db-tabs"
          tabs={tabs}
          activeKey={view.id}
          onActiveKeyChange={(key) => key && choose(key)}
          contentMode="active-only"
          scrollMode="native"
          size="small"
          reorderable={editable}
          onReorder={(details) => {
            const moved = views.find((v) => v.id === details.key);
            if (moved) void actions.moveView(moved, details.toIndex);
          }}
          ariaLabel={t('views.label')}
          labels={{ previousTabs: t('views.previous'), nextTabs: t('views.next') }}
          endContent={toolbar}
        />
        {panel ? (
          <CellFlyout
            anchor={panel.anchor}
            label={panelLabel}
            width={
              panel.kind === 'filter'
                ? 'min(560px, calc(100vw - 16px))'
                : panel.kind === 'rename'
                  ? 260
                  : 320
            }
            className={`cgw-db-panel-flyout cgw-db-panel-${panel.kind}`}
            onClose={() => setPanel(null)}
          >
            {panelBody}
          </CellFlyout>
        ) : null}
        <CgContextMenu<ViewRecord>
          items={viewItems}
          actionsRef={viewMenu}
          ariaLabel={t('views.menu', { name: view.name })}
        />
        <CgContextMenu<null>
          items={rowTemplateItems({ host, databaseId, view, templates, t, editable })}
          actionsRef={templateMenu}
          ariaLabel={t('toolbar.newFromTemplate')}
        />
        {extras.element}
      </section>
    </DatabaseContext.Provider>
  );
}
