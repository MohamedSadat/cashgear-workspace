// Export and import (DATA_MODEL.md, "Data export and deletion"): a zip with one Markdown file and
// one JSON file per page, in folders that follow the tree, an assets folder, and a manifest of
// ids. Import reads the same zip into a new workspace. Available from the first milestone,
// because a browser may evict local storage.
import { remapRefs, toMarkdown, type DocJSON } from '@cgw/doc';
import {
  keyBetween,
  newOp,
  uuidv7,
  type AssetRecord,
  type Id,
  type PageRecord,
  type SectionRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';
import type { WorkspaceSession } from '../session';
import type { ZipRequest } from './zip.worker';

export const FORMAT = 'cash-gear-workspace-export';
export const FORMAT_VERSION = 1;
const MANIFEST = 'cgw-export.json';

export interface ExportManifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  workspace: Pick<WorkspaceRecord, 'id' | 'name' | 'icon'>;
  sections: Pick<SectionRecord, 'id' | 'name' | 'orderKey' | 'visibility'>[];
  pages: (Pick<
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
    markdown: string;
    json: string;
  })[];
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

/** Builds the export of a workspace, or of some pages and everything under them. */
export async function exportZip(
  session: WorkspaceSession,
  options: { pageIds?: Id[]; untitled: string },
): Promise<{ bytes: Uint8Array; name: string }> {
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

  // Paths that follow the tree; siblings with the same name get a number.
  const paths = new Map<Id, string>();
  const taken = new Set<string>();
  const unique = (base: string) => {
    let path = base;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${base} (${n})`;
    taken.add(path.toLowerCase());
    return path;
  };
  for (const page of pages) {
    const parentFolder =
      page.parentPageId && paths.has(page.parentPageId)
        ? paths.get(page.parentPageId)!.split('/').slice(0, -1).join('/')
        : safeName(mirror.sections.get(page.sectionId)?.name ?? '', 'Pages');
    const folder = unique(`${parentFolder}/${safeName(page.title, options.untitled)}`);
    paths.set(page.id, `${folder}/${folder.split('/').pop()}`);
  }

  const files: Record<string, Uint8Array> = {};
  const assets = new Map<Id, AssetRecord & { file: string }>();
  const assetPath = (id: Id) => {
    const record = mirror.assets.get(id);
    if (!record) return null;
    if (!assets.has(id))
      assets.set(id, { ...record, file: `assets/${id}/${safeName(record.fileName, 'file')}` });
    return assets.get(id)!.file;
  };
  const manifestPages: ExportManifest['pages'] = [];
  for (const page of pages) {
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
      pageTitle: (id) => mirror.pages.get(id)?.title,
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
    manifestPages.push({
      id: page.id,
      sectionId: page.sectionId,
      parentPageId: page.parentPageId && paths.has(page.parentPageId) ? page.parentPageId : null,
      orderKey: page.orderKey,
      title: page.title,
      icon: page.icon,
      coverAssetId: page.coverAssetId,
      isTemplate: page.isTemplate,
      markdown: `${base}.md`,
      json: `${base}.json`,
    });
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
    assets: [...assets.values()],
  };
  files[MANIFEST] = utf8.encode(JSON.stringify(manifest, null, 1));
  const bytes = await runZip<Uint8Array>({ kind: 'zip', files });
  const stamp = new Date().toISOString().slice(0, 10);
  const label =
    options.pageIds && pages[0]
      ? safeName(pages[0].title, options.untitled)
      : safeName(workspace.name, 'workspace');
  return { bytes, name: `${label} ${stamp}.zip` };
}

export class ImportError extends Error {}

/** Reads an export into a new workspace: new ids for everything but blocks; links follow. */
export async function importZip(
  session: WorkspaceSession,
  bytes: Uint8Array,
  nameSuffix: string,
): Promise<Id> {
  const files = await runZip<Record<string, Uint8Array>>({ kind: 'unzip', bytes }, [bytes.buffer]);
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
  const ops = [newOp('workspace.create', workspace.id, workspace.id, workspace)];
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
  // Parents before children, so every page.create finds its parent.
  const byId = new Map(manifest.pages.map((p) => [p.id, p]));
  const depth = (id: Id): number => {
    const parent = byId.get(id)?.parentPageId;
    return parent && byId.has(parent) ? 1 + depth(parent) : 0;
  };
  const ordered = [...manifest.pages].sort((a, b) => depth(a.id) - depth(b.id));
  for (const p of manifest.pages) fresh(p.id);
  for (const a of manifest.assets) fresh(a.id);
  const pageIds = new Map(manifest.pages.map((p) => [p.id, ids.get(p.id)!]));
  const assetIds = new Map(manifest.assets.map((a) => [a.id, ids.get(a.id)!]));
  const defaultSection = ids.get(sections[0].id)!;
  // A child's section is its parent's (tree rule): parents come first, so it is known.
  const sectionOf = new Map<Id, Id>();
  for (const p of ordered) {
    const id = ids.get(p.id)!;
    const parent = p.parentPageId && byId.has(p.parentPageId) ? ids.get(p.parentPageId)! : null;
    const sectionId = parent ? sectionOf.get(parent)! : (ids.get(p.sectionId) ?? defaultSection);
    sectionOf.set(id, sectionId);
    const page: PageRecord = {
      id,
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
    };
    ops.push(newOp('page.create', workspace.id, page.id, page));
  }
  await session.apply(ops);
  for (const a of manifest.assets) {
    const data = files[a.file];
    if (!data) continue;
    const record: AssetRecord = {
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
    await session.store.putAsset(record, data);
    session.mirror.putAsset(record);
  }
  const { newDocumentUpdate } = await import('@cgw/doc');
  for (const p of manifest.pages) {
    const data = files[p.json];
    if (!data) continue;
    const page = JSON.parse(text.decode(data)) as PageFile;
    const content = remapRefs(page.content, pageIds, assetIds);
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
