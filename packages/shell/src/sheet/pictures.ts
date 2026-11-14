// A workbook's picture on this device (contracts section 7): the last picture the device drew or
// fetched of each block view, for offline and for the moment before the live embed loads. The
// bytes are an asset of the local store, marked uploaded so the sync engine never sends it, with
// an id derived from the workbook and the view's hash (one per view, replaced in place); a
// preference `workbookPicture:<workbookId>:<viewHash>` says which asset, when it was made and of
// which version. No store schema change. A picture is never of ERP data: a workbook only.
import type { AssetRecord, Id, LocalStore } from '@cgw/workspace';

export interface PictureMeta {
  assetId: Id;
  /** When the picture was made (by the embed, or the server's `madeAt`). */
  madeAt: string;
  /** The version it shows, and its content's entity tag. */
  versionId: Id | null;
  etag: string;
  width?: number;
  height?: number;
  /** The workbook's name then, shown with the picture offline. */
  name?: string;
}

export interface CachedPicture {
  meta: PictureMeta;
  bytes: Uint8Array;
}

export const picturePref = (workbookId: Id, viewHash: string) =>
  `workbookPicture:${workbookId}:${viewHash}`;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The picture's asset id: a UUID (the stores take ids of that shape only) made of the SHA-256 of
 * the preference's key, version 8 (made by an implementation's own rule, RFC 9562).
 */
export async function pictureAssetId(workbookId: Id, viewHash: string): Promise<Id> {
  const digest = (await sha256(new TextEncoder().encode(picturePref(workbookId, viewHash)))).slice(
    0,
    16,
  );
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const h = hex(digest);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isMeta = (value: unknown): value is PictureMeta => {
  const meta = value as Partial<PictureMeta> | null;
  return (
    !!meta &&
    typeof meta.assetId === 'string' &&
    typeof meta.madeAt === 'string' &&
    typeof meta.etag === 'string'
  );
};

export class WorkbookPictures {
  constructor(
    private readonly store: Pick<LocalStore, 'getPref' | 'setPref' | 'putAsset' | 'getAssetBytes'>,
  ) {}

  /** The picture this device keeps of the view, or null. */
  async get(workbookId: Id, viewHash: string): Promise<CachedPicture | null> {
    try {
      const meta = await this.store.getPref<unknown>(picturePref(workbookId, viewHash));
      if (!isMeta(meta)) return null;
      const bytes = await this.store.getAssetBytes(meta.assetId);
      return bytes ? { meta, bytes } : null;
    } catch {
      return null;
    }
  }

  /** Keeps a picture of the view in place of the last one; its preference says what it is. */
  async put(
    workbook: { id: Id; workspaceId: Id },
    viewHash: string,
    bytes: Uint8Array,
    about: Omit<PictureMeta, 'assetId'>,
  ): Promise<PictureMeta> {
    const assetId = await pictureAssetId(workbook.id, viewHash);
    const record: AssetRecord = {
      id: assetId,
      workspaceId: workbook.workspaceId,
      fileName: `workbook-${viewHash.slice(0, 16)}.png`,
      contentType: 'image/png',
      sizeBytes: bytes.byteLength,
      sha256: hex(await sha256(bytes)),
      width: about.width ?? null,
      height: about.height ?? null,
      createdAt: about.madeAt,
      // Never sent: the server keeps its own pictures (WorkbookPreviews), by route.
      uploaded: true,
    };
    await this.store.putAsset(record, bytes);
    const meta: PictureMeta = { assetId, ...about };
    await this.store.setPref(picturePref(workbook.id, viewHash), meta);
    return meta;
  }
}
