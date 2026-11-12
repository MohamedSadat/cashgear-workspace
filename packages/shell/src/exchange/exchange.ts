// Export and import (DATA_MODEL.md, "Data export and deletion"): a zip with one Markdown file and
// one JSON file per page, in folders that follow the tree, an assets folder, and a manifest of
// ids. Import reads the same zip into a new workspace. Available from the first milestone,
// because a browser may evict local storage.
//
// Format version 2 (Phase 4) adds databases. The manifest gains `databases` (each one's
// properties and views), and `pages` holds a database's page (`kind: 'database'`) and its rows
// (`kind: 'row'`, with `databaseId` and `values`) beside the pages; every entry has its `kind`.
// A database's folder holds `<title>.csv` beside its `.md` and `.json` (`Tasks/Tasks.csv`): its
// rows for people (`rowsToCsv` of every row and property). Import reads the JSON, never the CSV,
// and takes versions 1 and 2, as this device or the server writes them (the server's export
// writes the same format, every row's body included).
import { remapRefs, toMarkdown, type DocJSON } from '@cgw/doc';
import {
  STORED_TYPES,
  TITLE_PROPERTY,
  computeRow,
  keyBetween,
  newOp,
  rowsToCsv,
  uuidv7,
  type AssetRecord,
  type DatabaseRecord,
  type Id,
  type Operation,
  type PageCreate,
  type PageKind,
  type PageRecord,
  type PropertyDef,
  type PropertyId,
  type RowRecord,
  type SectionRecord,
  type Value,
  type ViewRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';
import type { WorkspaceSession } from '../session';
import type { ZipRequest } from './zip.worker';

export const FORMAT = 'cash-gear-workspace-export';
export const FORMAT_VERSION = 2;
export const MANIFEST = 'cgw-export.json';

/** A page, a database's page or a row, as the manifest lists it. */
export type ManifestPage = Pick<
  PageRecord,
  | 'id'
  | 'sectionId'
  | 'parentPageId'
  | 'orderKey'
  | 'title'
  | 'icon'
  | 'coverAssetId'
  | 'isTemplate'
> & {
  /** Version 2: `page` (a version 1 page has none), `database` or `row`. */
  kind?: PageKind;
  /** A row's database (its parent) and its values by property id. */
  databaseId?: Id;
  values?: Record<PropertyId, Value>;
  /**
   * The page's files (a database's page: its empty document, as a page's; a row: when this
   * device holds its body, else absent).
   */
  markdown?: string;
  json?: string;
};

/**
 * Version 2: a database's properties (in database order, deleted ones too) and its views in
 * order-key order (the records as the server's `ViewDto` has them; import reads `id`, `name`,
 * `type`, `orderKey` and `config`). Its rows are in `pages`.
 */
export interface ManifestDatabase {
  id: Id;
  properties: PropertyDef[];
  views: (Pick<ViewRecord, 'id' | 'name' | 'type' | 'orderKey' | 'config'> & Partial<ViewRecord>)[];
}

export interface ExportManifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  workspace: Pick<WorkspaceRecord, 'id' | 'name' | 'icon'>;
  sections: Pick<SectionRecord, 'id' | 'name' | 'orderKey' | 'visibility'>[];
  pages: ManifestPage[];
  /** Version 2; absent in version 1. */
  databases?: ManifestDatabase[];
  assets: (AssetRecord & { file: string })[];
}

interface PageFile {
  id: Id;
  title: string;
  icon: string | null;
  schemaVersion: number;
  content: DocJSON;
}

function runZip<T>(request: ZipRequest, transfer: Transferable[] = []): Promise<T> {
  const worker = new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ ok?: T; error?: string }>) => {
      worker.terminate();
      if (event.data.error !== undefined) reject(new Error(event.data.error));
      else resolve(event.data.ok as T);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(request, transfer);
  });
}

/** A name that is safe as a file or folder name on every system, and not empty. */
export function safeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function relative(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...Array(a.length - common).fill('..'), ...b.slice(common)]
    .map(encodeURIComponent)
    .join('/');
}

