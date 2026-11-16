// The board view: a column per group of the view's group property (select or status by default;
// any groupable one), drawn by the library's `CgKanbanBoard`. Each column has its count, its
// group's own label (an option's chip, a person), a menu that hides it, a "New" card preset to its
// group (the title typed in a draft card before the row exists, so an abandoned "New" leaves no
// row behind) and, while its rows come in pages, "Load more" (the next page is also asked for when
// its last card comes into view). Empty groups show (unless the rule hides them), hidden groups
// are listed at the end, a column can be collapsed. Long columns draw only the cards in view.
//
// A card moves by pointer (a copy follows the pointer, a line shows where it lands) or by the
// keys (Space picks it up, the arrows carry it, mirrored in RTL, Space drops it, Escape cancels),
// or from its handle's menu. Into another column: one `row.update` of the group property (and a
// `page.move` when its place there needs a new order key); within a column: a `page.move` with
// `host.rowOrderKey`. With a sort, cards keep the sort's order: a move only changes the column.
//
// Columns move too (Phase 8): a drag of a column's header, its grip by the keys, or the grip's
// menu. The order is the view's (`GroupRule.order`, one `view.upsert`), so it reaches other
// devices as the view's settings do and leaves the property's options as they are.
import {
  CgContextMenu,
  CgKanbanBoard,
  type CgContextMenuActions,
  type CgContextMenuItem,
  type CgKanbanBoardLabels,
  type CgKanbanCard,
  type CgKanbanColumn,
} from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv, type CellEnv } from '../../cells/env';
import { TITLE_PROPERTY, type DatabaseRecord, type ViewRecord } from '../../core';
import { useDatabaseContext } from '../../context';
import type { RowGroup } from '../../host';
import { useDbT } from '../../i18n';
import {
  isGroupable,
  liveProperties,
  propertyOf,
  shownProperties,
  uniqueName,
} from '../../model/properties';
import { withGroup, withGroupHidden, withGroupOrder } from '../../model/viewConfig';
import { newPropertyDef } from '../../properties/defs';
import { GroupLabel, groupText } from '../GroupLabel';
import type { ViewProps } from '../types';
import { CardContent } from './Card';
import {
  CARD_GAP,
  cardHeight,
  movableGroup,
  movedGroupValue,
  movedOrder,
  needsMove,
  orderedGroups,
  placeAt,
} from './layout';
import { draftRow } from './shared';
import './board.css';
import './card.css';

/** A card's row, and the column (group) it is drawn in: a row may be in several. */
interface CardData {
  row: RowRecord;
  group: string;
}

