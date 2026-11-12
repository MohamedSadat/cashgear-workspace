// Document schema versions and their migrations (DATA_MODEL.md, "Schema versions and
// migrations"): each older version's fixture, made by that version's code path, migrates as one
// ordinary local edit and loads in this build with nothing lost; a page of a version a build does
// not know is read-only there and writes nothing (S2's check). Version 2 (Phase 3) added
// `tableOfContents`; version 3 (Phase 4) adds `databaseView` and `dateMention`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, type DocJSON } from './binding';
import { CONTENT, META, MIGRATE, PageDocument, type DocEvent } from './document';
import { migrate, migrations } from './migrations';
import { readOnlyView } from './readonly';
import { SCHEMA_VERSION, TEXT_KINDS, documentSchema, knownTypes } from './schema';
import { plainText, toMarkdown } from './text';

interface Fixture {
  schemaVersion: number;
  pageId: string;
  clientId: number;
  updates: string[];
  json: DocJSON;
}

const readJSON = <T>(...path: string[]) =>
  JSON.parse(readFileSync(join(__dirname, '..', ...path), 'utf8')) as T;
const fixtures: Record<number, Fixture> = {
  1: readJSON<Fixture>('fixtures', 'doc-v1.json'),
  2: readJSON<Fixture>('fixtures', 'doc-v2.json'),
};
/** The element names each version knows (the server worker's list). */
const elements = readJSON<Record<string, string[]>>('vectors', 'schema-elements.json');

const updatesOf = (fixture: Fixture) =>
  fixture.updates.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);
const docOf = (fixture: Fixture) => {
  const doc = new Y.Doc();
  for (const update of updatesOf(fixture)) Y.applyUpdate(doc, update);
  return doc;
};

async function storeWith(fixture: Fixture) {
  const store = new MemoryStore();
  const pageId = fixture.pageId;
  await store.appendDocUpdates(
    pageId,
    updatesOf(fixture).map((data) => ({ updateId: uuidv7(), data })),
  );
  return { store, pageId };
}

/** Every node type, text kind and mark a document holds. */
function kindsIn(json: DocJSON): Set<string> {
  const kinds = new Set<string>();
  const walk = (node: DocJSON) => {
    kinds.add(node.type === 'textBody' ? `textBody:${String(node.attrs?.kind)}` : node.type);
    for (const mark of node.marks ?? []) kinds.add(`mark:${mark.type}`);
    node.content?.forEach(walk);
  };
  walk(json);
  return kinds;
}

describe('the version list', () => {
  it('has one step per version, each from n to n + 1', () => {
    expect(SCHEMA_VERSION).toBe(3);
    for (let version = 1; version < SCHEMA_VERSION; version++) {
      expect(typeof migrations[version], String(version)).toBe('function');
      expect(fixtures[version], `fixture for version ${version}`).toBeDefined();
    }
    expect(migrations[SCHEMA_VERSION]).toBeUndefined();
  });

  it('each step only raises the version by one', () => {
    for (let version = 1; version < SCHEMA_VERSION; version++) {
      const doc = docOf(fixtures[version]);
      const before = fragmentToJSON(doc.getXmlFragment(CONTENT));
      migrations[version](doc);
      expect(doc.getMap(META).get('schemaVersion')).toBe(version + 1);
      expect(fragmentToJSON(doc.getXmlFragment(CONTENT))).toEqual(before);
    }
  });
});

describe.each([1, 2])('the version-%i fixture', (version) => {
  const fixture = fixtures[version];

  it('is a document of that version holding every one of its block kinds and marks', () => {
    expect(fixture.schemaVersion).toBe(version);
    const doc = docOf(fixture);
    expect(doc.getMap(META).get('schemaVersion')).toBe(version);
    const json = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(json).toEqual(fixture.json);
    const kinds = kindsIn(json);
    // Every node of that version (the server's list) and every text kind and mark.
    for (const name of elements[String(version)].filter((n) => n !== 'textBody'))
      expect(kinds, name).toContain(name);
    for (const kind of TEXT_KINDS) expect(kinds, kind).toContain(`textBody:${kind}`);
    for (const mark of knownTypes().marks) expect(kinds, mark).toContain(`mark:${mark}`);
    // Nothing a later version added.
    for (const name of knownTypes().nodes)
      if (!['doc', 'text'].includes(name) && !elements[String(version)].includes(name))
        expect(kinds, name).not.toContain(name);
  });
});

