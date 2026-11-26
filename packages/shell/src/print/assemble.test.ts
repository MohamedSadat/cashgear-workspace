// After 0.19.0: a page out's pages are read in its worker (assemble.ts) and only what the main thread
// must resolve comes back to it. The walk finds every file, page, person and block a page needs;
// and a page out through `collect` with the worker's work on this thread makes the same Word file,
// byte for byte, as the page's content read on the main thread (as until then) would.
import { build, type DocJSON } from '@cgw/doc';
import { uuidv7, MemoryStore, type AssetRecord } from '@cgw/workspace';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { IDS, PNG, everyBlockContent } from '../../../doc/src/out/fixtures';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../session';
import { needsOf, outWork, wordFile, type OutRequest, type OutShell } from './assemble';
import { collect, type OutWorker } from './collect';

const { docOf, heading, paragraph } = build;

describe('what a page needs from the main thread', () => {
  it('is its files, the pages and people it names, and its blocks that are not text, in order', () => {
    const content = everyBlockContent('en');
    const needs = needsOf(content);
    expect(needs.assets).toEqual([
      { id: IDS.image, image: true },
      { id: IDS.missing, image: true },
      { id: IDS.file, image: false },
    ]);
    expect(needs.pages).toEqual([IDS.linked, IDS.child]);
    expect(needs.people).toEqual([IDS.person]);
    const blockOf = (type: string, n = 0) =>
      content.content!.filter((b) => b.content?.[0]?.type === type)[n]?.attrs?.id;
    expect(needs.blocks.map((b) => [b.type, b.blockId])).toEqual([
      ['databaseView', blockOf('databaseView')],
      ['sheetEmbed', blockOf('sheetEmbed')],
      ['erpView', blockOf('erpView')],
      ['pluginBlock', blockOf('pluginBlock', 0)],
      ['pluginBlock', blockOf('pluginBlock', 1)],
    ]);
    expect(needs.blocks[2].attrs.connectorId).toBe('vendors');
  });

  it('names a page an in-app link points at by its id in lower case, a file once', () => {
    const id = uuidv7();
    const link = { type: 'link', attrs: { href: `#/p/${id.toUpperCase()}` } };
    const doc: DocJSON = {
      type: 'doc',
      content: [
        {
          type: 'block',
          attrs: { id: 'b1' },
          content: [
            {
              type: 'textBody',
              attrs: { kind: 'paragraph' },
              content: [{ type: 'text', text: 'there', marks: [link] }],
            },
          ],
        },
        {
          type: 'block',
          attrs: { id: 'b2' },
          content: [{ type: 'file', attrs: { assetId: 'x' } }],
        },
        {
          type: 'block',
          attrs: { id: 'b3' },
          content: [{ type: 'image', attrs: { assetId: 'x' } }],
        },
      ],
    };
    const needs = needsOf(doc);
    expect(needs.pages).toEqual([id]);
    expect(needs.assets).toEqual([{ id: 'x', image: false }]);
  });
});

describe('a page out read in its worker', () => {
  it('sends the worker stored logs, never content, and makes the file the main thread’s read made', async () => {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const picture: AssetRecord = {
      id: uuidv7(),
      workspaceId: made.ws.id,
      fileName: 'dot.png',
      contentType: 'image/png',
      sizeBytes: PNG.length,
      sha256: '0'.repeat(64),
      width: 2,
      height: 1,
      createdAt: new Date().toISOString(),
    };
    await session.store.putAsset(picture, PNG);
    session.mirror.putAsset(picture);
    const person = uuidv7();
    const block = (id: string, body: DocJSON): DocJSON => ({
      type: 'block',
      attrs: { id },
      content: [body],
    });
    const content: DocJSON = {
      type: 'doc',
      content: [
        ...docOf(heading(1, 'Inside the report')).content!,
        block('m1', {
          type: 'textBody',
          attrs: { kind: 'paragraph' },
          content: [
            { type: 'text', text: 'See ' },
            { type: 'pageMention', attrs: { pageId: made.c.id, blockId: null } },
            {
              type: 'text',
              text: ' and Beta',
              marks: [{ type: 'link', attrs: { href: `#/p/${made.b.id.toUpperCase()}` } }],
            },
            { type: 'text', text: ', asked by ' },
            { type: 'userMention', attrs: { userId: person } },
          ],
        }),
        block('i1', {
          type: 'image',
          attrs: { assetId: picture.id, width: null, align: null, alt: 'Dot', caption: null },
        }),
        block('e1', { type: 'erpView', attrs: { linkId: null, connectorId: 'vendors' } }),
      ],
    };
    const root = await session.createPage(
      { sectionId: made.section.id, parentPageId: null, title: 'Report' },
      content,
    );
    const sub = await session.createPage(
      { sectionId: made.section.id, parentPageId: root.id, title: 'Under it' },
      docOf(paragraph('A sub-page')),
    );
    // An update that will not decode: set aside as opening the page sets it aside.
    await store.appendDocUpdates(root.id, [
      { updateId: uuidv7(), data: new Uint8Array([255, 1, 2, 3]) },
    ]);

    const asked: OutRequest[] = [];
    const inThread = (): OutWorker => {
      const work = outWork();
      return {
        ask: async (request) => {
          asked.push(structuredClone(request));
          return structuredClone(work(structuredClone(request))!.answer);
        },
        close: () => undefined,
      };
    };
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initAsync: false });
    const collected = await collect(
      {
        session,
        i18n,
        databases: null,
        cloud: null,
        address: (id) => `https://app.test/#/p/${id}`,
        personName: (id) => (id === person ? 'Dana' : undefined),
        worker: inThread,
      },
      root.id,
      { subPages: true, purpose: 'word' },
    );
    const bytes = await collected.word();

    expect(collected.title).toBe('Report');
    expect(collected.leftOut).toEqual({
      images: 0,
      sheets: 0,
      databases: 0,
      deviceRows: 0,
      erp: 1,
    });
    expect(store.corruptUpdates()).toHaveLength(1);
    const [read, make] = asked;
    expect(read.type).toBe('read');
    expect(read.type === 'read' && read.pages.map((p) => p.id)).toEqual([root.id, sub.id]);
    expect(read.type === 'read' && read.pages.every((p) => 'log' in p && !('content' in p))).toBe(
      true,
    );
    expect(make.type === 'make' && make.purpose).toBe('word');
    const input = (make as { input: OutShell }).input;
    expect(input.pages.some((p) => 'content' in p)).toBe(false);
    expect(input.links[made.c.id]?.href).toBe(`https://app.test/#/p/${made.c.id}`);
    expect(input.links[made.b.id]?.title).toBe('Beta');
    expect(input.people).toEqual({ [person]: 'Dana' });
    expect(input.assets[picture.id]?.bytes).toEqual(PNG);
    expect(Object.values(input.pages[0].blocks)).toEqual([
      { kind: 'placeholder', text: 'Cash Gear ERP: vendors (its data is not exported)' },
    ]);

    // The same file as the content read on the main thread, as the page out did until 0.19.0.
    const before = wordFile({
      ...input,
      pages: await Promise.all(
        input.pages.map(async (page) => ({ ...page, content: await session.pageContent(page.id) })),
      ),
    });
    expect(bytes).toEqual(before);
  });
});
