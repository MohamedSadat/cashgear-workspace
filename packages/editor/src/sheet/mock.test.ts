// The mock Sheet (tests/mocks/sheet): its own sheet-embed.1 validator gives every shared vector's
// verdict, its xlsx writer and reader agree with each other and with zlib, and its server sends
// the headers and answers the controls the browser tests rely on.
import { readFileSync } from 'node:fs';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeVector, type SheetEmbedVectors } from './vectors.cases';

type Cell = number | string | boolean;
interface Sheet {
  name: string;
  kind: string;
  state: string;
  rtl: boolean;
  cells: Map<string, Cell>;
}
interface Protocol {
  parseParentMessage(value: unknown): unknown;
  otherContract(value: unknown): string | null;
  rangeBounds(value: unknown): { top: number; left: number; bottom: number; right: number } | null;
}
interface Xlsx {
  crc32(bytes: Uint8Array): number;
  zip(entries: [string, string | Uint8Array][]): Uint8Array;
  unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>>;
  writeXlsx(book: { sheets: object[] }): Uint8Array;
  readXlsx(bytes: Uint8Array): Promise<{ sheets: Sheet[] }>;
}
interface Server {
  startSheetMock(options: { port: number; api: string }): Promise<{
    url: string;
    port: number;
    close(): Promise<void>;
  }>;
}
interface Fixtures {
  budgetBook(): Uint8Array;
  wideBook(): Uint8Array;
}

const mockFile = (name: string) =>
  new URL(`../../../../tests/mocks/sheet/${name}`, import.meta.url);
const load = async <T>(name: string) => (await import(/* @vite-ignore */ mockFile(name).href)) as T;
const protocol = await load<Protocol>('protocol.mjs');
const xlsx = await load<Xlsx>('xlsx.mjs');
const { startSheetMock } = await load<Server>('server.mjs');
const fixtures = await load<Fixtures>('fixtures.mjs');

const vectors = JSON.parse(
  readFileSync(new URL('../../vectors/sheet-embed-vectors.json', import.meta.url), 'utf8'),
) as SheetEmbedVectors;

describe("the mock embed's own validator", () => {
  for (const vector of vectors.parent) {
    it(`${vector.valid ? 'valid' : 'invalid'}: ${vector.name}`, () => {
      const message = decodeVector(vector.message);
      expect(protocol.parseParentMessage(message) !== null).toBe(vector.valid);
    });
  }

  it('names a contract it does not speak', () => {
    const init = decodeVector(
      vectors.parent.find((v) => v.name.startsWith('init: a signed'))!.message,
    );
    expect(protocol.otherContract(init)).toBeNull();
    expect(protocol.otherContract({ ...(init as object), contract: 'sheet-embed.2' })).toBe(
      'sheet-embed.2',
    );
    expect(protocol.otherContract({ ...(init as object), contract: 2 })).toBeNull();
  });
});

describe('the mock xlsx writer and reader', () => {
  it('computes CRC-32 as zlib does', () => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff);
    expect(xlsx.crc32(bytes)).toBe(zlibCrc32(bytes));
    expect(xlsx.crc32(new Uint8Array())).toBe(0);
  });

  it('reads back what it writes', async () => {
    const book = await xlsx.readXlsx(fixtures.budgetBook());
    expect(book.sheets.map((s) => [s.name, s.kind, s.state, s.rtl])).toEqual([
      ['Budget', 'worksheet', 'visible', false],
      ['الميزانية', 'worksheet', 'visible', true],
      ['Hidden notes', 'worksheet', 'hidden', false],
    ]);
    const budget = book.sheets[0]!.cells;
    expect(budget.get('A1')).toBe('Item');
    expect(budget.get('C3')).toBe(280);
    expect(budget.get('B3')).toBe(300.5);
    expect(budget.get('D2')).toBe(true);
    expect(budget.get('A4')).toBe('Software & tools');
    expect(book.sheets[1]!.cells.get('A2')).toBe('الإيجار');
  });

  it('reads deflated entries, as Sheet and the server write them', async () => {
    const stored = await xlsx.unzip(fixtures.budgetBook());
    const deflated = deflatedZip([...stored]);
    const book = await xlsx.readXlsx(deflated);
    expect(book.sheets[0]!.cells.get('A4')).toBe('Software & tools');
  });

  it('refuses what is not a workbook', async () => {
    await expect(xlsx.readXlsx(new TextEncoder().encode('not a zip'))).rejects.toThrow();
    await expect(xlsx.readXlsx(xlsx.zip([['a.txt', 'a']]))).rejects.toThrow();
  });
});

