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
    url = session.store.getAssetBytes(assetId).then((bytes) => {
      if (!bytes) return null;
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

export interface HostDeps {
  session: WorkspaceSession;
  pageId: Id;
  strings: EditorStrings;
  toggles: ToggleState;
  openExternal: (url: string) => void;
  saveAsset: (assetId: Id) => void;
  createChildPage: () => Promise<Id | null>;
}

export function editorHost(deps: HostDeps): EditorHost {
  const { session } = deps;
  return {
    strings: deps.strings,
    toggles: deps.toggles,
    openExternal: deps.openExternal,
    assets: {
      url: (assetId) => assetUrl(session, assetId),
      info: (assetId): AssetInfo | undefined => session.mirror.assets.get(assetId),
      store: (file) => storeAsset(session, file),
      pick: pickFiles,
      open: deps.saveAsset,
    },
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
