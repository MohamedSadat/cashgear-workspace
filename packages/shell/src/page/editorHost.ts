// What the editor is given: titles and links from the mirror, toggle state and asset bytes from
// the local store. The editor never reaches the store itself.
import type { AssetInfo, EditorHost, EditorStrings } from '@cgw/editor';
import { uuidv7, type AssetRecord, type Id } from '@cgw/workspace';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';

/** Open toggles per page, kept on this device (DATA_MODEL.md: never in the document). */
export class ToggleState {
  private open = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly session: WorkspaceSession,
    private readonly pageId: Id,
  ) {
    void session.store.getPref<string[]>(this.key).then((ids) => {
      if (!ids?.length) return;
      this.open = new Set(ids);
      this.emit();
    });
  }

  private get key() {
    return `toggles/${this.pageId}`;
  }

  isOpen = (blockId: string) => this.open.has(blockId);

  flip = (blockId: string) => {
    if (this.open.has(blockId)) this.open.delete(blockId);
    else this.open.add(blockId);
    void this.session.store.setPref(this.key, [...this.open]);
    this.emit();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
export const ASSET_LIMIT_BYTES = 25 * 1024 * 1024;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A blob URL per asset, made once and kept while the app runs. */
const urls = new Map<Id, Promise<string | null>>();

export function assetUrl(session: WorkspaceSession, assetId: Id): Promise<string | null> {
  let url = urls.get(assetId);
  if (!url) {
    url = session.store.getAssetBytes(assetId).then(async (held) => {
      // Not on this device: from the server by a signed URL, then kept here (M2.5).
      const bytes = held ?? (await session.remoteAssets?.(assetId)) ?? null;
      if (!bytes) {
        urls.delete(assetId);
        return null;
      }
      const record = session.mirror.assets.get(assetId);
      // SVG is never drawn inline (ARCHITECTURE.md, Upload safety): it goes as plain bytes.
      const type =
        record && IMAGE_TYPES.includes(record.contentType)
          ? record.contentType
          : 'application/octet-stream';
      return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
    });
    urls.set(assetId, url);
  }
  return url;
}

/** Checks a file, stores its bytes and record locally, and returns its id. */
export async function storeAsset(
  session: WorkspaceSession,
  file: File,
): Promise<{ assetId: Id; width: number | null; height: number | null } | null> {
  if (file.size > ASSET_LIMIT_BYTES || !session.workspaceId) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let width: number | null = null;
  let height: number | null = null;
  if (IMAGE_TYPES.includes(file.type)) {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type }));
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      // Not an image after all: kept as a file.
    }
  }
  const record: AssetRecord = {
    id: uuidv7(),
    workspaceId: session.workspaceId,
    fileName: file.name.slice(0, 255) || 'file',
    contentType: file.type || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    sha256: await sha256(bytes),
    width,
    height,
    createdAt: new Date().toISOString(),
  };
  await session.store.putAsset(record, bytes);
  session.mirror.putAsset(record);
  return { assetId: record.id, width, height };
}

export function pickFiles(accept: string[]): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept.join(',');
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Per session: records being asked of the server, and those it answered. */
interface Asked {
  pending: Map<Id, Promise<AssetInfo | undefined>>;
  known: Map<Id, AssetInfo>;
}
const asked = new WeakMap<WorkspaceSession, Asked>();

const askedOf = (session: WorkspaceSession): Asked => {
  let state = asked.get(session);
  if (!state) asked.set(session, (state = { pending: new Map(), known: new Map() }));
  return state;
};

/** An asset's record as far as this device knows it: the mirror's, else the server's answer. */
export const knownAsset = (session: WorkspaceSession, assetId: Id): AssetInfo | undefined =>
  session.mirror.assets.get(assetId) ?? asked.get(session)?.known.get(assetId);

/**
 * An asset's record: from the mirror, else (another device uploaded it) the server's record alone
 * (`session.remoteAssetInfo`, the asset's metadata route), never its bytes, which come when the
 * file is opened (`assetsOf().open`). Kept per session, so a reload of the mirror does not lose it.
 * Phase 8: a file block read "This file is not on this device", and did not open, on any device
 * that had not uploaded it, since Phase 2 brought images from the server and never files.
 */
