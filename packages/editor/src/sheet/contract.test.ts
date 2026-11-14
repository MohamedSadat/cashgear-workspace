// sheet-embed.1's validators on what JSON vectors cannot hold (typed arrays, getters, symbols,
// other realms), the range helpers and `viewHash`. The verdicts on JSON messages are the
// vectors' (vectors.test.ts).
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  SHEET_LIMITS,
  canonicalRange,
  initContract,
  parseEmbedMessage,
  parseParentMessage,
  parseRange,
  rangeCells,
  viewHash,
  type SheetView,
} from './contract';

const ETAG = '"v1"';
const source = { kind: 'url', url: 'https://example.com/b.xlsx', etag: ETAG };
const view = { kind: 'range', sheet: 'Budget', range: 'A1:D20' };
const init = {
  type: 'init',
  contract: 'sheet-embed.1',
  source,
  view,
  theme: 'light',
  direction: 'ltr',
  locale: 'en',
};
const png = () =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
const preview = () => ({
  type: 'preview',
  id: 'p1',
  bytes: png(),
  width: 10,
  height: 10,
  etag: ETAG,
  view,
});

describe('parseParentMessage and parseEmbedMessage', () => {
  it('accept the plain messages these tests build on', () => {
    expect(parseParentMessage(init)).not.toBeNull();
    expect(parseEmbedMessage(preview())).not.toBeNull();
  });

  it('return fresh objects holding only the contract fields', () => {
    const parsed = parseParentMessage(init)!;
    expect(parsed).toEqual(init);
    expect(parsed).not.toBe(init);
    expect((parsed as typeof init).view).not.toBe(view);
    expect((parsed as typeof init).source).not.toBe(source);
  });

  it('leave out an error id that was not sent', () => {
    const parsed = parseEmbedMessage({ type: 'error', code: 'view.notFound', message: '' })!;
    expect(Object.keys(parsed)).toEqual(['type', 'code', 'message']);
  });

  it('take a message from another realm (a structured clone in a frame) or with no prototype', () => {
    const foreign = runInNewContext('(' + JSON.stringify(init) + ')') as unknown;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(parseParentMessage(foreign)).not.toBeNull();
    const bare = Object.assign(Object.create(null) as object, { type: 'openRequested' });
    expect(parseEmbedMessage(bare)).toEqual({ type: 'openRequested' });
    const bytes = runInNewContext('new ArrayBuffer(4)') as unknown;
    expect(parseParentMessage({ ...init, source: { kind: 'bytes', bytes, etag: ETAG } })).not.toBe(
      null,
    );
  });

  it('refuse bytes that are not an ArrayBuffer', () => {
    const withBytes = (bytes: unknown) => ({
      ...init,
      source: { kind: 'bytes', bytes, etag: ETAG },
    });
    expect(parseParentMessage(withBytes(new ArrayBuffer(4)))).not.toBeNull();
    expect(parseParentMessage(withBytes(new Uint8Array(4)))).toBeNull();
    expect(parseParentMessage(withBytes(new DataView(new ArrayBuffer(4))))).toBeNull();
    expect(parseParentMessage(withBytes(new SharedArrayBuffer(4)))).toBeNull();
    expect(parseParentMessage(withBytes(new Blob([])))).toBeNull();
    expect(parseEmbedMessage({ ...preview(), bytes: new Uint8Array(png()) })).toBeNull();
  });

  it('check a preview against the 2 MiB limit', () => {
    const big = (n: number) => {
      const bytes = new Uint8Array(n);
      bytes.set(new Uint8Array(png()));
      return { ...preview(), bytes: bytes.buffer };
    };
    expect(parseEmbedMessage(big(SHEET_LIMITS.previewBytes))).not.toBeNull();
    expect(parseEmbedMessage(big(SHEET_LIMITS.previewBytes + 1))).toBeNull();
  });

  it('refuse objects that are not plain', () => {
    class Message {
      type = 'openRequested';
    }
    expect(parseEmbedMessage(new Message())).toBeNull();
    expect(parseEmbedMessage(new Map([['type', 'openRequested']]))).toBeNull();
    expect(parseEmbedMessage(Object.assign(new Date(0), { type: 'openRequested' }))).toBeNull();
    expect(parseEmbedMessage(Object.assign([], { type: 'openRequested' }))).toBeNull();
    expect(parseEmbedMessage(Object.create({ type: 'openRequested' }))).toBeNull();
  });

  it('read only own data properties', () => {
    const inherited = Object.create({ contract: 'sheet-embed.1' }) as Record<string, unknown>;
    Object.assign(inherited, { ...init });
    delete inherited.contract;
    expect(parseParentMessage(inherited)).toBeNull();

    let reads = 0;
    const getter = { ...init };
    Object.defineProperty(getter, 'theme', {
      enumerable: true,
      get: () => (reads++ === 0 ? 'light' : 'evil'),
    });
    expect(parseParentMessage(getter)).toBeNull();

    const hidden = { ...init };
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
    expect(parseParentMessage(hidden)).toBeNull();

    expect(parseParentMessage({ ...init, [Symbol('x')]: 1 })).toBeNull();
  });

  it('never change Object.prototype, whatever the keys', () => {
    const message = JSON.parse(
      '{"type":"setView","view":{"kind":"range","sheet":null,"range":null},"__proto__":{"polluted":true}}',
    ) as unknown;
    expect(parseParentMessage(message)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('name the contract an init offers, for the embed side', () => {
    expect(initContract({ ...init, contract: 'sheet-embed.2' })).toBe('sheet-embed.2');
    expect(initContract(init)).toBe('sheet-embed.1');
    expect(initContract({ ...init, contract: 2 })).toBeNull();
    expect(initContract({ ...init, contract: '' })).toBeNull();
    expect(initContract({ type: 'setView', contract: 'sheet-embed.2' })).toBeNull();
    expect(initContract(null)).toBeNull();
  });
});

describe('ranges', () => {
  it('count cells, corners in either order', () => {
    expect(rangeCells('A1')).toBe(1);
    expect(rangeCells('A1:D20')).toBe(80);
    expect(rangeCells('D20:A1')).toBe(80);
    expect(rangeCells('A20:D1')).toBe(80);
    expect(rangeCells('A1:XFD1048576')).toBe(16_384 * 1_048_576);
    expect(rangeCells('A1:BX67')).toBe(76 * 67);
    expect(rangeCells('XFE1')).toBeNull();
    expect(rangeCells(null)).toBeNull();
    expect(rangeCells('a1')).toBeNull();
  });

  it('parse columns as Excel names them', () => {
    expect(parseRange('Z1:AA1')).toEqual({ top: 1, left: 26, bottom: 1, right: 27 });
    expect(parseRange('AZ1:BA1')).toEqual({ top: 1, left: 52, bottom: 1, right: 53 });
    expect(parseRange('XFD1')).toEqual({ top: 1, left: 16_384, bottom: 1, right: 16_384 });
  });

  it('write a range top-left first, one cell as one', () => {
    expect(canonicalRange('D20:A1')).toBe('A1:D20');
    expect(canonicalRange('A20:D1')).toBe('A1:D20');
    expect(canonicalRange('AA10:Z1')).toBe('Z1:AA10');
    expect(canonicalRange('B2:B2')).toBe('B2');
    expect(canonicalRange('A1:D20')).toBe('A1:D20');
    expect(canonicalRange('A0')).toBeNull();
  });
});

describe('viewHash', () => {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

  it('hashes the canonical JSON of the view, keys sorted', async () => {
    expect(await viewHash({ kind: 'range', sheet: 'Budget', range: 'A1:D20' })).toBe(
      sha('{"v":1,"view":{"kind":"range","range":"A1:D20","sheet":"Budget"}}'),
    );
    expect(await viewHash({ kind: 'chart', sheet: 'الميزانية', chartId: 'Chart 1' })).toBe(
      sha('{"v":1,"view":{"chartId":"Chart 1","kind":"chart","sheet":"الميزانية"}}'),
    );
    expect(await viewHash({ kind: 'range', sheet: null, range: null })).toBe(
      sha('{"v":1,"view":{"kind":"range","range":null,"sheet":null}}'),
    );
  });

  it('is 64 lower-case hex digits and ignores fields outside the view', async () => {
    const plain: SheetView = { kind: 'range', sheet: 'S"1', range: 'B2' };
    const hash = await viewHash(plain);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha('{"v":1,"view":{"kind":"range","range":"B2","sheet":"S\\"1"}}'));
    const extra = { range: 'B2', junk: 1, sheet: 'S"1', kind: 'range' } as unknown as SheetView;
    expect(await viewHash(extra)).toBe(hash);
  });
});
