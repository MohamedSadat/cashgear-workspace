// Document schema version 2 and its migration (contracts, section 4; DATA_MODEL.md, "Schema
// versions and migrations"): the version-1 fixture, made by the version-1 code path, migrates as
// one ordinary local edit and loads in this build with nothing lost; a version-2 page opened by
// a build that knows only version 1 is read-only and writes nothing (S2's check).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, type DocJSON } from './binding';
import { CONTENT, META, MIGRATE, PageDocument, type DocEvent } from './document';
import { migrate, migrations } from './migrations';
import { SCHEMA_VERSION, documentSchema, knownTypes } from './schema';
import { plainText, toMarkdown } from './text';

interface Fixture {
  schemaVersion: number;
  pageId: string;
  clientId: number;
  updates: string[];
  json: DocJSON;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'doc-v1.json'), 'utf8'),
) as Fixture;
const fixtureUpdates = () =>
  fixture.updates.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

async function storeWithFixture() {
  const store = new MemoryStore();
  const pageId = fixture.pageId;
  await store.appendDocUpdates(
    pageId,
    fixtureUpdates().map((data) => ({ updateId: uuidv7(), data })),
  );
  return { store, pageId };
}

describe('the version-1 fixture', () => {
  it('is a version-1 document holding every version-1 block kind', () => {
    const doc = new Y.Doc();
    for (const update of fixtureUpdates()) Y.applyUpdate(doc, update);
    expect(doc.getMap(META).get('schemaVersion')).toBe(1);
    const kinds = new Set<string>();
    const walk = (node: DocJSON) => {
      kinds.add(node.type === 'textBody' ? `textBody:${String(node.attrs?.kind)}` : node.type);
      for (const mark of node.marks ?? []) kinds.add(`mark:${mark.type}`);
      node.content?.forEach(walk);
    };
    walk(fragmentToJSON(doc.getXmlFragment(CONTENT)));
    // Every node of version 1 (the server's list for version 1) and every text kind and mark.
    const v1 = JSON.parse(
      readFileSync(join(__dirname, '..', 'vectors', 'schema-elements.json'), 'utf8'),
    ) as Record<string, string[]>;
    for (const name of v1['1'].filter((n) => n !== 'textBody')) expect(kinds, name).toContain(name);
    for (const kind of [
      'paragraph',
      'heading',
      'bulletItem',
      'numberedItem',
      'checkItem',
      'toggle',
      'quote',
      'callout',
    ])
      expect(kinds, kind).toContain(`textBody:${kind}`);
    for (const mark of knownTypes().marks) expect(kinds, mark).toContain(`mark:${mark}`);
    expect(kinds).not.toContain('tableOfContents');
  });
});

describe('migration 1 -> 2', () => {
  afterEach(() => vi.useRealTimers());

  it('is one step per version, each from n to n + 1', () => {
    for (let version = 1; version < SCHEMA_VERSION; version++)
      expect(typeof migrations[version], String(version)).toBe('function');
    expect(migrations[SCHEMA_VERSION]).toBeUndefined();
  });

  it('runs as one local Yjs transaction that only raises the version', () => {
    const doc = new Y.Doc();
    for (const update of fixtureUpdates()) Y.applyUpdate(doc, update);
    const before = fragmentToJSON(doc.getXmlFragment(CONTENT));
    const updates: { origin: unknown }[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => updates.push({ origin }));
    expect(migrate(doc)).toEqual({ from: 1, to: 2 });
    expect(updates).toEqual([{ origin: MIGRATE }]);
    expect(doc.getMap(META).get('schemaVersion')).toBe(2);
    expect(fragmentToJSON(doc.getXmlFragment(CONTENT))).toEqual(before);
    // Already current, or newer than this build: nothing is done.
    expect(migrate(doc)).toBeNull();
    doc.getMap(META).set('schemaVersion', SCHEMA_VERSION + 1);
    expect(migrate(doc)).toBeNull();
    expect(doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION + 1);
  });

  it('runs when a page opens with edit rights, is saved like an edit, and loses nothing', async () => {
    const { store, pageId } = await storeWithFixture();
    const events: DocEvent[] = [];
    const before = (await store.loadDoc(pageId)).updates.length;
    const page = await PageDocument.open(pageId, store, {
      clientId: fixture.clientId,
      onEvent: (event) => events.push(event),
    });
    expect(page.readOnly).toBe(false);
    expect(page.report.migrated).toEqual({ from: 1, to: 2 });
    expect(events).toContainEqual({ kind: 'migrated', pageId, from: 1, to: 2 });
    await page.flush();
    const log = (await store.loadDoc(pageId)).updates;
    // One more update in the log: the migration, made as this device's client.
    expect(log).toHaveLength(before + 1);
    const migration = log[log.length - 1];
    expect(migration.seq).toBeNull();
    const parsed = Y.decodeUpdate(migration.data);
    expect(parsed.structs.every((s) => s.id.client === fixture.clientId)).toBe(true);
    // Nothing lost: the content is what the version-1 build wrote.
    expect(fragmentToJSON(page.fragment)).toEqual(fixture.json);
    await page.close();

    // It loads in this build, editable, and the migration does not run twice.
    const again = await PageDocument.open(pageId, store);
    expect(again.readOnly).toBe(false);
    expect(again.report.migrated).toBeNull();
    expect(again.doc.getMap(META).get('schemaVersion')).toBe(2);
    expect(fragmentToJSON(again.fragment)).toEqual(fixture.json);
    // This build's schema holds it, and its text and Markdown are as they were.
    expect(() =>
      documentSchema().nodeFromJSON(fragmentToJSON(again.fragment)).check(),
    ).not.toThrow();
    expect(toMarkdown(fragmentToJSON(again.fragment))).toBe(toMarkdown(fixture.json));
    expect(plainText(fragmentToJSON(again.fragment))).toBe(plainText(fixture.json));
    await again.close();
    expect((await store.loadDoc(pageId)).updates).toHaveLength(before + 1);
  });

  it('does not run for someone who may only read the page', async () => {
    const { store, pageId } = await storeWithFixture();
    const before = await store.loadDoc(pageId);
    const page = await PageDocument.open(pageId, store, { canEdit: false });
    await page.flush();
    expect(page.report.migrated).toBeNull();
    expect(page.doc.getMap(META).get('schemaVersion')).toBe(1);
    const after = await store.loadDoc(pageId);
    expect(after.updates.map((u) => [...u.data])).toEqual(before.updates.map((u) => [...u.data]));
  });

  it('two devices migrating at once converge on version 2 with the content untouched', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    for (const update of fixtureUpdates()) {
      Y.applyUpdate(a, update);
      Y.applyUpdate(b, update);
    }
    const sa = Y.encodeStateVector(a);
    const sb = Y.encodeStateVector(b);
    migrate(a);
    migrate(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, sa));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, sb));
    for (const doc of [a, b]) {
      expect(doc.getMap(META).get('schemaVersion')).toBe(2);
      expect(fragmentToJSON(doc.getXmlFragment(CONTENT))).toEqual(fixture.json);
    }
  });
});