export function BoardView({
  database,
  view,
  source,
  snapshot,
  embedded,
  newRowRequest,
}: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t, rtl, locale } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const config = view.config;
  const rule = config.group;
  const groupDef = rule ? propertyOf(database, rule.propertyId) : undefined;
  const titleDef = database.properties.find((p) => p.id === TITLE_PROPERTY);
  const shown = useMemo(() => shownProperties(database, config, true), [database, config]);
  const sorted = config.sorts.length > 0;
  const crossColumns = editable && movableGroup(groupDef);
  const draggable = editable && (crossColumns || !sorted);

  const order = rule?.order;
  const groups = useMemo(
    () => orderedGroups(snapshot.groups ?? [], order),
    [snapshot.groups, order],
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const hidden = rule?.hidden;

  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);

  // ---- What the board draws ---------------------------------------------------------------
  const columns = useMemo<CgKanbanColumn<RowGroup>[]>(() => {
    if (!rule) return [];
    const drawn = new Set(groups.map((g) => g.key));
    return [
      ...groups.map((g) => ({
        key: g.key,
        title: groupText(groupDef, rule, g.key, env),
        count: g.count,
        data: g,
      })),
      ...(hidden ?? [])
        .filter((key) => !drawn.has(key))
        .map((key) => ({ key, title: groupText(groupDef, rule, key, env), hidden: true })),
    ];
  }, [groups, hidden, groupDef, rule, env]);
  const cards = useMemo<CgKanbanCard<CardData>[]>(
    () =>
      groups.flatMap((g) =>
        g.rows.map((row, index) => ({
          key: `${g.key}:${row.id}`,
          columnKey: g.key,
          label: row.title || t('untitled'),
          order: index,
          size: cardHeight(row, shown),
          data: { row, group: g.key },
        })),
      ),
    [groups, shown, t],
  );
  const byKey = useMemo(() => new Map(cards.map((c) => [c.key, c.data!])), [cards]);
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;

  // ---- New cards ------------------------------------------------------------------------------
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    const first = groups.find((g) => !collapsed.includes(g.key)) ?? groups[0];
    if (first) setDraft(first.key);
  }, [newRowRequest, groups, collapsed]);

  // ---- Pages ------------------------------------------------------------------------------------
  // A column whose last card came into view asks for its next page. A source fetches one page at
  // a time and drops an ask made meanwhile, so an ask waits here until the fetch under way is over.
  const wanted = useRef(new Set<string>());
  const askNext = () => {
    if (!source || snapshot.loading) return;
    for (const key of wanted.current) {
      wanted.current.delete(key);
      if (groupsRef.current.some((g) => g.key === key && !g.complete)) {
        source.loadMore(key);
        return;
      }
    }
  };
  useEffect(askNext);

  const createCard = (groupKey: string, title: string) => {
    if (!title.trim()) return;
    void actions.createRow({ title, view, groupKey });
  };

  // ---- Moving a card ----------------------------------------------------------------------------
  /** Whether a card may go to another column: its group property is one a move can set. */
  const canMove = (cardKey: string, toKey: string) => {
    const card = byKeyRef.current.get(cardKey);
    if (!card || !rule || card.group === toKey) return true;
    return (
      crossColumns && movedGroupValue(groupDef, rule, card.row, card.group, toKey) !== undefined
    );
  };
  /** Moves a card to `toKey`, at `index` among that column's other cards. */
  const commitMove = (cardKey: string, toKey: string, index: number) => {
    const card = byKeyRef.current.get(cardKey);
    const target = groupsRef.current.find((g) => g.key === toKey);
    if (!card || !target || !rule || !groupDef) return;
    const { row, group: fromKey } = card;
    const others = target.rows.filter((r) => r.id !== row.id);
    const place = Math.max(0, Math.min(others.length, index));
    if (fromKey !== toKey) {
      const value = movedGroupValue(groupDef, rule, row, fromKey, toKey);
      if (value === undefined) return;
      if (!sorted && needsMove(row, others, place))
        void actions.moveRow(row, placeAt(others, place));
      void actions.setValue(row, groupDef, value);
    } else if (!sorted && needsMove(row, others, place)) {
      void actions.moveRow(row, placeAt(others, place));
    }
  };

  // ---- Moving a column ------------------------------------------------------------------------------
  /** Writes the columns' order with `key` moved to `index` among the shown columns. */
  const commitColumn = (key: string, index: number) => {
    const keys = groupsRef.current.map((g) => g.key);
    const next = movedOrder(keys, key, index);
    if (next.every((k, i) => k === keys[i])) return;
    void actions.updateView(view, withGroupOrder(view.config, next));
  };

  // ---- Menus ---------------------------------------------------------------------------------------
  const cardItems = (): CgContextMenuItem<string>[] => [
    {
      key: 'open',
      text: t('row.open'),
      command: ({ invocation }) => {
        const card = byKeyRef.current.get(invocation.context);
        if (card) host.openRow(card.row.id);
      },
    },
    {
      key: 'duplicate',
      text: t('row.duplicate'),
      disabled: !editable,
      command: ({ invocation }) => {
        const card = byKeyRef.current.get(invocation.context);
        if (card) void actions.duplicateRow(card.row);
      },
    },
    {
      key: 'delete',
      text: t('row.delete'),
      intent: 'danger',
      disabled: !editable,
      beginGroup: true,
      command: ({ invocation }) => {
        const card = byKeyRef.current.get(invocation.context);
        if (card) void actions.trashRow(card.row);
      },
    },
  ];
  const columnMenu = useRef<CgContextMenuActions<string>>(null);
  const columnItems = useMemo<CgContextMenuItem<string>[]>(
    () => [
      {
        key: 'hide',
        text: t('board.hideColumn'),
        disabled: !editable,
        command: ({ invocation }) =>
          void actions.updateView(view, withGroupHidden(view.config, invocation.context, true)),
      },
    ],
    [t, actions, editable, view],
  );

  // Stable, so a card's box (memoised) is drawn again only when its own card changes.
  const renderCard = useCallback(
    (card: CgKanbanCard<CardData>) => (
      <div className="cgw-card-body cgw-board-card" data-row-id={card.data!.row.id}>
        <CardContent row={card.data!.row} shown={shown} env={env} />
      </div>
    ),
    [shown, env],
  );

  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const labels = useMemo<CgKanbanBoardLabels<CardData, RowGroup>>(
    () => ({
      board: t('board.label', { name }),
      column: (column, count) => `${column.title}, ${t('board.countLabel', { count })}`,
      emptyColumn: t('board.empty'),
      cardHint: t('card.moveHint'),
      cardHandle: (card) => t('card.menu', { title: card.label }),
      pickedUp: (card) => t('card.pickedUp', { title: card.label }),
      position: (_card, column, index, count) =>
        t('card.position', { group: column.title, index: index + 1, count }),
      moved: (card, column) => t('card.dropped', { title: card.label, place: column.title }),
      cancelled: () => t('card.cancelled'),
      moveToColumn: (column) => t('card.moveTo', { name: column.title }),
      moveUp: t('card.moveUp'),
      moveDown: t('card.moveDown'),
      addCard: (column) => t('board.newCardIn', { name: column.title }),
      collapseColumn: (column) => t('board.collapse', { name: column.title }),
      expandColumn: (column) => t('board.expand', { name: column.title }),
      hiddenColumns: t('board.hiddenGroups'),
      showColumn: (column) => t('board.showColumn', { name: column.title }),
      columnHandle: (column) => t('board.moveColumn', { name: column.title }),
      columnHint: t('board.moveColumnHint'),
      columnPickedUp: (column) => t('board.columnPickedUp', { name: column.title }),
      columnPosition: (column, index, count) =>
        t('board.columnPosition', { name: column.title, index: index + 1, count }),
      columnMoved: (column, index) =>
        t('board.columnDropped', { name: column.title, index: index + 1 }),
      columnCancelled: () => t('card.cancelled'),
      // Towards the row's start, then its end: the right first in RTL.
      moveColumnPrevious: t(rtl ? 'board.moveColumnRight' : 'board.moveColumnLeft'),
      moveColumnNext: t(rtl ? 'board.moveColumnLeft' : 'board.moveColumnRight'),
    }),
    [t, name, rtl],
  );

  // ---- Drawing -------------------------------------------------------------------------------------
  if (!rule || !groupDef || groupDef.trashedAt || !snapshot.groups) {
    if (snapshot.loading && rule && groupDef) return <div className="cgw-board" aria-busy="true" />;
    return <BoardSetup database={database} view={view} env={env} />;
  }

  return (
    <div className={`cgw-board${embedded ? ' is-embedded' : ''}`}>
      {sorted && crossColumns ? <p className="cgw-board-note">{t('board.sorted')}</p> : null}
      <CgKanbanBoard<CardData, RowGroup>
        className="cgw-board-kanban"
        aria-busy={snapshot.loading || undefined}
        columns={columns}
        cards={cards}
        labels={labels}
        locale={locale}
        cardGap={CARD_GAP}
        columnSize={272}
        fixedOrder={sorted}
        collapsible
        collapsedColumns={collapsed}
        onCollapsedColumnsChange={setCollapsed}
        renderColumnTitle={(column) => (
          <GroupLabel def={groupDef} rule={rule} groupKey={column.key} env={env} />
        )}
        renderCard={renderCard}
        onCardOpen={(cardKey) => {
          const card = byKeyRef.current.get(cardKey);
          if (card) host.openRow(card.row.id);
        }}
        cardMenuItems={cardItems}
        onCardMove={
          draggable ? (cardKey, toKey, toIndex) => commitMove(cardKey, toKey, toIndex) : undefined
        }
        canMove={(cardKey, toKey) => canMove(cardKey, toKey)}
        onColumnMove={editable ? (key, toIndex) => commitColumn(key, toIndex) : undefined}
        onAddCard={editable && titleDef ? (key) => setDraft(key) : undefined}
        draftColumn={editable ? draft : null}
        renderDraft={(column) =>
          titleDef ? (
            <InlineEditor
              def={titleDef}
              row={draftRow(database)}
              env={env}
              label={t('card.newLabel')}
              className="cgw-card-input"
              commit={(value) => createCard(column.key, typeof value === 'string' ? value : '')}
              onDone={() => setDraft(null)}
            />
          ) : null
        }
        renderColumnFooter={(column) => {
          const loadMore = column.data && !column.data.complete;
          const newCard = editable && titleDef && draft !== column.key;
          if (!loadMore && !newCard) return null;
          return (
            <>
              {loadMore ? (
                <button
                  type="button"
                  className="cgw-text-button"
                  onClick={() => source?.loadMore(column.key)}
                >
                  {t('board.loadMore')}
                </button>
              ) : null}
              {newCard ? (
                <button
                  type="button"
                  className="cgw-board-new"
                  aria-label={t('board.newCardIn', { name: column.title })}
                  onClick={() => setDraft(column.key)}
                >
                  <span aria-hidden="true">＋ </span>
                  {t('board.newCard')}
                </button>
              ) : null}
            </>
          );
        }}
        onColumnEndReached={(key) => {
          wanted.current.add(key);
          askNext();
        }}
        renderColumnActions={
          editable
            ? (column) => (
                <button
                  type="button"
                  className="cgw-icon-button"
                  aria-label={t('board.columnMenu', { name: column.title })}
                  title={t('board.columnMenu', { name: column.title })}
                  onClick={(event) =>
                    void columnMenu.current?.showNear(event.currentTarget, column.key)
                  }
                >
                  <span aria-hidden="true">⋯</span>
                </button>
              )
            : undefined
        }
        onShowColumn={
          editable
            ? (key) => void actions.updateView(view, withGroupHidden(config, key, false))
            : undefined
        }
      />
      <div className="cgw-table-foot" role="status">
        {snapshot.complete
          ? t('rowCount', { count: snapshot.total })
          : t('rowsShown', {
              shown: new Set(snapshot.rows.map((r) => r.id)).size,
              total: snapshot.total,
            })}
      </div>
      <CgContextMenu<string>
        items={columnItems}
        actionsRef={columnMenu}
        ariaLabel={t('board.hiddenGroups')}
      />
    </div>
  );
}

