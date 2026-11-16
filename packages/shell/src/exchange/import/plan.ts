// An import planned whole before anything is written (M8.4): what was given read into files (with
// the archive's guards), the files into a tree of pages (Markdown, Notion or Word), and the tree
// into the operations, documents and assets that make it: one new page at the end of the chosen
// section holding everything, so nothing is ever written into an existing page. Pure but for the
// assets' hashes: it runs in a worker (import.worker.ts) and in the unit tests alike.
import type { DocJSON } from '@cgw/doc';
import {
  keysBetween,
  newOp,
  type AssetRecord,
  type Id,
  type Operation,
  type PageCreate,
  type PageRecord,
  type ViewRecord,
  uuidv7,
} from '@cgw/workspace';
import { readArchive, readFolder, type ImportFile } from './archive';
import { looksLikeNotion } from './notion';
import { ImportRefused, ReportBuilder, type ImportReport } from './report';
import { planTree, type PlannedNode, type PlannedTree } from './tree';
import { planWord } from './word';

export type ImportKind = 'markdown' | 'notion' | 'word';

export type ImportSource =
  /** A zip, a Markdown file or a `.docx`. */
  | { kind: 'bytes'; name: string; bytes: Uint8Array }
  /** A chosen folder's files, their paths starting with the folder's name. */
  | { kind: 'folder'; name: string; files: { path: string; bytes: Uint8Array }[] };

export interface ImportRequest {
  kind: ImportKind;
  source: ImportSource;
  /** Where the new top page goes: the end of a section of the open workspace. */
  place: { workspaceId: Id; sectionId: Id; orderKey: string };
  untitled: string;
  /** A database's first view's name. */
  viewName: string;
  /** The top page's title when what was imported has no name of its own (a Notion export's). */
  name?: string;
  now?: string;
}

export interface ImportPlan {
  workspaceId: Id;
  /** The new top page: removing it removes everything the import made. */
  topId: Id;
  /** In order: parents before children, databases before their rows. */
  ops: Operation[];
  documents: { pageId: Id; content: DocJSON }[];
  assets: { record: AssetRecord; bytes: Uint8Array }[];
  /** The databases made (their rows are removed with them). */
  databases: Id[];
  /** Every page, database and row made. */
  pageIds: Id[];
  report: ImportReport;
}

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

/** What was imported's own name: a zip's or a file's without its extension. */
function sourceName(request: ImportRequest): string {
  const raw = request.source.name
    .replace(/\.(zip|md|markdown|docx)$/i, '')
    .replace(/-Part-\d+$/i, '');
  return /^(Export|ExportBlock)-[0-9a-f-]{32,36}$/i.test(raw) ? (request.name ?? raw) : raw;
}

export async function planImport(request: ImportRequest): Promise<ImportPlan> {
  const report = new ReportBuilder();
  const { source } = request;
  let tree: PlannedTree;
  if (request.kind === 'word') {
    if (source.kind !== 'bytes') throw new ImportRefused('notWord');
    tree = planWord(source.bytes, source.name, { untitled: request.untitled, report });
  } else {
    let files: ImportFile[];
    if (source.kind === 'folder') files = readFolder(source.files, report);
    else if (isZip(source.bytes)) files = readArchive(source.bytes, report);
    else files = readFolder([{ path: source.name, bytes: source.bytes }], report);
    // A Notion export chosen as Markdown is still read as Notion's (its ids off every name).
    const notion = request.kind === 'notion' || looksLikeNotion(files.map((f) => f.path));
    tree = planTree(files, {
      notion,
      name: sourceName(request),
      untitled: request.untitled,
      report,
    });
  }
  const now = request.now ?? new Date().toISOString();
  const assets = await tree.assets.records(request.place.workspaceId, now);
  const plan = planOps(tree.top, request, now);
  for (const asset of assets) {
    if (asset.image) report.made.images++;
    else report.made.files++;
  }
  Object.assign(report.made, plan.made);
  return {
    workspaceId: request.place.workspaceId,
    topId: tree.top.id,
    ops: plan.ops,
    documents: plan.documents,
    assets: assets.map(({ record, bytes }) => ({ record, bytes })),
    databases: plan.databases,
    pageIds: plan.pageIds,
    report: report.build(),
  };
}

