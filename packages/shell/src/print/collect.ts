// Phase 19: what a page's Word file or print view is made from, read on the device (offline too, as
// the workspace's export reads it): the page's JSON and its sub-pages' (at most 200, each after a
// page break), a row's properties, the files its blocks show (from the local store; fetched when
// online if the device lacks one, as the editor would), the pages a mention or child page names
// with their addresses in the app, people's names, each database block's view as a table of its
// rows (or a chart view as its chart), each sheet's picture (the device's, else the server's), a
// plugin block's line, and a placeholder for an ERP block: its data is never read for a file.
// Nothing is sent anywhere. What could not be read is counted for the notice after.
import type { DocJSON } from '@cgw/doc';
import type { OutAsset, OutBlock, OutInput, OutPage, OutWords } from '@cgw/doc/out';
import type { Id, PageRecord, RowRecord } from '@cgw/workspace';
import { readLayout } from '@cgw/workspace/layout';
import type { i18n } from 'i18next';
import type { Cloud } from '../cloud/cloud';
import type { ShellDatabaseHost } from '../database/host';
import type { WorkspaceSession } from '../session';
import { NAMES, printWords } from './words';
import { addSection } from '../i18n/sections';

export const MAX_SUB_PAGES = 200;

export type Purpose = 'word' | 'print';

export interface OutDeps {
  session: WorkspaceSession;
  i18n: i18n;
  databases: ShellDatabaseHost | null;
  /** A person's name, from the workspace's people. */
  personName?(userId: Id): string | undefined;
  /** A page's address in the app (a link in the file), or null. */
  address(pageId: Id): string | null;
  cloud: Cloud | null;
}

/** What the file leaves out, counted for the notice after. */
export interface LeftOut {
  images: number;
  sheets: number;
  databases: number;
  deviceRows: number;
  erp: number;
}

export interface Collected {
  input: OutInput;
  leftOut: LeftOut;
  /** Lets go of what the print view drew from (its blob addresses). */
  dispose(): void;
}

type AnyPage = PageRecord | RowRecord;

/** The page's sub-pages (pages and databases, not rows), in the tree's order, at most 200. */
export function subPagesOf(session: WorkspaceSession, pageId: Id): Id[] {
  const out: Id[] = [];
  const walk = (id: Id) => {
    for (const child of session.mirror.childrenOf(id)) {
      if (out.length >= MAX_SUB_PAGES) return;
      if (child.trashedAt || child.kind === 'row') continue;
      out.push(child.id);
      walk(child.id);
    }
  };
  walk(pageId);
  return out;
}

const WORD_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