const utf8 = new TextEncoder();

/** Every property and every row shown: what a database's CSV holds. */
const ALL_PROPERTIES: Pick<ViewRecord, 'config'> = {
  config: {
    filter: null,
    sorts: [],
    group: null,
    properties: { order: [], hidden: [], widths: {} },
  },
};

export interface ExportOptions {
  pageIds?: Id[];
  untitled: string;
  /** People's names for a CSV's person cells (else their ids). */
  people?: Record<Id, string>;
}

/** The export's files (the manifest among them) and the zip's name. */
export async function buildExport(
  session: WorkspaceSession,
  options: ExportOptions,
): Promise<{ files: Record<string, Uint8Array>; name: string; manifest: ExportManifest }> {
  const workspaceId = session.workspaceId!;
  const workspace = session.mirror.workspaces.get(workspaceId)!;
  const { mirror } = session;
  const roots = options.pageIds
    ? options.pageIds.map((id) => mirror.pages.get(id)!).filter(Boolean)
    : mirror.sectionsOf(workspaceId).flatMap((s) => mirror.topPages(s.id));
  const pages: PageRecord[] = [];
  const walk = (page: PageRecord) => {
    if (page.trashedAt) return;
    pages.push(page);
    for (const child of mirror.childrenOf(page.id)) walk(child);
  };
  roots.forEach(walk);

  // Each database's rows this device holds (not trashed; row templates too, which the CSV leaves
  // out), in their order.
  const databases = pages.filter((p) => p.kind === 'database' && mirror.databases.has(p.id));
  const rowsOf = new Map<Id, RowRecord[]>();
  for (const database of databases) {
    const rows = await session.store.readRows(database.id);
    rowsOf.set(
      database.id,
      rows
        .filter((r) => !r.trashedAt)
        .sort((a, b) =>
          a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
        ),
    );
  }
  const withBody = new Set(await session.store.heldPages(workspaceId));

  // Paths that follow the tree; siblings with the same name get a number. A row with a body has a
  // folder in its database's.
  const paths = new Map<Id, string>();
  const taken = new Set<string>();
  const unique = (base: string) => {
    let path = base;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${base} (${n})`;
    taken.add(path.toLowerCase());
    return path;
  };
  const place = (page: PageRecord | RowRecord, parentId: Id | null) => {
    const parentFolder =
      parentId && paths.has(parentId)
        ? paths.get(parentId)!.split('/').slice(0, -1).join('/')
        : safeName(mirror.sections.get(page.sectionId)?.name ?? '', 'Pages');
    const folder = unique(`${parentFolder}/${safeName(page.title, options.untitled)}`);
    paths.set(page.id, `${folder}/${folder.split('/').pop()}`);
  };
  for (const page of pages) place(page, page.parentPageId);
  for (const [databaseId, rows] of rowsOf)
    for (const row of rows) if (withBody.has(row.id)) place(row, databaseId);

  const files: Record<string, Uint8Array> = {};
  const assets = new Map<Id, AssetRecord & { file: string }>();
  const assetPath = (id: Id) => {
    const record = mirror.assets.get(id);
    if (!record) return null;
    if (!assets.has(id))
      assets.set(id, { ...record, file: `assets/${id}/${safeName(record.fileName, 'file')}` });
    return assets.get(id)!.file;
  };
  const titleOf = (id: Id) =>
    mirror.pages.get(id)?.title ??
    [...rowsOf.values()].flat().find((r) => r.id === id)?.title ??
    mirror.rowRecords.get(id)?.title;

  /** A page's (or a row's) Markdown and JSON files. */
  const writeDocument = async (page: PageRecord | RowRecord) => {
    const base = paths.get(page.id)!;
    const content = await session.pageContent(page.id);
    const pageFile: PageFile = {
      id: page.id,
      title: page.title,
      icon: page.icon,
      schemaVersion: 1,
      content,
    };
    const markdown = toMarkdown(content, {
      pageTitle: titleOf,
      pageHref: (id) => (paths.has(id) ? relative(base, `${paths.get(id)}.md`) : undefined),
      assetName: (id) => mirror.assets.get(id)?.fileName,
      assetHref: (id) => {
        const path = assetPath(id);
        return path ? relative(base, path) : undefined;
      },
      untitled: options.untitled,
    });
    const heading = `# ${page.icon ? `${page.icon} ` : ''}${page.title || options.untitled}\n\n`;
    files[`${base}.md`] = utf8.encode(heading + markdown);
    files[`${base}.json`] = utf8.encode(JSON.stringify(pageFile, null, 1));
    if (page.coverAssetId) assetPath(page.coverAssetId);
  };

  const manifestPages: ExportManifest['pages'] = [];
  const manifestDatabases: ManifestDatabase[] = [];
  const entry = (page: PageRecord | RowRecord): ManifestPage => ({
    id: page.id,
    kind: page.kind,
    sectionId: page.sectionId,
    parentPageId: page.parentPageId && paths.has(page.parentPageId) ? page.parentPageId : null,
    orderKey: page.orderKey,
    title: page.title,
    icon: page.icon,
    coverAssetId: page.coverAssetId,
    isTemplate: page.isTemplate,
  });
  for (const page of pages) {
    const base = paths.get(page.id)!;
    const record = page.kind === 'database' ? mirror.databases.get(page.id) : undefined;
    if (!record) {
      await writeDocument(page);
      manifestPages.push({ ...entry(page), markdown: `${base}.md`, json: `${base}.json` });
      continue;
    }
    // A database: its page's (empty) document as a page's, its rows as a CSV for people beside
    // them (`Tasks/Tasks.csv`), its properties and views (in their order) in the manifest, then
    // its rows (with their bodies when this device holds them), as the server's export writes.
    const rows = rowsOf.get(page.id) ?? [];
    await writeDocument(page);
    files[`${base}.csv`] = utf8.encode(
      rowsToCsv(record, ALL_PROPERTIES, rows, csvLookups(session, record, rows, rowsOf, options)),
    );
    manifestPages.push({ ...entry(page), markdown: `${base}.md`, json: `${base}.json` });
    manifestDatabases.push({
      id: page.id,
      properties: record.properties,
      views: mirror.viewsOf(page.id),
    });
    const files_ = record.properties.filter((p) => p.type === 'files').map((p) => p.id);
    for (const row of rows) {
      for (const id of files_) {
        const value = row.values[id];
        if (Array.isArray(value)) for (const assetId of value) assetPath(assetId);
      }
      const item: ManifestPage = {
        ...entry(row),
        parentPageId: page.id,
        databaseId: page.id,
        values: row.values,
      };
      if (withBody.has(row.id)) {
        await writeDocument(row);
        const rowBase = paths.get(row.id)!;
        item.markdown = `${rowBase}.md`;
        item.json = `${rowBase}.json`;
      }
      manifestPages.push(item);
    }
  }
  for (const asset of assets.values()) {
    const bytes = await session.store.getAssetBytes(asset.id);
    if (bytes) files[asset.file] = bytes;
  }
  const sectionIds = new Set(pages.map((p) => p.sectionId));
  const manifest: ExportManifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: { id: workspace.id, name: workspace.name, icon: workspace.icon },
    sections: mirror
      .sectionsOf(workspaceId)
      .filter((s) => !options.pageIds || sectionIds.has(s.id))
      .map(({ id, name, orderKey, visibility }) => ({ id, name, orderKey, visibility })),
    pages: manifestPages,
    databases: manifestDatabases,
    assets: [...assets.values()],
  };
  files[MANIFEST] = utf8.encode(JSON.stringify(manifest, null, 1));
  const stamp = new Date().toISOString().slice(0, 10);
  const label =
    options.pageIds && pages[0]
      ? safeName(pages[0].title, options.untitled)
      : safeName(workspace.name, 'workspace');
  return { files, name: `${label} ${stamp}.zip`, manifest };
}