/**
 * The tree as operations: page by page from the top (databases with their properties but their
 * relations), then the relations (a `db.update` per database, once every database exists), then
 * every database's rows, then the rows' relation values (once every row exists), as the
 * workspace's own import writes them.
 */
function planOps(top: PlannedNode, request: ImportRequest, now: string) {
  const { workspaceId, sectionId } = request.place;
  const ops: Operation[] = [];
  const rowOps: Operation[] = [];
  // Relations name other databases and rows: set once every database, then every row, exists.
  const relationOps: Operation[] = [];
  const linkOps: Operation[] = [];
  const documents: { pageId: Id; content: DocJSON }[] = [];
  const databases: Id[] = [];
  const pageIds: Id[] = [];
  const made = { pages: 0, databases: 0, rows: 0 };
  const record = (n: PlannedNode, parentId: Id | null, orderKey: string): PageRecord => ({
    id: n.id,
    workspaceId,
    sectionId,
    parentPageId: parentId,
    orderKey,
    kind: 'page',
    title: n.title.slice(0, 500),
    icon: n.icon,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
  });
  const add = (n: PlannedNode, parentId: Id | null, orderKey: string) => {
    pageIds.push(n.id);
    if (n.kind === 'database') {
      made.databases++;
      databases.push(n.id);
      const create: PageCreate = {
        ...record(n, parentId, orderKey),
        kind: 'database',
        database: { properties: (n.properties ?? []).filter((p) => p.type !== 'relation') },
      };
      ops.push(newOp('page.create', workspaceId, n.id, create));
      const relations = (n.properties ?? []).filter((p) => p.type === 'relation');
      if (relations.length)
        relationOps.push(
          newOp('db.update', workspaceId, n.id, {
            properties: relations,
            order: (n.properties ?? []).map((p) => p.id),
          }),
        );
      const view: ViewRecord = {
        id: uuidv7(),
        workspaceId,
        databaseId: n.id,
        name: request.viewName,
        type: 'table',
        orderKey: 'a0',
        config: {
          filter: null,
          sorts: [],
          group: null,
          properties: { order: [], hidden: [], widths: {} },
          wrap: false,
        },
        version: 1,
        createdAt: now,
      };
      ops.push(newOp('view.upsert', workspaceId, view.id, view));
      const keys = keysBetween(null, null, n.rows.length);
      n.rows.forEach((row, i) => {
        pageIds.push(row.id);
        made.rows++;
        const create: PageCreate = {
          ...record(row, n.id, keys[i]),
          kind: 'row',
          row: { values: row.values ?? {} },
        };
        rowOps.push(newOp('page.create', workspaceId, row.id, create));
        if (row.relations && Object.keys(row.relations).length)
          linkOps.push(newOp('row.update', workspaceId, row.id, { values: row.relations }));
        if (row.content) documents.push({ pageId: row.id, content: row.content });
      });
      return;
    }
    made.pages++;
    ops.push(newOp('page.create', workspaceId, n.id, record(n, parentId, orderKey)));
    if (n.content) documents.push({ pageId: n.id, content: n.content });
  };
  // Breadth first: every parent is made before its children.
  add(top, null, request.place.orderKey);
  const queue: PlannedNode[] = [top];
  while (queue.length) {
    const parent = queue.shift()!;
    const keys = keysBetween(null, null, parent.children.length);
    parent.children.forEach((child, i) => {
      add(child, parent.id, keys[i]);
      queue.push(child);
    });
  }
  return {
    ops: [...ops, ...relationOps, ...rowOps, ...linkOps],
    documents,
    databases,
    pageIds,
    made,
  };
}
