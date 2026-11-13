// Every change the views make, as operations through `host.apply`: a cell commit is one
// `row.update` (the title one `page.update`), a property change one `db.update`, a view change
// one `view.upsert`. Built here once so the table, the row panel and the other views write the
// same operations. Records are read from the host when an action runs, so the object is stable.
import {
  keyBetween,
  newOp,
  type Id,
  type Operation,
  type PageCreate,
  type RowRecord,
} from '@cgw/workspace';
import type { RowPlace } from './host';
import {
  TITLE_PROPERTY,
  isEmptyValue,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type Value,
  type ViewConfig,
  type ViewRecord,
  type ViewType,
} from './core';
import type { DatabaseHost } from './host';
import { valuesForNewRow } from './model/newRow';
import { placeProperty } from './model/viewConfig';

/** A key between two order keys that never throws on ties or a wrong order. */
export function safeKeyBetween(a: string | null, b: string | null): string {
  try {
    return keyBetween(a, b);
  } catch {
    try {
      return keyBetween(a, null);
    } catch {
      return keyBetween(null, null);
    }
  }
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface NewRowInit {
  /** The new row's id (default: one from the host), when the caller must know it first. */
  id?: Id;
  title?: string;
  values?: Record<PropertyId, Value>;
  /** Where it goes among the rows (default: after every row). */
  place?: RowPlace;
  /** The view it is made in: its group (with `groupKey`) and filter give it values. */
  view?: ViewRecord | null;
  groupKey?: string | null;
  isTemplate?: boolean;
}

export type DatabaseActions = ReturnType<typeof createActions>;

export function createActions(host: DatabaseHost, databaseId: Id) {
  const database = (): DatabaseRecord | null => host.database(databaseId);
  const workspaceId = () => database()?.workspaceId ?? host.page(databaseId)?.workspaceId ?? '';
  const send = (ops: Operation[]) =>
    ops.length ? host.apply(ops).catch(() => undefined) : Promise.resolve();

  const dbUpdate = (properties: PropertyDef[], order?: PropertyId[]) =>
    newOp('db.update', workspaceId(), databaseId, order ? { properties, order } : { properties });

  const viewUpsert = (view: ViewRecord) => newOp('view.upsert', workspaceId(), view.id, view);

  const actions = {
    databaseId,

    // ---- Cells --------------------------------------------------------------------------
    /** Writes one cell, unless it already holds that value. */
    setValue(row: RowRecord, def: PropertyDef, value: Value | null | undefined): Promise<void> {
      if (def.type === 'title')
        return actions.setTitle(row, typeof value === 'string' ? value : '');
      // An empty value is absent, and an unchecked checkbox is stored as no value.
      const next = value === undefined || value === false || isEmptyValue(value) ? null : value;
      if (sameValue(row.values[def.id], next)) return Promise.resolve();
      return send([newOp('row.update', workspaceId(), row.id, { values: { [def.id]: next } })]);
    },
    setTitle(row: RowRecord, title: string): Promise<void> {
      if (row.title === title) return Promise.resolve();
      return send([newOp('page.update', workspaceId(), row.id, { title })]);
    },

    // ---- Rows ---------------------------------------------------------------------------
    /** Makes a row and gives its id (null when the database or its page is unknown). */
    async createRow(init: NewRowInit = {}): Promise<Id | null> {
      const db = database();
      const page = host.page(databaseId);
      if (!db || !page) return null;
      const preset = valuesForNewRow(
        db,
        init.view?.config ?? null,
        init.groupKey ?? null,
        host.me()?.id ?? null,
      );
      const id = init.id ?? host.newId();
      const now = new Date().toISOString();
      const record: PageCreate = {
        id,
        workspaceId: db.workspaceId,
        sectionId: page.sectionId,
        parentPageId: databaseId,
        orderKey: host.rowOrderKey(databaseId, init.place ?? 'end'),
        kind: 'row',
        title: init.title ?? preset.title,
        icon: null,
        coverAssetId: null,
        isTemplate: init.isTemplate ?? false,
        templateOfPageId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
        trashRootId: null,
        row: { values: { ...preset.values, ...init.values } },
      };
      await send([newOp('page.create', db.workspaceId, id, record)]);
      return id;
    },
    /** A copy of a row (its title and values; not its body) just after it. */
    duplicateRow(row: RowRecord): Promise<Id | null> {
      return actions.createRow({
        title: row.title,
        values: { ...row.values },
        place: { after: row.id, before: null },
      });
    },
    trashRow(row: RowRecord): Promise<void> {
      return send([newOp('page.trash', workspaceId(), row.id, {}, row.version)]);
    },
    /** Moves a row among its database's rows (the "no sort" order, a board's column order). */
    moveRow(row: RowRecord, place: RowPlace): Promise<void> {
      const page = host.page(databaseId);
      if (!page) return Promise.resolve();
      return send([
        newOp(
          'page.move',
          workspaceId(),
          row.id,
          {
            sectionId: page.sectionId,
            parentPageId: databaseId,
            orderKey: host.rowOrderKey(databaseId, place),
          },
          row.version,
        ),
      ]);
    },

    // ---- Properties -----------------------------------------------------------------------
    /** Replaces one property's definition (name, options, format, formula, ...). */
    updateProperty(def: PropertyDef): Promise<void> {
      const current = database()?.properties.find((p) => p.id === def.id);
      if (current && sameValue(current, def)) return Promise.resolve();
      return send([dbUpdate([def])]);
    },
    /**
     * Adds a property: to the database (next to `anchor` in its order when given) and, in the
     * view, next to `anchor` and shown.
     */
    addProperty(
      def: PropertyDef,
      place?: { view: ViewRecord; anchor: PropertyId; side: 'before' | 'after' },
    ): Promise<void> {
      const db = database();
      if (!db) return Promise.resolve();
      const ops: Operation[] = [];
      if (place) {
        const ids = db.properties.map((p) => p.id);
        const at = ids.indexOf(place.anchor);
        ids.splice(at < 0 ? ids.length : place.side === 'before' ? at : at + 1, 0, def.id);
        ops.push(dbUpdate([def], ids));
        const config: ViewConfig = placeProperty(
          place.view.config,
          { ...db, properties: [...db.properties, def] },
          def.id,
          place.anchor,
          place.side,
        );
        ops.push(viewUpsert({ ...place.view, config }));
      } else ops.push(dbUpdate([def]));
      return send(ops);
    },
    /**
     * Adds a relation set up before it is written (a relation names its database), placed as
     * `addProperty` places a property, with its reverse property when it is two-way.
     */
    addRelation(
      def: PropertyDef,
      reverse: { databaseId: Id; def: PropertyDef } | null,
      place?: { view: ViewRecord; anchor: PropertyId; side: 'before' | 'after' },
    ): Promise<void> {
      if (!reverse || reverse.databaseId !== databaseId)
        return actions.addProperty(def, place).then(() =>
          reverse
            ? send([
                newOp('db.update', workspaceId(), reverse.databaseId, {
                  properties: [reverse.def],
                }),
              ])
            : undefined,
        );
      // A relation to this database: both sides in one write, the reverse after the relation.
      const db = database();
      if (!db) return Promise.resolve();
      const ids = db.properties.map((p) => p.id);
      const at = place ? ids.indexOf(place.anchor) : -1;
      ids.splice(at < 0 ? ids.length : place!.side === 'before' ? at : at + 1, 0, def.id);
      ids.splice(ids.indexOf(def.id) + 1, 0, reverse.def.id);
      const ops: Operation[] = [dbUpdate([def, reverse.def], ids)];
      if (place)
        ops.push(
          viewUpsert({
            ...place.view,
            config: placeProperty(
              place.view.config,
              { ...db, properties: [...db.properties, def] },
              def.id,
              place.anchor,
              place.side,
            ),
          }),
        );
      return send(ops);
    },
    /** Deletes a property: it is hidden everywhere and can be restored; its values stay. */
    deleteProperty(def: PropertyDef): Promise<void> {
      if (def.id === TITLE_PROPERTY) return Promise.resolve();
      return send([dbUpdate([{ ...def, trashedAt: new Date().toISOString() }])]);
    },
    restoreProperty(def: PropertyDef): Promise<void> {
      return send([dbUpdate([{ ...def, trashedAt: null }])]);
    },
    /** Moves a property in the database's own order (the order new views start from). */
    reorderProperties(order: PropertyId[]): Promise<void> {
      return send([newOp('db.update', workspaceId(), databaseId, { order })]);
    },
    /**
     * A relation and, when two-way, its reverse property in the related database (the same
     * database for a self-relation), written together.
     */
    saveRelation(
      def: PropertyDef,
      reverse: { databaseId: Id; def: PropertyDef } | null,
    ): Promise<void> {
      if (!reverse) return send([dbUpdate([def])]);
      if (reverse.databaseId === databaseId) return send([dbUpdate([def, reverse.def])]);
      return send([
        dbUpdate([def]),
        newOp('db.update', workspaceId(), reverse.databaseId, { properties: [reverse.def] }),
      ]);
    },
    applyOps(ops: Operation[]): Promise<void> {
      return send(ops);
    },

    // ---- Views ------------------------------------------------------------------------------
    updateView(view: ViewRecord, config: ViewConfig): Promise<void> {
      if (sameValue(view.config, config)) return Promise.resolve();
      return send([viewUpsert({ ...view, config })]);
    },
    renameView(view: ViewRecord, name: string): Promise<void> {
      if (view.name === name) return Promise.resolve();
      return send([viewUpsert({ ...view, name })]);
    },
    /** Makes a view after `after` (default: last) and gives its id. */
    async createView(
      type: ViewType,
      name: string,
      config: ViewConfig,
      after?: ViewRecord | null,
    ): Promise<Id | null> {
      const db = database();
      if (!db) return null;
      const views = host.views(databaseId);
      const anchor = after ?? views[views.length - 1] ?? null;
      const next = anchor ? views[views.indexOf(anchor) + 1] : views[0];
      const id = host.newId();
      const record: ViewRecord = {
        id,
        workspaceId: db.workspaceId,
        databaseId,
        name,
        type,
        orderKey: safeKeyBetween(anchor?.orderKey ?? null, next?.orderKey ?? null),
        config,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      await send([viewUpsert(record)]);
      return id;
    },
    duplicateView(view: ViewRecord, name: string): Promise<Id | null> {
      return actions.createView(view.type, name, structuredClone(view.config), view);
    },
    /** Deletes a view; the last view of a database stays. */
    deleteView(view: ViewRecord): Promise<void> {
      if (host.views(databaseId).length <= 1) return Promise.resolve();
      return send([newOp('view.delete', workspaceId(), view.id, {})]);
    },
    /** Moves a view to an index among the database's views. */
    moveView(view: ViewRecord, toIndex: number): Promise<void> {
      const others = host.views(databaseId).filter((v) => v.id !== view.id);
      const index = Math.max(0, Math.min(others.length, toIndex));
      const before = others[index - 1]?.orderKey ?? null;
      const after = others[index]?.orderKey ?? null;
      const orderKey = safeKeyBetween(before, after);
      if (orderKey === view.orderKey) return Promise.resolve();
      return send([viewUpsert({ ...view, orderKey })]);
    },

    // ---- The database's page ----------------------------------------------------------------
    renameDatabase(title: string): Promise<void> {
      const page = host.page(databaseId);
      if (!page || page.title === title) return Promise.resolve();
      return send([newOp('page.update', workspaceId(), databaseId, { title })]);
    },
  };
  return actions;
}