/** A board without a usable group property: choose one, or add a Status property. */
function BoardSetup({
  database,
  view,
  env,
}: {
  database: DatabaseRecord;
  view: ViewRecord;
  env: CellEnv;
}) {
  const { actions, editable } = useDatabaseContext();
  const { t } = env;
  const candidates = liveProperties(database).filter((p) => isGroupable(p.type));
  const choose = (propertyId: string) => {
    if (propertyId) void actions.updateView(view, withGroup(view.config, { propertyId }));
  };
  const addStatus = () => {
    const def = newPropertyDef('status', uniqueName(database, t('board.statusName')), {
      todo: t('option.defaultTodo'),
      inProgress: t('option.defaultInProgress'),
      complete: t('option.defaultComplete'),
    });
    void actions.addProperty(def).then(() => choose(def.id));
  };
  return (
    <div className="cgw-view-setup" role="note">
      <p>{candidates.length ? t('board.chooseGroup') : t('board.noGroupable')}</p>
      {candidates.length ? (
        <label className="cgw-view-setup-field">
          <span>{t('board.groupBy')}</span>
          <select
            className="cgw-select"
            value=""
            disabled={!editable}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{t('board.pickGroup')}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {editable ? (
        <button type="button" className="cgw-text-button" onClick={addStatus}>
          {t('board.addStatus')}
        </button>
      ) : null}
    </div>
  );
}
