// Row templates (contract section 1: rows with `isTemplate`, never in a view, a query, `rowCount`
// or an export): the New button's menu lists them, makes a row from one, makes a template and
// opens one to edit or deletes it. The table stream's toolbar draws the menu; these are its items.
// A row made from a template takes its title, icon, cover and values (the view's presets under
// them) and names it in `templateOfPageId`; the template's body is copied by the shell, which
// holds documents (the views never touch one).
import type { CgContextMenuItem } from '@cashgear/ui';
import { newOp, type Id, type PageCreate, type RowRecord } from '@cgw/workspace';
import type { ViewRecord } from '../core';
import type { DatabaseHost } from '../host';
import type { DbT } from '../i18n';
import { valuesForNewRow } from '../model/newRow';

/** A new row (or template) of a database, as one `page.create`; null when the database is unknown. */
export function rowCreate(
  host: DatabaseHost,
  databaseId: Id,
  init: {
    title: string;
    view?: ViewRecord | null;
    from?: RowRecord | null;
    isTemplate?: boolean;
  },
): { id: Id; op: ReturnType<typeof newOp> } | null {
  const database = host.database(databaseId);
  const page = host.page(databaseId);
  if (!database || !page) return null;
  const preset = valuesForNewRow(database, init.view?.config ?? null, null, host.me()?.id ?? null);
  const id = host.newId();
  const now = new Date().toISOString();
  const from = init.from ?? null;
  const record: PageCreate = {
    id,
    workspaceId: database.workspaceId,
    sectionId: page.sectionId,
    parentPageId: databaseId,
    orderKey: host.rowOrderKey(databaseId, 'end'),
    kind: 'row',
    title: init.title,
    icon: from?.icon ?? null,
    coverAssetId: from?.coverAssetId ?? null,
    isTemplate: init.isTemplate ?? false,
    templateOfPageId: from?.id ?? null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    row: { values: { ...preset.values, ...(from?.values ?? {}) } },
  };
  return { id, op: newOp('page.create', database.workspaceId, id, record) };
}

async function send(host: DatabaseHost, made: ReturnType<typeof rowCreate>): Promise<Id | null> {
  if (!made) return null;
  try {
    await host.apply([made.op]);
    return made.id;
  } catch {
    return null;
  }
}

/** A row made from a template, in a view (its presets under the template's values). */
export const createFromTemplate = (
  host: DatabaseHost,
  databaseId: Id,
  template: RowRecord,
  view: ViewRecord | null,
) => send(host, rowCreate(host, databaseId, { title: template.title, view, from: template }));

/** A new template, opened as a page to fill in (its properties and its body). */
export async function createTemplate(
  host: DatabaseHost,
  databaseId: Id,
  view: ViewRecord | null,
  title: string,
): Promise<Id | null> {
  const id = await send(host, rowCreate(host, databaseId, { title, view, isTemplate: true }));
  if (id) host.openRow(id);
  return id;
}

/**
 * The New button's template menu: a row from each template; then making a template, and opening
 * or deleting one (submenus).
 */
export function rowTemplateItems(options: {
  host: DatabaseHost;
  databaseId: Id;
  view: ViewRecord | null;
  templates: readonly RowRecord[];
  t: DbT;
  editable: boolean;
}): CgContextMenuItem<null>[] {
  const { host, databaseId, view, templates, t, editable } = options;
  const name = (row: RowRecord) => row.title || t('rowTemplates.untitled');
  const items: CgContextMenuItem<null>[] = templates.map((template) => ({
    key: `new:${template.id}`,
    text: name(template),
    disabled: !editable,
    command: () => void createFromTemplate(host, databaseId, template, view),
  }));
  if (!templates.length) items.push({ key: 'none', text: t('rowTemplates.none'), disabled: true });
  items.push({
    key: 'make',
    text: t('rowTemplates.newTemplate'),
    beginGroup: true,
    disabled: !editable,
    command: () => void createTemplate(host, databaseId, view, t('rowTemplates.newTitle')),
  });
  if (templates.length) {
    items.push({
      key: 'edit',
      text: t('rowTemplates.edit'),
      disabled: !editable,
      children: templates.map((template) => ({
        key: `edit:${template.id}`,
        text: name(template),
        command: () => host.openRow(template.id),
      })),
    });
    items.push({
      key: 'delete',
      text: t('rowTemplates.delete'),
      intent: 'danger',
      disabled: !editable,
      children: templates.map((template) => ({
        key: `delete:${template.id}`,
        text: name(template),
        intent: 'danger',
        command: () =>
          void host
            .apply([newOp('page.trash', template.workspaceId, template.id, {}, template.version)])
            .catch(() => undefined),
      })),
    });
  }
  return items;
}