/** An image's natural size, read by decoding it (null when it cannot be). */
async function sizeOf(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** An image Word does not draw (WebP, SVG, AVIF…) as a PNG, by the canvas; null when it cannot be. */
async function toPng(
  blob: Blob,
  size: { width: number; height: number } | null,
): Promise<Uint8Array | null> {
  try {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const width = size?.width || image.naturalWidth || 640;
      const height = size?.height || image.naturalHeight || 480;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      return png ? new Uint8Array(await png.arrayBuffer()) : null;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/** A chart's SVG as a PNG at twice its size, for Word. */
async function svgToPng(
  svg: string,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const size = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"[^>]*\sheight="(\d+(?:\.\d+)?)"/.exec(svg);
  const width = size ? Number(size[1]) : 640;
  const height = size ? Number(size[2]) : 300;
  try {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * 2);
    canvas.height = Math.round(height * 2);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return png ? { bytes: new Uint8Array(await png.arrayBuffer()), width, height } : null;
  } catch {
    return null;
  }
}

/** Every node of a document, depth first. */
function nodes(doc: DocJSON, visit: (node: DocJSON, block: DocJSON | null) => void) {
  const walk = (node: DocJSON, block: DocJSON | null) => {
    visit(node, block);
    for (const child of node.content ?? []) walk(child, node.type === 'block' ? node : block);
  };
  walk(doc, null);
}

/** The words the writers take, in the interface's language. */
function wordsOf(t: (key: string, options?: Record<string, unknown>) => string): OutWords {
  return {
    untitled: t('print.words.untitled'),
    aPage: t('print.words.aPage'),
    someone: t('print.words.someone'),
    missingFile: t('print.words.missingFile'),
    missingImage: t('print.words.missingImage'),
    noHeadings: t('print.words.noHeadings'),
    unknownBlock: t('print.words.unknownBlock'),
    contents: t('print.words.contents'),
  };
}

/** The page (or row) and what it shows, made ready for the Word writer or the print view. */
export async function collect(
  deps: OutDeps,
  pageId: Id,
  options: { subPages: boolean; purpose: Purpose },
): Promise<Collected> {
  const { session, i18n } = deps;
  addSection(i18n, printWords);
  const t = i18n.t.bind(i18n) as unknown as (
    key: string,
    options?: Record<string, unknown>,
  ) => string;
  const language: 'en' | 'ar' = i18n.language === 'ar' ? 'ar' : 'en';
  const locale = i18n.language || 'en';
  const { mirror } = session;
  const record = (id: Id): AnyPage | undefined => mirror.pages.get(id) ?? mirror.rowRecords.get(id);
  const root = record(pageId);
  if (!root) throw new Error('not.found');
  const ids = [
    pageId,
    ...(options.subPages && root.kind !== 'row' ? subPagesOf(session, pageId) : []),
  ];
  const leftOut: LeftOut = { images: 0, sheets: 0, databases: 0, deviceRows: 0, erp: 0 };
  const urls: string[] = [];
  const assets: Record<string, OutAsset> = {};
  const links: OutInput['links'] = {};
  const people: Record<string, string> = {};
  const host = deps.databases;
  const online = !!deps.cloud && deps.cloud.status.state !== 'offline' && !!deps.cloud.account;

  /** An asset's bytes: the device's, else the server's when online (as the editor would). */
  const bytesOf = async (assetId: Id): Promise<Uint8Array | null> => {
    const held = await session.store.getAssetBytes(assetId).catch(() => null);
    if (held) return held;
    if (!online) return null;
    return (await session.remoteAssets?.(assetId).catch(() => null)) ?? null;
  };

  const addAsset = async (
    key: string,
    bytes: Uint8Array,
    type: string,
    fileName: string,
    known: { width: number | null; height: number | null } = { width: null, height: null },
  ) => {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
    const size =
      known.width && known.height
        ? { width: known.width, height: known.height }
        : await sizeOf(blob);
    if (options.purpose === 'print') {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      assets[key] = {
        fileName,
        contentType: type,
        width: size?.width ?? null,
        height: size?.height ?? null,
        url,
      };
      return true;
    }
    const word = WORD_TYPES.has(type.toLowerCase()) ? bytes : await toPng(blob, size);
    if (!word) return false;
    assets[key] = {
      fileName,
      contentType: WORD_TYPES.has(type.toLowerCase()) ? type : 'image/png',
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: word,
    };
    return true;
  };

  const pages: OutPage[] = [];
  for (const id of ids) {
    const page = record(id);
    if (!page) continue;
    const content: DocJSON =
      page.kind === 'database'
        ? {
            type: 'doc',
            content: [
              {
                type: 'block',
                attrs: { id: `db-${page.id}` },
                content: [{ type: 'databaseView', attrs: { databaseId: page.id, viewId: null } }],
              },
            ],
          }
        : await session.pageContent(id);
    const blocks: Record<string, OutBlock> = {};
    const work: Promise<void>[] = [];
    nodes(content, (node, block) => {
      const attrs = node.attrs ?? {};
      const blockId = typeof block?.attrs?.id === 'string' ? (block.attrs.id as string) : null;
      switch (node.type) {
        case 'image':
        case 'file': {
          const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
          if (!assetId || assets[assetId]) break;
          const info = mirror.assets.get(assetId);
          if (node.type === 'file') {
            if (info)
              assets[assetId] = {
                fileName: info.fileName,
                contentType: info.contentType,
                width: null,
                height: null,
              };
            break;
          }
          work.push(
            (async () => {
              const bytes = await bytesOf(assetId);
              const ok =
                !!bytes &&
                (await addAsset(
                  assetId,
                  bytes,
                  info?.contentType || 'image/png',
                  info?.fileName || 'image',
                  {
                    width: info?.width ?? null,
                    height: info?.height ?? null,
                  },
                ));
              if (!ok) leftOut.images++;
            })(),
          );
          break;
        }
        case 'pageMention':
        case 'childPage': {
          const target = typeof attrs.pageId === 'string' ? attrs.pageId : null;
          const linked = target ? record(target) : undefined;
          if (target && linked)
            links[target] = { title: linked.title, icon: linked.icon, href: deps.address(target) };
          break;
        }
        case 'userMention': {
          const userId = typeof attrs.userId === 'string' ? attrs.userId : null;
          const name = userId ? deps.personName?.(userId) : undefined;
          if (userId && name) people[userId] = name;
          break;
        }
        case 'text':
          for (const mark of node.marks ?? []) {
            const href = mark.type === 'link' ? String(mark.attrs?.href ?? '') : '';
            const linked = /^#\/p\/([0-9a-f-]{36})/i.exec(href);
            const target = linked ? record(linked[1].toLowerCase()) : undefined;
            if (linked && target)
              links[target.id] = {
                title: target.title,
                icon: target.icon,
                href: deps.address(target.id),
              };
          }
          break;
        case 'databaseView':
          if (blockId) work.push(databaseBlock(blockId, attrs));
          break;
        case 'sheetEmbed':
          if (blockId) work.push(sheetBlock(blockId, attrs));
          break;
        case 'erpView':
          if (blockId) {
            leftOut.erp++;
            const connector =
              typeof attrs.connectorId === 'string' && attrs.connectorId ? attrs.connectorId : '?';
            blocks[blockId] = {
              kind: 'placeholder',
              text: t('print.words.erp', { erp: NAMES.erp, name: connector }),
            };
          }
          break;
        case 'pluginBlock':
          if (blockId) work.push(pluginBlock(blockId, attrs));
          break;
      }
    });

    async function databaseBlock(blockId: string, attrs: Record<string, unknown>) {
      const databaseId = typeof attrs.databaseId === 'string' ? attrs.databaseId : null;
      const viewId = typeof attrs.viewId === 'string' ? attrs.viewId : null;
      if (!databaseId || !host) {
        leftOut.databases++;
        blocks[blockId] = { kind: 'placeholder', text: t('print.words.database') };
        return;
      }
      const { viewOut, chartSvg } = await import('@cgw/database/out');
      const shown = await viewOut(host, databaseId, viewId, { say: t, locale }).catch(() => ({
        kind: 'none' as const,
        reason: 'failed' as const,
      }));
      if (shown.kind === 'none') {
        if (shown.reason === 'form') {
          const name = host.page(databaseId)?.title ?? '';
          blocks[blockId] = { kind: 'placeholder', text: t('print.words.form', { name }) };
        } else {
          leftOut.databases++;
          blocks[blockId] = { kind: 'placeholder', text: t('print.words.database') };
        }
        return;
      }
      if (shown.localOnly) leftOut.deviceRows++;
      if (shown.kind === 'table') {
        blocks[blockId] = {
          kind: 'table',
          title: shown.title,
          columns: shown.columns,
          rows: shown.rows,
          ...(shown.groups ? { groups: shown.groups } : {}),
          more: shown.more,
          ...(shown.more > 0
            ? {
                moreText: t('print.words.moreRows', {
                  number: new Intl.NumberFormat(locale).format(shown.more),
                }),
              }
            : {}),
        };
        return;
      }
      const svg = await chartSvg({
        kind: shown.chart,
        points: shown.points,
        title: shown.title,
        locale,
        rtl: language === 'ar',
      });
      if (!svg) {
        blocks[blockId] = {
          kind: 'placeholder',
          text: t('print.words.chartEmpty', { name: shown.title }),
        };
        return;
      }
      if (options.purpose === 'print') {
        blocks[blockId] = { kind: 'chart', title: shown.title, svg, image: null };
        return;
      }
      const png = await svgToPng(svg);
      const key = `chart-${blockId}`;
      if (png)
        assets[key] = {
          fileName: `${key}.png`,
          contentType: 'image/png',
          width: png.width,
          height: png.height,
          bytes: png.bytes,
        };
      blocks[blockId] = { kind: 'chart', title: shown.title, svg: null, image: png ? key : null };
    }

    async function sheetBlock(blockId: string, attrs: Record<string, unknown>) {
      const workbookId = typeof attrs.workbookId === 'string' ? attrs.workbookId : null;
      const fail = (name: string) => {
        leftOut.sheets++;
        blocks[blockId] = { kind: 'placeholder', text: t('print.words.sheet', { name }) };
      };
      if (!workbookId) return fail(t('print.words.workbook'));
      const [{ viewHash }, { blockView }, { WorkbookPictures }] = await Promise.all([
        import('@cgw/editor'),
        import('../sheet/view'),
        import('../sheet/pictures'),
      ]);
      const hash = await viewHash(
        blockView({
          sheet: (attrs.sheet as string | null) ?? null,
          range: (attrs.range as string | null) ?? null,
          chartId: (attrs.chartId as string | null) ?? null,
        }),
      );
      const pictures = new WorkbookPictures(session.store);
      const kept = await pictures.get(workbookId, hash);
      let bytes = kept?.bytes ?? null;
      const name = kept?.meta.name || t('print.words.workbook');
      if (!bytes && online && deps.cloud) {
        try {
          const [{ workbookApi }, { getSigned }] = await Promise.all([
            import('../sheet/api'),
            import('@cgw/api'),
          ]);
          const found = await workbookApi(deps.cloud.api).picture(workbookId, hash);
          const response = found ? await getSigned(found.url) : null;
          if (response?.ok) bytes = new Uint8Array(await response.arrayBuffer());
        } catch {
          bytes = null;
        }
      }
      if (!bytes) return fail(name);
      const key = `sheet-${blockId}`;
      if (!(await addAsset(key, bytes, 'image/png', `${key}.png`))) return fail(name);
      blocks[blockId] = { kind: 'picture', title: name, image: key };
    }

    async function pluginBlock(blockId: string, attrs: Record<string, unknown>) {
      const type = typeof attrs.type === 'string' ? attrs.type : '';
      const { FIRST_PARTY, pluginText } = await import('@cgw/plugins');
      const text = pluginText(
        FIRST_PARTY,
        type,
        typeof attrs.props === 'string' ? attrs.props : null,
        typeof attrs.version === 'number' ? attrs.version : null,
        { language, pageTitle: (id) => record(id)?.title },
      );
      blocks[blockId] = text
        ? { kind: 'text', text }
        : { kind: 'placeholder', text: t('print.words.plugin', { name: type || '?' }) };
    }

    await Promise.all(work);
    let properties: OutPage['properties'];
    if (page.kind === 'row' && host) {
      const { rowProperties } = await import('@cgw/database/out');
      properties = rowProperties(host, page as RowRecord, { say: t, locale });
    }
    pages.push({
      id: page.id,
      title: page.title,
      icon: page.icon,
      content,
      blocks,
      ...(properties ? { properties } : {}),
    });
  }

  const now = new Date();
  return {
    input: {
      language,
      locale,
      date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(now),
      madeAt: now.toISOString(),
      layout: readLayout(root.layout),
      pages,
      assets,
      links,
      people,
      words: wordsOf(t),
    },
    leftOut,
    dispose: () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

/** The notice's text of what was left out, or null when nothing was. */
export function leftOutText(
  t: (key: string, options?: Record<string, unknown>) => string,
  left: LeftOut,
  locale: string,
): string | null {
  const n = (count: number) => new Intl.NumberFormat(locale).format(count);
  const parts = [
    left.images ? t('print.out.images', { number: n(left.images) }) : null,
    left.sheets ? t('print.out.sheets', { number: n(left.sheets) }) : null,
    left.databases ? t('print.out.databases', { number: n(left.databases) }) : null,
    left.deviceRows ? t('print.out.deviceRows', { number: n(left.deviceRows) }) : null,
    left.erp ? t('print.out.erp', { erp: NAMES.erp, number: n(left.erp) }) : null,
  ].filter((p): p is string => !!p);
  return parts.length ? t('print.out.leftOut', { what: parts.join(t('print.out.and')) }) : null;
}