/** What a database's CSV writes for people, related rows, files and computed cells. */
function csvLookups(
  session: WorkspaceSession,
  database: DatabaseRecord,
  rows: RowRecord[],
  rowsOf: Map<Id, RowRecord[]>,
  options: ExportOptions,
) {
  const titles: Record<Id, string> = {};
  for (const list of rowsOf.values()) for (const row of list) titles[row.id] = row.title;
  for (const row of session.mirror.rowRecords.values()) titles[row.id] ??= row.title;
  const files: Record<Id, string> = {};
  for (const asset of session.mirror.assets.values()) files[asset.id] = asset.fileName;
  const related = (databaseId: Id, ids: Id[]) => {
    const target = session.mirror.databases.get(databaseId);
    const held = rowsOf.get(databaseId);
    if (!target || !held) return null;
    const wanted = new Set(ids);
    return { database: target, rows: held.filter((r) => wanted.has(r.id)) };
  };
  const computes = database.properties.some((p) => p.type === 'formula' || p.type === 'rollup');
  const computed = new Map<Id, ReturnType<typeof computeRow>>();
  if (computes) for (const row of rows) computed.set(row.id, computeRow(database, row, related));
  return {
    people: options.people,
    rows: titles,
    files,
    computed: (row: RowRecord) =>
      computes ? { ...row.computed, ...computed.get(row.id) } : undefined,
  };
}

