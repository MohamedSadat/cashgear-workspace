// The state hash (contracts, section 2), on documents whose state is worked out by hand, and on
// the vectors the server's side made with plain Yjs (`vectors/state-hash-vectors.json`), which
// `cgw-ydoc`'s `state_hash` checks too.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docCodec } from './codec';
import { canonicalStateText, stateHash, stateText } from './stateHash';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function client(id: number, from?: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = id;
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}

describe('canonical state text', () => {
  it('sorts clients, leaves out clock 0, sorts and merges ranges, end exclusive', () => {
    const sv = new Map([
      [30, 4],
      [7, 12],
      [9, 0],
      [100, 1],
    ]);
    const ds = new Map([
      [
        30,
        [
          { clock: 3, len: 1 },
          { clock: 0, len: 2 },
        ],
      ],
      [
        7,
        [
          { clock: 5, len: 2 }, // 5-7
          { clock: 0, len: 1 }, // 0-1
          { clock: 7, len: 1 }, // adjacent: 5-8
          { clock: 6, len: 4 }, // overlapping: 5-10
          { clock: 11, len: 0 }, // empty, left out
        ],
      ],
      [8, []],
    ]);
    expect(canonicalStateText(sv, ds)).toBe('v1;sv=7:12,30:4,100:1;ds=7:0-1,7:5-10,30:0-2,30:3-4');
    expect(canonicalStateText(new Map(), new Map())).toBe('v1;sv=;ds=');
  });

  it('is what a hand-built document holds', async () => {
    // Client 7 types "abc" (clocks 0 to 2); client 3 types "xy" at the start (clocks 0 and 1).
    const a = client(7);
    a.getText('t').insert(0, 'abc');
    const b = client(3, a);
    b.getText('t').insert(0, 'xy');
    // Client 3 deletes "a" (client 7, clock 0), then "c" (client 7, clock 2): deletes write no
    // structs, so client 3's clock stays at 2, and the delete set names client 7's structs.
    b.getText('t').delete(2, 1);
    expect(b.getText('t').toString()).toBe('xybc');
    b.getText('t').delete(3, 1);
    expect(b.getText('t').toString()).toBe('xyb');
    const parts = [Y.encodeStateAsUpdate(b)];
    // Not adjacent, so two ranges.
    expect(stateText(parts)).toBe('v1;sv=3:2,7:3;ds=7:0-1,7:2-3');
    // SHA-256 of that text, worked out with another implementation (node:crypto, and by hand
    // with `node -e` when this test was written).
    expect(await stateHash(parts)).toBe(
      'bfa845f22d808443507c5645af755191211abda90d521773d6bc3af7a759f913',
    );
    expect(await stateHash(parts)).toBe(sha('v1;sv=3:2,7:3;ds=7:0-1,7:2-3'));
  });

  it('merges deletes of neighbouring structs into one range', () => {
    const a = client(5);
    a.getText('t').insert(0, 'abcdef');
    a.getText('t').delete(1, 1); // b: clock 1
    a.getText('t').delete(1, 1); // c: clock 2, adjacent
    // A map key set twice: the first value (client 5, clock 6) is deleted.
    a.getMap('m').set('k', 1);
    a.getMap('m').set('k', 2);
    expect(stateText([Y.encodeStateAsUpdate(a)])).toBe('v1;sv=5:8;ds=5:1-3,5:6-7');
  });

  it('the empty document', async () => {
    expect(stateText([])).toBe('v1;sv=;ds=');
    expect(await stateHash([])).toBe(
      '340499d3ba7e2b54e9a2f12f4707b92573f71a5599554b39b1a999acd6b6ab52',
    );
    expect(await stateHash([])).toBe(sha('v1;sv=;ds='));
  });
});