describe.each([1, 2])('migration from version %i', (version) => {
  const fixture = fixtures[version];
  afterEach(() => vi.useRealTimers());

  it('runs as one local Yjs transaction that only raises the version', () => {
    const doc = docOf(fixture);
    const before = fragmentToJSON(doc.getXmlFragment(CONTENT));
    const updates: { origin: unknown }[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => updates.push({ origin }));
    expect(migrate(doc)).toEqual({ from: version, to: SCHEMA_VERSION });
    expect(updates).toEqual([{ origin: MIGRATE }]);
    expect(doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION);
    expect(fragmentToJSON(doc.getXmlFragment(CONTENT))).toEqual(before);
    // Already current, or newer than this build: nothing is done.
    expect(migrate(doc)).toBeNull();
    doc.getMap(META).set('schemaVersion', SCHEMA_VERSION + 1);
    expect(migrate(doc)).toBeNull();
    expect(doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION + 1);
  });

  it('runs when a page opens with edit rights, is saved like an edit, and loses nothing', async () => {
    const { store, pageId } = await storeWith(fixture);
    const events: DocEvent[] = [];
    const before = (await store.loadDoc(pageId)).updates.length;
    const page = await PageDocument.open(pageId, store, {
      clientId: fixture.clientId,
      onEvent: (event) => events.push(event),
    });
    expect(page.readOnly).toBe(false);
    expect(page.report.migrated).toEqual({ from: version, to: SCHEMA_VERSION });
    expect(events).toContainEqual({ kind: 'migrated', pageId, from: version, to: SCHEMA_VERSION });
    await page.flush();
    const log = (await store.loadDoc(pageId)).updates;
    // One more update in the log: the migration, made as this device's client.
    expect(log).toHaveLength(before + 1);
    const migration = log[log.length - 1];
    expect(migration.seq).toBeNull();
    const parsed = Y.decodeUpdate(migration.data);
    expect(parsed.structs.every((s) => s.id.client === fixture.clientId)).toBe(true);
    // Nothing lost: the content is what the older build wrote.
    expect(fragmentToJSON(page.fragment)).toEqual(fixture.json);
    await page.close();

    // It loads in this build, editable, and the migration does not run twice.
    const again = await PageDocument.open(pageId, store);
    expect(again.readOnly).toBe(false);
    expect(again.report.migrated).toBeNull();
    expect(again.doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION);
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
    const { store, pageId } = await storeWith(fixture);
    const before = await store.loadDoc(pageId);
    const page = await PageDocument.open(pageId, store, { canEdit: false });
    await page.flush();
    expect(page.report.migrated).toBeNull();
    expect(page.doc.getMap(META).get('schemaVersion')).toBe(version);
    await page.close();
    const after = await store.loadDoc(pageId);
    expect(after.updates.map((u) => [...u.data])).toEqual(before.updates.map((u) => [...u.data]));
  });

  it(`two devices migrating at once converge on version ${SCHEMA_VERSION} with the content untouched`, () => {
    const a = docOf(fixture);
    const b = docOf(fixture);
    const sa = Y.encodeStateVector(a);
    const sb = Y.encodeStateVector(b);
    migrate(a);
    migrate(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, sa));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, sb));
    for (const doc of [a, b]) {
      expect(doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION);
      expect(fragmentToJSON(doc.getXmlFragment(CONTENT))).toEqual(fixture.json);
    }
    expect(bytesEqual(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b))).toBe(true);
  });
});

/** This package's own PageDocument, built as an older build was (only its version differs). */
async function olderBuild(version: number) {
  vi.resetModules();
  vi.doMock('./schema', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./schema')>()),
    SCHEMA_VERSION: version,
  }));
  const built = await import('./document');
  const schema = await import('./schema');
  expect(schema.SCHEMA_VERSION).toBe(version);
  return built;
}

/** What a build of this version knows: its elements, the document and text, and every mark. */
const knownAt = (version: number) => ({
  nodes: new Set([...elements[String(version)], 'doc', 'text']),
  marks: knownTypes().marks,
});