/** Builds the export of a workspace, or of some pages and everything under them. */
export async function exportZip(
  session: WorkspaceSession,
  options: ExportOptions,
): Promise<{ bytes: Uint8Array; name: string }> {
  const { files, name } = await buildExport(session, options);
  const bytes = await runZip<Uint8Array>({ kind: 'zip', files });
  return { bytes, name };
}

export class ImportError extends Error {}

/** Reads an export into a new workspace: new ids for everything but blocks; links follow. */
export async function importZip(
  session: WorkspaceSession,
  bytes: Uint8Array,
  nameSuffix: string,
): Promise<Id> {
  const files = await runZip<Record<string, Uint8Array>>({ kind: 'unzip', bytes }, [bytes.buffer]);
  return readExport(session, files, nameSuffix);
}

const VIEW_TYPES: readonly ViewRecord['type'][] = ['table', 'board', 'list', 'calendar', 'gallery'];

/** Rows per `apply` while importing (each a transaction of the store). */
const ROW_BATCH = 500;

/** The properties a database is made with, and those added once every database exists. */
const later = (def: PropertyDef) =>
  def.type === 'relation' || def.type === 'rollup' || def.type === 'formula';

/** A zip's files (the manifest among them) read into a new workspace; the first page's new id. */
export async function readExport(
  session: WorkspaceSession,
  files: Record<string, Uint8Array>,
  nameSuffix: string,
): Promise<Id> {
  const text = new TextDecoder();
  const manifestBytes = files[MANIFEST];
  if (!manifestBytes) throw new ImportError('missing manifest');
  const manifest = JSON.parse(text.decode(manifestBytes)) as ExportManifest;
  if (manifest.format !== FORMAT || manifest.version > FORMAT_VERSION)
    throw new ImportError('unknown format');

  const now = new Date().toISOString();
  const ids = new Map<Id, Id>();
  const fresh = (old: Id) => {
    if (!ids.has(old)) ids.set(old, uuidv7());
    return ids.get(old)!;
  };
  const workspace: WorkspaceRecord = {
    id: uuidv7(),
    name: `${manifest.workspace.name}${nameSuffix}`.slice(0, 200),
    icon: manifest.workspace.icon,
    createdAt: now,
    version: 1,
    localOnly: true,
    deletedAt: null,
  };
  const ops: Operation[] = [newOp('workspace.create', workspace.id, workspace.id, workspace)];
  let lastKey: string | null = null;
  const sections = manifest.sections.length
    ? manifest.sections
    : [{ id: uuidv7(), name: 'Pages', orderKey: 'a0', visibility: 'workspace' as const }];
  for (const s of sections) {
    const section: SectionRecord = {
      id: fresh(s.id),
      workspaceId: workspace.id,
      name: s.name,
      orderKey: (lastKey = keyBetween(lastKey, null)),
      visibility: s.visibility === 'private' ? 'private' : 'workspace',
      version: 1,
      createdAt: now,
    };
    ops.push(newOp('section.create', workspace.id, section.id, section));
  }
  const databases = new Map((manifest.databases ?? []).map((d) => [d.id, d]));
  const kindOf = (p: ManifestPage): PageKind =>
    p.kind === 'row' && p.databaseId && databases.has(p.databaseId)
      ? 'row'
      : p.kind === 'database' && databases.has(p.id)
        ? 'database'
        : 'page';
  const all = manifest.pages;
  const tree = all.filter((p) => kindOf(p) !== 'row');
  const rows = all.filter((p) => kindOf(p) === 'row');
  // Parents before children, so every page.create finds its parent.
  const byId = new Map(tree.map((p) => [p.id, p]));
  const depth = (id: Id): number => {
    const parent = byId.get(id)?.parentPageId;
    return parent && byId.has(parent) ? 1 + depth(parent) : 0;
  };
  const ordered = [...tree].sort((a, b) => depth(a.id) - depth(b.id));
  for (const p of all) fresh(p.id);
  for (const a of manifest.assets) fresh(a.id);
  for (const d of databases.values()) for (const v of d.views) fresh(v.id);
  const assetIds = new Map(manifest.assets.map((a) => [a.id, ids.get(a.id)!]));
  const defaultSection = ids.get(sections[0].id)!;
  const record = (p: ManifestPage, sectionId: Id, parent: Id | null): PageRecord => ({
    id: ids.get(p.id)!,
    workspaceId: workspace.id,
    sectionId,
    parentPageId: parent,
    orderKey: p.orderKey,
    kind: 'page',
    title: p.title,
    icon: p.icon,
    coverAssetId: p.coverAssetId ? (assetIds.get(p.coverAssetId) ?? null) : null,
    isTemplate: p.isTemplate,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
  });

  // A database's properties with ids that point into this import: relations to a database that
  // is not in it are left out (with the rollups that read them).
  const mapped = new Map<Id, PropertyDef[]>();
  for (const d of databases.values()) {
    const dropped = new Set<PropertyId>();
    const defs: PropertyDef[] = [];
    for (const def of d.properties) {
      if (def.type === 'relation' && def.relation) {
        if (!databases.has(def.relation.databaseId)) {
          dropped.add(def.id);
          continue;
        }
        defs.push({
          ...def,
          relation: { ...def.relation, databaseId: fresh(def.relation.databaseId) },
        });
      } else defs.push(def);
    }
    mapped.set(
      d.id,
      defs.filter(
        (def) => !(def.type === 'rollup' && dropped.has(def.rollup?.relationPropertyId ?? '')),
      ),
    );
  }

  // A child's section is its parent's (tree rule): parents come first, so it is known.
  const sectionOf = new Map<Id, Id>();
  for (const p of ordered) {
    const id = ids.get(p.id)!;
    const parent = p.parentPageId && byId.has(p.parentPageId) ? ids.get(p.parentPageId)! : null;
    const sectionId = parent ? sectionOf.get(parent)! : (ids.get(p.sectionId) ?? defaultSection);
    sectionOf.set(id, sectionId);
    const page = record(p, sectionId, parent);
    if (kindOf(p) === 'database') {
      const properties = mapped.get(p.id)!;
      const create: PageCreate = {
        ...page,
        kind: 'database',
        database: { properties: properties.filter((def) => !later(def)) },
      };
      ops.push(newOp('page.create', workspace.id, id, create));
    } else ops.push(newOp('page.create', workspace.id, id, page));
  }
  // Once every database exists: the properties that name other databases or properties, in the
  // original order, then the views.
  for (const d of databases.values()) {
    const id = ids.get(d.id)!;
    const properties = mapped.get(d.id)!;
    const rest = properties.filter(later);
    if (rest.length)
      ops.push(
        newOp('db.update', workspace.id, id, {
          properties: rest,
          order: properties.map((def) => def.id),
        }),
      );
  }
  for (const d of databases.values())
    for (const v of d.views) {
      const view: ViewRecord = {
        id: ids.get(v.id)!,
        workspaceId: workspace.id,
        databaseId: ids.get(d.id)!,
        name: v.name,
        // A view type this build does not know is drawn as a table (never dropped).
        type: VIEW_TYPES.includes(v.type) ? v.type : 'table',
        orderKey: v.orderKey,
        config: v.config,
        version: 1,
        createdAt: now,
      };
      ops.push(newOp('view.upsert', workspace.id, view.id, view));
    }
  await session.apply(ops);

  // Rows: their values with ids that point into this import (relations set once every row
  // exists), in batches.
  const relations = new Map<Id, Set<PropertyId>>();
  const filesOf = new Map<Id, Set<PropertyId>>();
  const known = new Map<Id, Set<PropertyId>>();
  for (const [id, defs] of mapped) {
    relations.set(id, new Set(defs.filter((d) => d.type === 'relation').map((d) => d.id)));
    filesOf.set(id, new Set(defs.filter((d) => d.type === 'files').map((d) => d.id)));
    known.set(id, new Set(defs.filter((d) => STORED_TYPES.includes(d.type)).map((d) => d.id)));
  }
  const rowValues = (p: ManifestPage) => {
    const first: Record<PropertyId, Value> = {};
    const links: Record<PropertyId, Value> = {};
    const databaseId = p.databaseId!;
    for (const [key, value] of Object.entries(p.values ?? {})) {
      if (!known.get(databaseId)?.has(key) || key === TITLE_PROPERTY) continue;
      if (relations.get(databaseId)?.has(key)) {
        const linked = Array.isArray(value)
          ? value.filter((v) => ids.has(v) && rows.some((r) => r.id === v)).map((v) => ids.get(v)!)
          : [];
        if (linked.length) links[key] = linked;
      } else if (filesOf.get(databaseId)?.has(key))
        first[key] = Array.isArray(value)
          ? value.map((v) => assetIds.get(v)).filter((v): v is Id => !!v)
          : value;
      else first[key] = value;
    }
    return { first, links };
  };
  const creates: Operation[] = [];
  const updates: Operation[] = [];
  for (const p of rows) {
    const id = ids.get(p.id)!;
    const databaseId = ids.get(p.databaseId!)!;
    const { first, links } = rowValues(p);
    const create: PageCreate = {
      ...record(p, sectionOf.get(databaseId) ?? defaultSection, databaseId),
      kind: 'row',
      row: { values: first },
    };
    creates.push(newOp('page.create', workspace.id, id, create));
    if (Object.keys(links).length)
      updates.push(newOp('row.update', workspace.id, id, { values: links }));
  }
  const batches = [...creates, ...updates];
  for (let i = 0; i < batches.length; i += ROW_BATCH)
    await session.apply(batches.slice(i, i + ROW_BATCH));

  for (const a of manifest.assets) {
    const data = files[a.file];
    if (!data) continue;
    const asset: AssetRecord = {
      id: assetIds.get(a.id)!,
      workspaceId: workspace.id,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      width: a.width,
      height: a.height,
      createdAt: a.createdAt,
    };
    await session.store.putAsset(asset, data);
    session.mirror.putAsset(asset);
  }
  const { newDocumentUpdate } = await import('@cgw/doc');
  for (const p of all) {
    // A database's page has no document; a page or a row has one when its JSON is here.
    if (kindOf(p) === 'database' || !p.json) continue;
    const data = files[p.json];
    if (!data) continue;
    const page = JSON.parse(text.decode(data)) as PageFile;
    // Pages, rows, databases and views by their new ids: links and database blocks follow.
    const content = remapRefs(page.content, ids, assetIds);
    const newId = ids.get(p.id)!;
    await session.store.appendDocUpdates(newId, [
      { updateId: uuidv7(), data: newDocumentUpdate(newId, content) },
    ]);
    session.scheduleIndex(newId, 0);
  }
  session.switchTo(workspace.id);
  const first = ordered.find((p) => !p.parentPageId) ?? ordered[0];
  return first ? ids.get(first.id)! : '';
}
