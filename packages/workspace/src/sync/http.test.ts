// The SyncApi over HTTP against a scripted fetch: `Retry-After` on 429 and 503, and the two
// Phase 3 routes (the state hash and the repair) with their shapes.
import { createApi } from '@cgw/api';
import { describe, expect, it } from 'vitest';
import { SyncHttpError } from './api';
import { fromBase64, httpSyncApi, retryAfterMs, toBase64 } from './http';

const PAGE = '0193a1b2-c3d4-7e5f-8a9b-000000000001';

function server(answer: (request: Request) => Promise<Response> | Response) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const api = createApi({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: async () => 'token' },
    fetch: (async (input: Request) => {
      const text = input.method === 'GET' ? '' : await input.clone().text();
      seen.push({ method: input.method, url: input.url, body: text ? JSON.parse(text) : null });
      return answer(input);
    }) as typeof fetch,
  });
  return { sync: httpSyncApi(api), seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const pull = {
  epoch: 2,
  schemaVersion: 1,
  headSeq: '9',
  cursor: 9,
  more: false,
  snapshot: null,
  updates: [{ seq: 9, updateId: PAGE, data: toBase64(new Uint8Array([1, 2, 3])) }],
  rejected: [],
};

describe('http sync api', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    const at = Date.UTC(2026, 10, 12, 10, 0, 0);
    expect(retryAfterMs(new Date(at + 30_000).toUTCString(), at)).toBe(30_000);
    expect(retryAfterMs(new Date(at - 30_000).toUTCString(), at)).toBe(0);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
  });

  it('gives a 429 and a 503 their Retry-After, and nothing else one', async () => {
    let status = 429;
    const { sync } = server(() =>
      json(
        status,
        { code: status === 429 ? 'limit.rate' : 'server.unavailable' },
        {
          'Retry-After': '7',
        },
      ),
    );
    const caught = async () => {
      try {
        await sync.pullDoc(PAGE, 0);
      } catch (error) {
        return error as SyncHttpError;
      }
      throw new Error('no error');
    };
    expect(await caught()).toMatchObject({ status: 429, code: 'limit.rate', retryAfterMs: 7000 });
    status = 503;
    expect(await caught()).toMatchObject({ status: 503, retryAfterMs: 7000 });
    status = 500;
    const plain = await caught();
    expect(plain).toBeInstanceOf(SyncHttpError);
    expect(plain.retryAfterMs).toBeUndefined();
  });

  it('asks for the state hash', async () => {
    const { sync, seen } = server(() => json(200, { epoch: 2, upToSeq: '9', hash: 'ab' }));
    expect(await sync.docStateHash(PAGE)).toEqual({ epoch: 2, upToSeq: 9, hash: 'ab' });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `https://api.test/api/v1/pages/${PAGE}/doc/state-hash`,
    });
  });

  it('sends a repair with the full state, or none, and reads the pull from the start', async () => {
    const { sync, seen } = server(() => json(200, { ack: { updateId: PAGE, seq: '10' }, pull }));
    const answer = await sync.repairDoc(PAGE, {
      epoch: 2,
      clientSchemaVersion: 1,
      update: { updateId: PAGE, data: new Uint8Array([9, 8]) },
    });
    expect(answer.ack).toEqual({ updateId: PAGE, seq: 10 });
    expect(answer.pull).toMatchObject({ epoch: 2, headSeq: 9, cursor: 9, more: false });
    expect([...answer.pull.updates[0].data]).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: `https://api.test/api/v1/pages/${PAGE}/doc/repair`,
    });
    const body = seen[0].body as { update: { data: string } };
    expect([...fromBase64(body.update.data)]).toEqual([9, 8]);
    await sync.repairDoc(PAGE, { epoch: 2, clientSchemaVersion: 1, update: null });
    expect(seen[1].body).toEqual({ epoch: 2, clientSchemaVersion: 1, update: null });
  });
});
