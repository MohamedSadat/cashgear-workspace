// The kanban block (`cashgear.kanban`): a compact board over a database view, its columns a select
// or status property, drawn by `@cgw/database`'s own board, so a card moves as it does on the
// database's board view: one `row.update` of the column's property (and a `page.move` for its place),
// with the database's own access. The block's settings are a view of its own that is never stored:
// the base view's filter and sorts, the block's column property, hidden columns and card
// properties; the board's changes to it ("Hide group", the column property) go to `setProps`.
import { CgCheckBox } from '@cashgear/ui';
import {
  BoardView,
  DatabaseContext,
  useDatabaseContextValue,
  useRowSource,
  viewConfig,
  type DatabaseHost,
  type RowRequest,
} from '@cgw/database';
import type { DatabaseRecord, PropertyDef, ViewConfig, ViewRecord } from '@cgw/workspace';
import { useMemo, useState } from 'react';
import { usePluginT } from '../i18n';
import type { PluginViewProps } from '../types';
import {
  BlockHead,
  ChooseDatabase,
  Message,
  SelectRow,
  SourceRows,
  useDatabaseState,
  useHostRead,
  type DatabaseState,
} from '../views/common';
import type { KanbanProps } from './props';

export default function KanbanBlock(view: PluginViewProps<KanbanProps>) {
  const { t } = usePluginT();
  const host = view.data.databases;
  if (!host) return <Message text={t('common.unavailable')} />;
  if (!view.props.databaseId)
    return (
      <ChooseDatabase
        editable={view.editable}
        data={view.data}
        onChosen={(databaseId, viewId) =>
          view.setProps({ ...view.props, databaseId, viewId, groupBy: null, hidden: [] })
        }
      />
    );
  return <KanbanOf {...view} host={host} databaseId={view.props.databaseId} />;
}

const live = (database: DatabaseRecord) => database.properties.filter((p) => !p.trashedAt);
/** The properties a kanban's columns can be: select and status. */
export const columnProperties = (database: DatabaseRecord) =>
  live(database).filter((p) => p.type === 'status' || p.type === 'select');

/** The block's column property: the one it names, else the first status, else the first select. */
export function columnProperty(
  database: DatabaseRecord,
  groupBy: string | null,
): PropertyDef | undefined {
  const candidates = columnProperties(database);
  return (
    candidates.find((p) => p.id === groupBy) ??
    candidates.find((p) => p.type === 'status') ??
    candidates[0]
  );
}

/** The view the board is drawn with: the base view's filter and sorts, the block's own columns and cards. */
export function boardViewOf(
  base: ViewRecord,
  database: DatabaseRecord,
  props: KanbanProps,
  group: PropertyDef,
  id: string,
): ViewRecord {
  const cards = props.cardProperties.filter((pid) =>
    live(database).some((p) => p.id === pid && p.type !== 'title'),
  );
  const config: ViewConfig = {
    ...viewConfig.withGroup(base.config, {
      propertyId: group.id,
      ...(props.hidden.length ? { hidden: [...props.hidden] } : {}),
    }),
    properties: {
      order: cards,
      hidden: live(database)
        .filter((p) => p.type !== 'title' && !cards.includes(p.id))
        .map((p) => p.id),
      widths: {},
    },
  };
  return { ...base, id, type: 'board', config };
}