describe('the state hash is a property of the state, not of the bytes', () => {
  function history() {
    const a = client(11);
    const b = client(22);
    const updates: Uint8Array[] = [];
    a.on('update', (u: Uint8Array) => updates.push(u));
    b.on('update', (u: Uint8Array) => updates.push(u));
    a.getXmlFragment('content').insert(0, [new Y.XmlText('hello')]);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'sync');
    b.getMap('meta').set('schemaVersion', 1);
    (b.getXmlFragment('content').get(0) as Y.XmlText).insert(5, ' world');
    (a.getXmlFragment('content').get(0) as Y.XmlText).delete(0, 1);
    return { a, b, updates: updates.filter((u) => u.length > 2) };
  }

  it('the same for any order, merged or not, and with a snapshot first', async () => {
    const { updates } = history();
    const forward = await stateHash(updates);
    expect(await stateHash([...updates].reverse())).toBe(forward);
    expect(await stateHash([Y.mergeUpdates(updates)])).toBe(forward);
    const snapshot = Y.mergeUpdates(updates.slice(0, 2));
    expect(await stateHash([snapshot, ...updates.slice(2)])).toBe(forward);
    // Applying an update twice changes nothing.
    expect(await stateHash([...updates, ...updates])).toBe(forward);
    expect(await docCodec.stateHash(updates)).toBe(forward);
  });

  it('differs when one device is missing an update', async () => {
    const { updates } = history();
    expect(await stateHash(updates.slice(0, -1))).not.toBe(await stateHash(updates));
  });

  it('is the same whether the document collected garbage or not', () => {
    const { a, b } = history();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const kept = new Y.Doc({ gc: false });
    Y.applyUpdate(kept, Y.encodeStateAsUpdate(a));
    expect(stateText([Y.encodeStateAsUpdate(kept)])).toBe(stateText([Y.encodeStateAsUpdate(a)]));
  });

  it('heals the Yjs pending-order case first (S1 fixture)', () => {
    const updates = (
      JSON.parse(
        readFileSync(
          new URL('../../../bench/editor/fixtures/yjs-pending-order.json', import.meta.url),
          'utf8',
        ),
      ) as string[]
    ).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
    expect(stateText(updates)).toBe(stateText([Y.mergeUpdates(updates)]));
  });

  it('refuses a part that does not decode', () => {
    expect(() => stateText([new Uint8Array([255, 1, 2, 3])])).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Vectors shared with the server (made with plain Yjs by the server's side).

const vectorsFile = join(__dirname, '..', 'vectors', 'state-hash-vectors.json');

interface Vector {
  name?: string;
  parts: Uint8Array[];
  text?: string;
  hash: string;
}

function readVectors(): Vector[] {
  const raw = JSON.parse(readFileSync(vectorsFile, 'utf8')) as unknown;
  const list = (
    Array.isArray(raw) ? raw : ((raw as { vectors?: unknown[] }).vectors ?? [])
  ) as Record<string, unknown>[];
  const bytes = (b64: unknown) => new Uint8Array(Buffer.from(String(b64), 'base64'));
  return list.map((v) => ({
    name: typeof v.name === 'string' ? v.name : undefined,
    parts: Array.isArray(v.parts)
      ? v.parts.map(bytes)
      : Array.isArray(v.updates)
        ? v.updates.map(bytes)
        : [bytes(v.update)],
    text: (v.text ?? v.canonical ?? v.canonicalText) as string | undefined,
    hash: String(v.hash),
  }));
}

describe.skipIf(!existsSync(vectorsFile))('state-hash vectors shared with the server', () => {
  it('every vector gives its canonical text and hash', async () => {
    const vectors = readVectors();
    expect(vectors.length).toBeGreaterThan(0);
    for (const [i, vector] of vectors.entries()) {
      const name = vector.name ?? `vector ${i}`;
      if (vector.text !== undefined) expect(stateText(vector.parts), name).toBe(vector.text);
      expect(await stateHash(vector.parts), name).toBe(vector.hash);
    }
  });
});