export function assetRecord(
  session: WorkspaceSession,
  assetId: Id,
): Promise<AssetInfo | undefined> {
  const held = knownAsset(session, assetId);
  if (held) return Promise.resolve(held);
  const remote = session.remoteAssetInfo;
  if (!remote) return Promise.resolve(undefined);
  const { pending, known } = askedOf(session);
  let found = pending.get(assetId);
  if (!found) {
    found = remote(assetId)
      .then((record) => {
        if (record) known.set(assetId, record);
        return record ?? undefined;
      })
      .catch(() => undefined);
    pending.set(assetId, found);
    // Not there now (offline, no access yet): asked again the next time the block is drawn.
    void found.then((record) => {
      if (!record) pending.delete(assetId);
    });
  }
  return found;
}

/**
 * Files as the editor and the database views use them (`EditorHost.assets`, `DatabaseHost.assets`
 * have the same shape): URLs from the local store or the server, the records from the mirror (or
 * the server's record alone, `load`), new files kept locally, and "open" saving the file where the
 * person chooses (its bytes fetched then, and kept, when this device does not hold them).
 */
export function assetsOf(
  session: WorkspaceSession,
  saveFile: (name: string, bytes: Uint8Array, type: string) => Promise<void>,
): NonNullable<EditorHost['assets']> {
  return {
    url: (assetId) => assetUrl(session, assetId),
    info: (assetId): AssetInfo | undefined => knownAsset(session, assetId),
    load: (assetId) => assetRecord(session, assetId),
    store: (file) => storeAsset(session, file),
    pick: pickFiles,
    open: (assetId) => {
      void (async () => {
        // The bytes from this device, else from the server now (kept here, as the uploading
        // device keeps them: `fetchAsset` stores the record and the bytes).
        const bytes =
          (await session.store.getAssetBytes(assetId)) ??
          (await session.remoteAssets?.(assetId)) ??
          null;
        const record = knownAsset(session, assetId);
        if (!record || !bytes) return;
        await saveFile(record.fileName, bytes, record.contentType || 'application/octet-stream');
      })().catch((error: unknown) => console.warn('The file could not be saved:', error));
    },
  };
}

export interface HostDeps {
  session: WorkspaceSession;
  pageId: Id;
  strings: EditorStrings;
  toggles: ToggleState;
  openExternal: (url: string) => void;
  assets: NonNullable<EditorHost['assets']>;
  createChildPage: () => Promise<Id | null>;
}

export function editorHost(deps: HostDeps): EditorHost {
  const { session } = deps;
  return {
    strings: deps.strings,
    toggles: deps.toggles,
    openExternal: deps.openExternal,
    linkPreview: async (url) => {
      const preview = await session.remotePreview?.(url);
      if (!preview) return null;
      const imageUrl = preview.imageAssetId ? await assetUrl(session, preview.imageAssetId) : null;
      return {
        title: preview.title,
        description: preview.description,
        siteName: preview.siteName,
        imageUrl,
      };
    },
    assets: deps.assets,
    pages: {
      title: (pageId) => session.mirror.pages.get(pageId)?.title,
      icon: (pageId) => session.mirror.pages.get(pageId)?.icon,
      exists: (pageId) => {
        const page = session.mirror.pages.get(pageId);
        return !!page && !page.trashedAt;
      },
      open: (pageId, blockId) =>
        navigate({ kind: 'page', pageId, ...(blockId ? { blockId } : {}) }),
      create: deps.createChildPage,
      search: (query) => {
        const q = query.trim().toLocaleLowerCase();
        const out: { id: string; title: string; icon: string | null }[] = [];
        for (const page of session.mirror.pages.values()) {
          if (page.workspaceId !== session.workspaceId || page.trashedAt || page.id === deps.pageId)
            continue;
          if (q && !page.title.toLocaleLowerCase().includes(q)) continue;
          out.push({ id: page.id, title: page.title, icon: page.icon });
          if (out.length >= 20) break;
        }
        return out;
      },
      subscribe: (listener) => session.mirror.subscribe(listener),
    },
  };
}
