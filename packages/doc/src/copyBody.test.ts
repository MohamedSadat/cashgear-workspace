// Phase 15: a rule's new row starts with its template's body, copied by the server
// (crates/cgw-ydoc/src/copy.rs). The template here is written by this layer, edited afterwards by
// a second client (so its history holds deletions), and kept as a fixture the Rust tests copy
// (`COPY_FIXTURE_WRITE=1` writes it again); the copy Rust made is read back here and held to the
// editor's own rules: the schema accepts it, every block has a new id of 12 base-62 characters and
// no two share one, the content is the template's but for the ids, and the meta names the new page.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, type DocJSON } from './binding';
import {
  block,
  bullet,
  callout,
  code,
  databaseView,
  dateMention,
  docOf,
  heading,
  paragraph,
  pluginBlock,
  quote,
  table,
  text,
  todo,
  toggle,
  userMention,
} from './content';
import { newDocumentUpdate } from './document';
import { documentSchema } from './schema';

const fixtures = new URL('../../../crates/cgw-ydoc/tests/fixtures/', import.meta.url);
const TEMPLATE_ID = '01900000-0000-7000-8000-00000000e001';
/** The page the Rust test copies into (copy_tests.rs's `COPY_ID`). */
const COPY_ID = '01900000-0000-7000-8000-00000000e002';

function template(): Uint8Array {
  const json = docOf(
    heading(1, 'Weekly review'),
    paragraph(
      text('Bold', 'bold'),
      ' and ',
      text('both', 'bold', 'italic'),
      ', a ',
      text('link', { type: 'link', href: 'https://example.com/a' }),
    ),
    bullet(['Outer'], [bullet(['Inner'], [bullet(['Innermost'])])]),
    todo(false, 'Open the board'),
    todo(true, 'Done already'),
    toggle(['Details'], [paragraph('Hidden '), quote('A quote')]),
    callout('💡', 'blue', 'Note in Arabic: ', 'مراجعة أسبوعية'),
    code('ts', 'const a = 1;\nconst b = 2;'),
    table([
      ['Owner', 'Due'],
      ['Sami', 'Friday'],
    ]),
    paragraph(
      'On ',
      dateMention('2026-12-01'),
      ' with ',
      userMention('01900000-0000-7000-8000-0000000000a1'),
    ),
    databaseView('01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000003'),
    pluginBlock('acme.counter', { count: 2 }, 1),
    block({ type: 'divider' }),
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, newDocumentUpdate(TEMPLATE_ID, json, 4242));
  // A second client edits it: text typed and some deleted, a block removed.
  const other = new Y.Doc();
  other.clientID = 4343;
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const content = other.getXmlFragment('content');
  other.transact(() => {
    const title = (content.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    (title.get(0) as Y.XmlText).insert(6, ' team');
    const second = (content.get(1) as Y.XmlElement).get(0) as Y.XmlElement;
    (second.get(0) as Y.XmlText).delete(4, 4);
    content.delete(content.length - 1, 1);
  });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  return Y.encodeStateAsUpdate(doc);
}

const ID = /^[0-9A-Za-z]{12}$/;

function blockIds(node: DocJSON, out: string[] = []): string[] {
  if (node.type === 'block') out.push(String(node.attrs?.id));
  for (const child of node.content ?? []) blockIds(child, out);
  return out;
}

function withoutBlockIds(node: DocJSON): DocJSON {
  const copy: DocJSON = { ...node };
  if (node.type === 'block') copy.attrs = { ...node.attrs, id: 'x' };
  if (node.content) copy.content = node.content.map(withoutBlockIds);
  return copy;
}

const read = (bytes: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return { json: fragmentToJSON(doc.getXmlFragment('content')), meta: doc.getMap('meta').toJSON() };
};

describe('a template body copied by the server', () => {
  if (process.env.COPY_FIXTURE_WRITE === '1')
    writeFileSync(new URL('copy-template.bin', fixtures), template());

  it('is a template this layer wrote and edited', () => {
    const { json, meta } = read(readFileSync(new URL('copy-template.bin', fixtures)));
    expect(meta).toMatchObject({ pageId: TEMPLATE_ID, epoch: 0 });
    expect(documentSchema().nodeFromJSON(json).check()).toBeUndefined();
    expect(blockIds(json).length).toBeGreaterThan(15);
  });

  it("reads back as the template's content, every block with a new id of its own", () => {
    const path = new URL('copy-result.bin', fixtures);
    // Written by `cargo test -p cgw-ydoc` (copy_tests.rs) from the template above.
    expect(existsSync(path)).toBe(true);
    const source = read(readFileSync(new URL('copy-template.bin', fixtures)));
    const copy = read(readFileSync(path));
    expect(copy.meta).toEqual({
      pageId: COPY_ID,
      epoch: 0,
      schemaVersion: source.meta.schemaVersion,
    });
    // The schema the editor opens it with accepts it whole.
    expect(documentSchema().nodeFromJSON(copy.json).check()).toBeUndefined();
    // As the editor reads them (marks in the schema's order: a run's marks are a set).
    const opened = (json: DocJSON) => documentSchema().nodeFromJSON(withoutBlockIds(json)).toJSON();
    expect(opened(copy.json)).toEqual(opened(source.json));
    const ids = blockIds(copy.json);
    const old = new Set(blockIds(source.json));
    expect(ids).toHaveLength(old.size);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(ID);
      expect(old.has(id)).toBe(false);
    }
    // Edited as any page is: another client types into it, and the copy merges with that.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, readFileSync(path));
    const body = (
      (doc.getXmlFragment('content').get(0) as Y.XmlElement).get(0) as Y.XmlElement
    ).get(0) as Y.XmlText;
    body.insert(0, 'New: ');
    expect(
      fragmentToJSON(doc.getXmlFragment('content')).content![0].content![0].content![0].text,
    ).toBe('New: Weekly team review');
  });
});