/** A zip whose entries are deflated (method 8), made with zlib, to read with the mock. */
function deflatedZip(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = zlibCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    central.push(header, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

describe('the mock server', () => {
  let server: Awaited<ReturnType<Server['startSheetMock']>>;
  const own = () => ({ Origin: `http://127.0.0.1:${server.port}` });
  beforeAll(async () => {
    server = await startSheetMock({ port: 0, api: 'http://127.0.0.1:5999' });
  });
  afterAll(() => server.close());
  const control = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, {
      method: 'POST',
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });

  it('sends /embed framable by Workspace only', async () => {
    const response = await fetch(`${server.url}/embed`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(
      'frame-ancestors http://127.0.0.1:5273 http://127.0.0.1:4273 http://localhost:5273 ' +
        'http://localhost:4273 tauri://localhost http://tauri.localhost',
    );
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(await response.text()).toContain('/embed.js');
    const script = await fetch(`${server.url}/embed.js`);
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
  });

  it('sends /cloud with the Workspace API it redeems at, never framed', async () => {
    const response = await fetch(`${server.url}/cloud`);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(await response.text()).toContain(
      '<meta name="cgw-api" content="http://127.0.0.1:5999" />',
    );
  });

  it('takes faults and hands them out once each, by message type', async () => {
    expect((await control('/__mock/fault', { body: '{"code":"nope"}' })).status).toBe(400);
    expect(
      (await control('/__mock/fault', { body: '{"code":"view.notFound","on":"x"}' })).status,
    ).toBe(400);
    await control('/__mock/fault', { body: '{"code":"source.forbidden","on":"refresh"}' });
    await control('/__mock/fault', { body: '{"code":"range.tooLarge","times":2}' });
    const next = async (on: string) =>
      (
        (await (await control(`/__mock/next-fault?on=${on}`, { headers: own() })).json()) as {
          code: string | null;
        }
      ).code;
    expect(await next('refresh')).toBe('source.forbidden');
    expect(await next('refresh')).toBe('range.tooLarge');
    expect(await next('setView')).toBe('range.tooLarge');
    expect(await next('setView')).toBeNull();
  });

  it('records what its pages report and refuses other origins', async () => {
    await control('/__mock/reset');
    const sent = await control('/__mock/event', {
      headers: own(),
      body: JSON.stringify({ page: 'embed', kind: 'ready' }),
    });
    expect(sent.status).toBe(204);
    const state = (await (await fetch(`${server.url}/__mock/state`)).json()) as {
      events: { kind: string }[];
    };
    expect(state.events.map((e) => e.kind)).toEqual(['ready']);
    const foreign = await control('/__mock/fault', {
      headers: { Origin: 'http://127.0.0.1:4273' },
      body: '{"code":"view.notFound"}',
    });
    expect(foreign.status).toBe(403);
  });

  it('serves its fixture workbooks, refused or padded on request', async () => {
    const budget = await fetch(`${server.url}/__mock/fixture/budget.xlsx`);
    expect(budget.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const book = await xlsx.readXlsx(new Uint8Array(await budget.arrayBuffer()));
    expect(book.sheets[0]!.name).toBe('Budget');
    expect((await fetch(`${server.url}/__mock/fixture/budget.xlsx?status=403`)).status).toBe(403);
    const padded = await fetch(`${server.url}/__mock/fixture/empty.xlsx?pad=1000`);
    expect(Number(padded.headers.get('content-length'))).toBeGreaterThan(1000);
    expect((await fetch(`${server.url}/__mock/fixture/nothing.xlsx`)).status).toBe(404);
  });
});