describe('a build that knows only version 1 meets a version-2 page (S2)', () => {
  afterEach(() => {
    vi.doUnmock('./schema');
    vi.resetModules();
  });

  it('opens it read-only, writes nothing, and the bytes are identical afterwards', async () => {
    // A version-2 page.
    const { store, pageId } = await storeWith(fixtures[2]);
    const before = await store.loadDoc(pageId);
    const state = Y.mergeUpdates(before.updates.map((u) => u.data));

    const old = await olderBuild(1);
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
});

describe('a build that knows only version 2 meets a version-3 page (S2)', () => {
  afterEach(() => {
    vi.doUnmock('./schema');
    vi.resetModules();
  });

  const DATABASE = '01936f6e-0000-7000-8000-0000000000d1';
  const VIEW = '01936f6e-0000-7000-8000-0000000000d2';

  /** The version-2 fixture, migrated by this build, with a database view and a date added. */
  async function versionThreePage() {
    const { store, pageId } = await storeWith(fixtures[2]);
    const page = await PageDocument.open(pageId, store);
    expect(page.report.migrated).toEqual({ from: 2, to: 3 });
    page.doc.transact(() => {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', 'DbViewDbView');
      const body = new Y.XmlElement('databaseView');
      body.setAttribute('databaseId', DATABASE);
      body.setAttribute('viewId', VIEW);
      block.insert(0, [body]);
      // A paragraph holding a date, after the database view.
      const line = new Y.XmlElement('block');
      line.setAttribute('id', 'DateLineDate');
      const text = new Y.XmlElement('textBody');
      text.setAttribute('kind', 'paragraph');
      const due = new Y.XmlElement('dateMention');
      due.setAttribute('date', '2026-12-01');
      due.setAttribute('end', '2026-12-03');
      text.insert(0, [new Y.XmlText('Due '), due, new Y.XmlText(' at the latest')]);
      line.insert(0, [text]);
      page.fragment.insert(1, [block, line]);
    });
    await page.close();
    return { store, pageId };
  }

  it('opens it read-only, writes nothing, and the bytes are identical afterwards', async () => {
    const { store, pageId } = await versionThreePage();
    const before = await store.loadDoc(pageId);
    const state = Y.mergeUpdates(before.updates.map((u) => u.data));

    const old = await olderBuild(2);
    const events: unknown[] = [];
    const opened = await old.PageDocument.open(pageId, store, {
      onEvent: (event) => events.push(event),
    });
    expect(opened.readOnly).toBe(true);
    expect(opened.saveState).toBe('readOnly');
    expect(opened.report.migrated).toBeFalsy();
    opened.fragment.insert(0, [new Y.XmlText('typed in the old build')]);
    await opened.flush();
    await opened.close();
    const after = await store.loadDoc(pageId);
    expect(after.updates).toHaveLength(before.updates.length);
    expect(bytesEqual(Y.mergeUpdates(after.updates.map((u) => u.data)), state)).toBe(true);
    expect(events).toEqual([]);

    // The page is still all there for this build: the new nodes were kept.
    vi.doUnmock('./schema');
    vi.resetModules();
    const current = await import('./document');
    const again = await current.PageDocument.open(pageId, store);
    const json = fragmentToJSON(again.fragment);
    expect(JSON.stringify(json)).toContain(`"databaseId":"${DATABASE}"`);
    expect(plainText(json)).toContain('Due 2026-12-01 → 2026-12-03 at the latest');
    await again.close();
  });

  it('draws the new nodes as placeholders where they were, with the rest as it was', async () => {
    const { store, pageId } = await versionThreePage();
    const old = await olderBuild(2);
    const opened = await old.PageDocument.open(pageId, store);
    const strings = { block: 'Needs a newer version.', inline: '[newer]' };
    const view = readOnlyView(fragmentToJSON(opened.fragment), strings, { known: knownAt(2) });
    await opened.close();
    expect(view.unknownNodes).toEqual(['databaseView', 'dateMention']);
    // This build's schema holds the view, as an old build's would.
    expect(() => documentSchema().nodeFromJSON(view.json).check()).not.toThrow();
    const blocks = view.json.content!;
    // The database view's block keeps its place and id, drawn as a placeholder.
    expect(blocks[1].attrs).toEqual({ id: 'DbViewDbView' });
    expect(blocks[1].content![0]).toMatchObject({
      type: 'textBody',
      attrs: { kind: 'callout' },
      content: [{ type: 'text', text: strings.block }],
    });
    // The date is a placeholder in its line; the text around it stays.
    expect(plainText({ type: 'doc', content: [blocks[2]] })).toBe(
      `Due ${strings.inline} at the latest`,
    );
    // Everything version 2 knows is drawn as it was.
    const rest = { ...view.json, content: [blocks[0], ...blocks.slice(3)] };
    expect(rest).toEqual(fixtures[2].json);
  });

  it('a page made newer while it is open becomes read-only and says so', async () => {
    const { store, pageId } = await storeWith(fixtures[2]);
    const old = await olderBuild(2);
    const events: { kind: string }[] = [];
    const opened = await old.PageDocument.open(pageId, store, {
      onEvent: (event) => events.push(event),
    });
    expect(opened.readOnly).toBe(false);
    // Another device, on this build, migrates the page; the old build pulls it.
    const other = docOf(fixtures[2]);
    const sv = Y.encodeStateVector(other);
    migrate(other);
    opened.applyRemote([Y.encodeStateAsUpdate(other, sv)]);
    expect(opened.readOnly).toBe(true);
    expect(events).toContainEqual({ kind: 'newerVersion', pageId, version: 3 });
    const length = (await store.loadDoc(pageId)).updates.length;
    opened.fragment.insert(0, [new Y.XmlText('after the change')]);
    await opened.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened.saveState).toBe('readOnly');
    expect((await store.loadDoc(pageId)).updates).toHaveLength(length);
    await opened.close();
  });
});