describe('a build that knows only version 1 meets a version-2 page (S2)', () => {
  afterEach(() => {
    vi.doUnmock('./schema');
    vi.resetModules();
  });

  /** This package's own PageDocument, built as the version-1 build was. */
  async function versionOneBuild() {
    vi.resetModules();
    vi.doMock('./schema', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./schema')>()),
      SCHEMA_VERSION: 1,
    }));
    const built = await import('./document');
    const schema = await import('./schema');
    expect(schema.SCHEMA_VERSION).toBe(1);
    return built;
  }

  it('opens it read-only, writes nothing, and the bytes are identical afterwards', async () => {
    // A version-2 page: the fixture migrated, with a table of contents added by this build.
    const { store, pageId } = await storeWithFixture();
    const page = await PageDocument.open(pageId, store);
    page.doc.transact(() => {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', 'TocTocTocToc');
      block.insert(0, [new Y.XmlElement('tableOfContents')]);
      page.fragment.insert(0, [block]);
    });
    await page.close();
    const before = await store.loadDoc(pageId);
    const state = Y.mergeUpdates(before.updates.map((u) => u.data));

    const old = await versionOneBuild();
    const events: unknown[] = [];
    const opened = await old.PageDocument.open(pageId, store, {
      onEvent: (event) => events.push(event),
    });
    expect(opened.readOnly).toBe(true);
    expect(opened.saveState).toBe('readOnly');
    expect(opened.report.migrated).toBeFalsy();
    // Anything that reaches the document is not saved: there is nothing to push.
    opened.fragment.insert(0, [new Y.XmlText('typed in the old build')]);
    await opened.flush();
    await opened.close();
    const after = await store.loadDoc(pageId);
    expect(after.updates).toHaveLength(before.updates.length);
    expect(bytesEqual(Y.mergeUpdates(after.updates.map((u) => u.data)), state)).toBe(true);
    expect(events).toEqual([]);
  });

  it('a page made newer while it is open becomes read-only and says so', async () => {
    const { store, pageId } = await storeWithFixture();
    const old = await versionOneBuild();
    const events: { kind: string }[] = [];
    const opened = await old.PageDocument.open(pageId, store, {
      onEvent: (event) => events.push(event),
    });
    expect(opened.readOnly).toBe(false);
    // Another device, on this build, migrates the page; the old build pulls it.
    const other = new Y.Doc();
    for (const update of fixtureUpdates()) Y.applyUpdate(other, update);
    const sv = Y.encodeStateVector(other);
    migrate(other);
    opened.applyRemote([Y.encodeStateAsUpdate(other, sv)]);
    expect(opened.readOnly).toBe(true);
    expect(events).toContainEqual({ kind: 'newerVersion', pageId, version: 2 });
    const length = (await store.loadDoc(pageId)).updates.length;
    opened.fragment.insert(0, [new Y.XmlText('after the change')]);
    await opened.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened.saveState).toBe('readOnly');
    expect((await store.loadDoc(pageId)).updates).toHaveLength(length);
  });
});
