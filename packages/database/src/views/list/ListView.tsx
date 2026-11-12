// The list view: one line per row (its title, then the view's shown properties that have a value),
// optionally in collapsible groups with counts, virtualised at fixed heights (only the lines in
// the window and an overscan are drawn). One line is in the tab order; the arrows, Home, End,
// PageUp and PageDown move between lines, Enter opens a row (or a group, "Load more", "New"),
// Shift+F10 opens a row's menu. "New" types a title in place; the row is made on Enter.
import { CgContextMenu, type CgContextMenuActions, type CgContextMenuItem } from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { renderCell } from '../../cells/CellDisplay';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import { TITLE_PROPERTY, type PropertyDef } from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { propertyOf, shownProperties } from '../../model/properties';
import { buildItems, type TableItem } from '../../table/items';
import { layoutOf, revealScroll, sameRange, visibleRange, type Range } from '../../table/windowing';
import { cardLines } from '../board/layout';
import { draftRow } from '../board/shared';
import { GroupLabel, groupText } from '../GroupLabel';
import type { ViewProps } from '../types';
import { LIST_OVERSCAN, listItemHeight, listMove } from './layout';
import '../board/card.css';
import './list.css';

export function ListView({
  database,
  view,
  source,
  snapshot,
  embedded,
  searching,
  newRowRequest,
}: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const config = view.config;
  const shown = useMemo(
    () => shownProperties(database, config, true).filter((p) => p.id !== TITLE_PROPERTY),
    [database, config],
  );
  const titleDef = database.properties.find((p) => p.id === TITLE_PROPERTY);
  const group = useMemo(
    () =>
      config.group
        ? { rule: config.group, def: propertyOf(database, config.group.propertyId) }
        : null,
    [config.group, database],
  );

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<string | null | undefined>(undefined);
  const items = useMemo(
    () => buildItems(snapshot, collapsed, editable),
    [snapshot, collapsed, editable],
  );
  const layout = useMemo(() => layoutOf(items.length, (i) => listItemHeight(items[i])), [items]);

  // ---- The window ---------------------------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>({ start: 0, end: 30 });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = visibleRange(layout, el.scrollTop, el.clientHeight || 600, LIST_OVERSCAN);
    setRange((prev) => (sameRange(prev, next) ? prev : next));
  }, [layout]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // A "Load more" line that comes into the window fetches the next page.
  useEffect(() => {
    if (snapshot.loading || !source) return;
    for (let i = range.start; i < Math.min(range.end, items.length); i++) {
      const item = items[i];
      if (item.kind === 'more') {
        source.loadMore(item.group ?? undefined);
        return;
      }
    }
  }, [range, items, snapshot.loading, source]);

  // ---- Focus -----------------------------------------------------------------------------------
  const [active, setActive] = useState(0);
  const activeIndex = Math.max(0, Math.min(active, items.length - 1));
  const pendingFocus = useRef<number | null>(null);
  const focusItem = (index: number) => {
    setActive(index);
    pendingFocus.current = index;
    const el = scroller.current;
    if (el) {
      const top = revealScroll(layout, index, el.scrollTop, el.clientHeight, 0);
      if (top !== null) el.scrollTop = top;
    }
  };
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-item="${index}"]`);
    const focusable = target?.matches('[data-focus]')
      ? target
      : target?.querySelector<HTMLElement>('[data-focus]');
    if (focusable) {
      pendingFocus.current = null;
      focusable.focus({ preventScroll: true });
    }
  });

  // ---- Actions -----------------------------------------------------------------------------------
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    setDraft(snapshot.groups ? (snapshot.groups[0]?.key ?? null) : null);
  }, [newRowRequest, snapshot.groups]);
  const activate = (item: TableItem) => {
    if (item.kind === 'row') host.openRow(item.row.id);
    else if (item.kind === 'group') toggle(item.group);
    else if (item.kind === 'more') source?.loadMore(item.group ?? undefined);
    else setDraft(item.group);
  };

  const rowMenu = useRef<CgContextMenuActions<RowRecord>>(null);
  const rowItems = useMemo<CgContextMenuItem<RowRecord>[]>(
    () => [
      {
        key: 'open',
        text: t('row.open'),
        command: ({ invocation }) => host.openRow(invocation.context.id),
      },
      {
        key: 'duplicate',
        text: t('row.duplicate'),
        disabled: !editable,
        command: ({ invocation }) => void actions.duplicateRow(invocation.context),
      },
      {
        key: 'delete',
        text: t('row.delete'),
        intent: 'danger',
        disabled: !editable,
        beginGroup: true,
        command: ({ invocation }) => void actions.trashRow(invocation.context),
      },
    ],
    [t, host, actions, editable],
  );

  const indexOf = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-item]');
    return el ? Number(el.dataset.item) : -1;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[data-focus]')) return;
    const index = indexOf(target);
    const item = items[index];
    if (!item) return;
    if (event.key === 'Enter' || (event.key === ' ' && item.kind !== 'row')) {
      event.preventDefault();
      activate(item);
      return;
    }
    if (
      item.kind === 'row' &&
      (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
    ) {
      event.preventDefault();
      void rowMenu.current?.showNear(target, item.row);
      return;
    }
    const pageSize = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 600) / 36) - 1);
    const next = listMove(index, items.length, event.key, pageSize);
    if (next === null) return;
    event.preventDefault();
    focusItem(next);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = indexOf(event.target);
    if (index >= 0 && index !== active) setActive(index);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const el = target.closest<HTMLElement>('[data-focus]');
    const item = el ? items[indexOf(el)] : undefined;
    if (!el || !item) return;
    // A chip, a link or a checkbox in a row's line does its own thing.
    if (el.dataset.focus === 'row' && target.closest('button, a, input, [role="checkbox"]')) return;
    activate(item);
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const item = items[indexOf(event.target)];
    if (item?.kind !== 'row') return;
    event.preventDefault();
    void rowMenu.current?.showFromEvent(event as MouseEvent<HTMLElement>, item.row);
  };

  // ---- Drawing -------------------------------------------------------------------------------------
  const drawn: number[] = [];
  for (let i = range.start; i < Math.min(range.end, items.length); i++) drawn.push(i);
  if (activeIndex >= 0 && activeIndex < items.length && !drawn.includes(activeIndex))
    drawn.push(activeIndex);
  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const empty = snapshot.complete && !snapshot.loading && snapshot.rows.length === 0;

  return (
    <div className={`cgw-list${embedded ? ' is-embedded' : ''}`}>
      <div
        ref={scroller}
        className="cgw-list-scroll"
        onScroll={measure}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div
          role="list"
          aria-label={t('list.label', { name })}
          aria-busy={snapshot.loading || undefined}
          className="cgw-list-body"
          style={{ blockSize: layout.total }}
        >
          {drawn.map((i) => {
            const item = items[i];
            const style = {
              insetBlockStart: layout.offsets[i],
              blockSize: layout.offsets[i + 1] - layout.offsets[i],
            };
            const isActive = i === activeIndex;
            const common = {
              'data-item': i,
              role: 'listitem',
              'aria-setsize': snapshot.complete ? items.length : -1,
              'aria-posinset': i + 1,
              style,
            };
            if (item.kind === 'row')
              return (
                <ListLine
                  key={item.key}
                  item={item}
                  common={common}
                  active={isActive}
                  shown={shown}
                  env={env}
                />
              );
            if (item.kind === 'group') {
              const label = group ? groupText(group.def, group.rule, item.group, env) : item.group;
              return (
                <div key={item.key} className="cgw-list-group" {...common}>
                  <button
                    type="button"
                    data-focus="group"
                    tabIndex={isActive ? 0 : -1}
                    className="cgw-list-group-button"
                    aria-expanded={!item.collapsed}
                    aria-label={t(item.collapsed ? 'group.expand' : 'group.collapse', {
                      name: label,
                    })}
                  >
                    <span aria-hidden="true" className="cgw-list-chevron">
                      ▾
                    </span>
                    {group ? (
                      <GroupLabel
                        def={group.def}
                        rule={group.rule}
                        groupKey={item.group}
                        env={env}
                      />
                    ) : null}
                    <span className="cgw-list-count">{item.count.toLocaleString(env.locale)}</span>
                  </button>
                </div>
              );
            }
            if (item.kind === 'more')
              return (
                <div key={item.key} className="cgw-list-more" {...common}>
                  <button
                    type="button"
                    data-focus="more"
                    tabIndex={isActive ? 0 : -1}
                    className="cgw-text-button"
                  >
                    {t('list.loadMore')}
                  </button>
                </div>
              );
            const label =
              group && item.group !== null
                ? groupText(group.def, group.rule, item.group, env)
                : null;
            return (
              <div key={item.key} className="cgw-list-new" {...common}>
                {draft === item.group && titleDef ? (
                  <InlineEditor
                    def={titleDef}
                    row={draftRow(database)}
                    env={env}
                    label={t('card.newLabel')}
                    className="cgw-list-input"
                    commit={(value) => {
                      if (typeof value === 'string' && value.trim())
                        void actions.createRow({ title: value, view, groupKey: item.group });
                    }}
                    onDone={() => {
                      setDraft(undefined);
                      pendingFocus.current = i;
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    data-focus="new"
                    tabIndex={isActive ? 0 : -1}
                    className="cgw-board-new"
                    aria-label={label ? t('list.newRowIn', { name: label }) : t('list.newRow')}
                  >
                    <span aria-hidden="true">＋ </span>
                    {t('list.newRow')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {empty ? (
          <p className="cgw-list-empty">
            {searching || (config.filter?.children.length ?? 0) > 0
              ? t('list.noMatch')
              : t('list.empty')}
          </p>
        ) : null}
      </div>
      <div className="cgw-table-foot" role="status">
        {snapshot.complete
          ? t('rowCount', { count: snapshot.total })
          : t('rowsShown', {
              shown: new Set(snapshot.rows.map((r) => r.id)).size,
              total: snapshot.total,
            })}
      </div>
      <CgContextMenu<RowRecord> items={rowItems} actionsRef={rowMenu} ariaLabel={t('row.menu')} />
    </div>
  );
}

interface LineProps {
  item: Extract<TableItem, { kind: 'row' }>;
  common: Record<string, unknown>;
  active: boolean;
  shown: readonly PropertyDef[];
  env: CellEnv;
}

/** One row's line: drawn again only when its row, its place or its focus changes. */
const ListLine = memo(
  function ListLine({ item, common, active, shown, env }: LineProps) {
    const { row } = item;
    return (
      <div
        {...common}
        className="cgw-list-row"
        data-focus="row"
        tabIndex={active ? 0 : -1}
        aria-label={row.title || env.t('untitled')}
      >
        <span className="cgw-list-title">
          {row.icon ? (
            <span className="cgw-card-icon" aria-hidden="true">
              {row.icon}
            </span>
          ) : null}
          <span className={row.title ? undefined : 'cgw-card-untitled'} dir="auto">
            {row.title || env.t('untitled')}
          </span>
        </span>
        <span className="cgw-list-props">
          {cardLines(row, shown).map((def) => (
            <span key={def.id} className="cgw-list-prop" title={def.name}>
              {renderCell(def, row, env)}
            </span>
          ))}
        </span>
      </div>
    );
  },
  (a, b) =>
    a.item === b.item &&
    a.active === b.active &&
    a.shown === b.shown &&
    a.env === b.env &&
    sameStyle(a.common, b.common),
);

const sameStyle = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const sa = a.style as { insetBlockStart: number; blockSize: number };
  const sb = b.style as { insetBlockStart: number; blockSize: number };
  return (
    sa.insetBlockStart === sb.insetBlockStart &&
    sa.blockSize === sb.blockSize &&
    a['aria-setsize'] === b['aria-setsize'] &&
    a['aria-posinset'] === b['aria-posinset']
  );
};