function KanbanOf({
  props,
  editable,
  newer,
  setProps,
  data,
  host,
  databaseId,
  blockId,
}: PluginViewProps<KanbanProps> & { host: DatabaseHost; databaseId: string }) {
  const { t } = usePluginT();
  const state = useDatabaseState(host, databaseId, props.viewId);
  const [settings, setSettings] = useState(false);
  const { database, view: base } = state;
  const group = database ? columnProperty(database, props.groupBy) : undefined;
  const canEdit = useHostRead(host, () => host.canEdit(databaseId));
  // The board writes rows with the database's own access; the page's editability adds nothing.
  const boardEditable = canEdit && !newer;
  const id = `kanban:${blockId ?? base?.id ?? databaseId}`;
  const board = useMemo(
    () => (database && base && group ? boardViewOf(base, database, props, group, id) : null),
    [database, base, group, props, id],
  );
  const requestText = board
    ? JSON.stringify({
        viewId: base!.id,
        spec: { filter: board.config.filter, sorts: board.config.sorts, group: board.config.group },
        pageSize: 100,
      })
    : null;
  const request = useMemo<RowRequest | null>(
    () => (requestText ? (JSON.parse(requestText) as RowRequest) : null),
    [requestText],
  );
  const { source, snapshot } = useRowSource(host, databaseId, request);
  const context = useDatabaseContextValue(host, databaseId, boardEditable);
  // The board's changes to its view are the block's props: its column property and hidden columns.
  const value = useMemo(
    () => ({
      ...context,
      actions: {
        ...context.actions,
        updateView: (view: ViewRecord, config: ViewConfig) => {
          if (view.id !== id) return context.actions.updateView(view, config);
          if (editable)
            setProps({
              ...props,
              groupBy: config.group?.propertyId ?? props.groupBy,
              hidden: config.group?.hidden ?? [],
            });
          return Promise.resolve();
        },
      },
    }),
    [context, id, editable, props, setProps],
  );
  const title = state.title || t('common.untitledDatabase');

  let body;
  if (!database || !base)
    body = (
      <Message text={database ? t('common.loading') : t('common.missing')} busy={!!database} />
    );
  else if (!group) body = <Message text={t('kanban.noGroupable')} />;
  else if (snapshot.error)
    body = (
      <Message text={t('common.loadFailed')} error>
        <button type="button" className="cgw-plugin-link" onClick={() => source?.retry()}>
          {t('common.retry')}
        </button>
      </Message>
    );
  else
    body = (
      <DatabaseContext.Provider value={value}>
        <BoardView
          database={database}
          view={board!}
          source={source}
          snapshot={snapshot}
          embedded
          searching={false}
          newRowRequest={0}
        />
      </DatabaseContext.Provider>
    );

  return (
    <section className="cgw-plugin cgw-plugin-kanban" aria-label={t('kanban.label', { title })}>
      <BlockHead
        title={title}
        editable={editable}
        newer={newer}
        settingsOpen={settings}
        onSettings={() => setSettings((open) => !open)}
        onOpenDatabase={() => host.openPage(databaseId)}
      />
      {editable && settings && database ? (
        <KanbanSettings
          props={props}
          database={database}
          group={group}
          state={state}
          data={data}
          change={(next) => setProps({ ...props, ...next })}
        />
      ) : null}
      {snapshot.localOnly ? <p className="cgw-plugin-note">{t('common.localOnly')}</p> : null}
      <div className="cgw-plugin-body cgw-plugin-board">{body}</div>
    </section>
  );
}

function KanbanSettings({
  props,
  database,
  group,
  state,
  data,
  change,
}: {
  props: KanbanProps;
  database: DatabaseRecord;
  group: PropertyDef | undefined;
  state: DatabaseState;
  data: PluginViewProps<KanbanProps>['data'];
  change(next: Partial<KanbanProps>): void;
}) {
  const { t } = usePluginT();
  const columns = columnProperties(database);
  const cards = live(database).filter((p) => p.type !== 'title');
  return (
    <div className="cgw-plugin-settings" role="group" aria-label={t('common.settings')}>
      {columns.length && group ? (
        <SelectRow
          label={t('kanban.groupBy')}
          value={group.id}
          options={columns.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(groupBy) => change({ groupBy, hidden: [] })}
        />
      ) : null}
      {cards.length ? (
        <fieldset className="cgw-plugin-field cgw-plugin-cards">
          <legend className="cgw-plugin-field-label">{t('kanban.cardProperties')}</legend>
          {cards.map((p) => (
            <CgCheckBox
              key={p.id}
              checked={props.cardProperties.includes(p.id)}
              label={<span dir="auto">{p.name}</span>}
              onCheckedChange={(checked) =>
                change({
                  cardProperties:
                    checked === true
                      ? [...props.cardProperties.filter((id) => id !== p.id), p.id]
                      : props.cardProperties.filter((id) => id !== p.id),
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
      <SourceRows
        state={state}
        viewId={props.viewId}
        data={data}
        onView={(viewId) => change({ viewId })}
        onDatabase={(databaseId, viewId) =>
          change({ databaseId, viewId, groupBy: null, hidden: [], cardProperties: [] })
        }
      />
    </div>
  );
}
