import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErpClient } from './client';
import { ErpError, LIMITS, type ConnectSession } from './contract';
import {
  ErpSessions,
  RENEW_EVERY_MS,
  RENEW_RETRY_MS,
  type ConnectFlow,
  type ErpLinkRef,
  type ErpSessionState,
} from './session';

const MINUTE = 60_000;
const TICKET = 'T'.repeat(43);
const KIT: ErpLinkRef = { id: 'wl-kit', erpLinkId: 'erp-kit', workspaceId: 'ws-1' };
const DOT: ErpLinkRef = { id: 'wl-dot', erpLinkId: 'erp-dot', workspaceId: 'ws-1' };

const iso = (ms: number) => new Date(ms).toISOString();

/** An ERP client in memory: sessions as the contract makes them, on the ERP's clock. */
function fakeClient(skewMs = 0) {
  let n = 0;
  const erpNow = () => Date.now() + skewMs;
  const ended: { token: string; keepalive: boolean }[] = [];
  const tokens: string[] = [];
  const client = {
    apiBase: 'http://127.0.0.1:4282',
    redeemLink: vi.fn(),
    redeem: vi.fn(async (): Promise<ConnectSession> => {
      const token = `tok_${++n}_${'s'.repeat(40)}`;
      tokens.push(token);
      const linkId = client.nextLinkId ?? KIT.erpLinkId;
      return {
        token,
        expiresAt: iso(erpNow() + LIMITS.sessionIdleMs),
        maxExpiresAt: iso(erpNow() + LIMITS.sessionMaxMs),
        linkId,
        company: 'Kit',
        companyName: 'Kit Trading',
        user: { id: 'u101', displayName: 'Alice Haddad' },
        language: 'en',
      };
    }),
    renew: vi.fn(async () => ({
      expiresAt: iso(erpNow() + LIMITS.sessionIdleMs),
    })),
    end: vi.fn(async (token: string, options: { keepalive?: boolean } = {}) => {
      ended.push({ token, keepalive: options.keepalive ?? false });
    }),
    connectors: vi.fn(async () => []),
    schema: vi.fn(),
    query: vi.fn(),
    nextLinkId: undefined as string | undefined,
  };
  return { client: client as typeof client & ErpClient, ended, tokens };
}

function setup(options: { skewMs?: number; flow?: ConnectFlow } = {}): ReturnType<
  typeof fakeClient
> & {
  sessions: ErpSessions;
  target: EventTarget;
  heard: [string, ErpSessionState][];
  flow: ReturnType<typeof vi.fn>;
} {
  const fake = fakeClient(options.skewMs);
  const target = new EventTarget();
  const flow = vi.fn(options.flow ?? (async () => TICKET));
  const sessions = new ErpSessions({ client: fake.client, flow, target });
  const heard: [string, ErpSessionState][] = [];
  sessions.subscribe((linkId, state) => heard.push([linkId, state]));
  return { ...fake, sessions, target, heard, flow };
}

const activity = (target: EventTarget, type = 'keydown') => target.dispatchEvent(new Event(type));

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 14, 9, 0, 0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('runs the flow at once, redeems the ticket and holds the session', async () => {
    const { sessions, client, flow, heard, tokens } = setup();
    const done = sessions.connect(KIT);
    expect(flow).toHaveBeenCalledTimes(1);
    const request = flow.mock.calls[0]![0];
    expect(request).toMatchObject({ workspaceId: 'ws-1', erpLinkId: 'erp-kit' });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(sessions.state(KIT.id)).toBe('connecting');
    expect(await done).toBe('connected');
    expect(client.redeem).toHaveBeenCalledWith(TICKET, 'ws-1', expect.anything());
    expect(heard).toEqual([
      ['wl-kit', 'connecting'],
      ['wl-kit', 'connected'],
    ]);
    expect(sessions.session(KIT.id)).toMatchObject({ company: 'Kit', linkId: 'erp-kit' });
    expect(sessions.session(KIT.id)).not.toHaveProperty('token');
    expect(sessions.state(DOT.id)).toBe('none');
    expect(tokens).toHaveLength(1);
  });

  it('keeps the token where nothing can read it', async () => {
    const { sessions, tokens } = setup();
    await sessions.connect(KIT);
    const token = tokens[0]!;
    expect(JSON.stringify(sessions)).toBe('{"wl-kit":"connected"}');
    expect(inspect(sessions, { showHidden: true, depth: 10 })).not.toContain(token);
    expect(JSON.stringify(sessions.session(KIT.id))).not.toContain(token);
    expect(Object.values(sessions)).toEqual([]);
  });

  it('runs one connect at a time per link', async () => {
    const { sessions, flow } = setup();
    const first = sessions.connect(KIT);
    expect(sessions.connect(KIT)).toBe(first);
    await first;
    expect(await sessions.connect(KIT)).toBe('connected');
    expect(flow).toHaveBeenCalledTimes(1);
  });

  it('keeps each link apart', async () => {
    const { sessions, client } = setup();
    await sessions.connect(KIT);
    client.nextLinkId = DOT.erpLinkId;
    await sessions.connect(DOT);
    expect([sessions.state(KIT.id), sessions.state(DOT.id)]).toEqual(['connected', 'connected']);
    sessions.disconnect(KIT.id);
    expect([sessions.state(KIT.id), sessions.state(DOT.id)]).toEqual(['none', 'connected']);
  });

  it.each([
    ['the person closing the pop-up', new ErpError('connect.cancelled'), 'none'],
    ['a blocked pop-up', new ErpError('connect.blocked'), 'error'],
    ['a revoked link', new ErpError('link.revoked', { status: 403 }), 'revoked'],
    ['something unexpected', new TypeError('boom'), 'error'],
  ] as const)('ends in the right state after %s', async (_, failure, state) => {
    const { sessions, client } = setup({ flow: () => Promise.reject(failure) });
    expect(await sessions.connect(KIT)).toBe(state);
    expect(sessions.state(KIT.id)).toBe(state);
    expect(client.redeem).not.toHaveBeenCalled();
    if (state === 'error') expect(sessions.error(KIT.id)).toBeInstanceOf(ErpError);
  });

  it('takes a flow that throws at once', async () => {
    const { sessions } = setup({
      flow: () => {
        throw new ErpError('connect.blocked');
      },
    });
    expect(await sessions.connect(KIT)).toBe('error');
    expect(sessions.error(KIT.id)?.code).toBe('connect.blocked');
  });

  it('reports a refused redeem', async () => {
    const { sessions, client } = setup();
    client.redeem.mockRejectedValueOnce(new ErpError('ticket.invalid', { status: 401 }));
    expect(await sessions.connect(KIT)).toBe('error');
    expect(sessions.error(KIT.id)?.code).toBe('ticket.invalid');
    client.redeem.mockRejectedValueOnce(new ErpError('link.revoked', { status: 403 }));
    expect(await sessions.connect(KIT)).toBe('revoked');
  });

  it('ends at once a session for another link', async () => {
    const { sessions, client, ended, tokens } = setup();
    client.nextLinkId = 'erp-someone-else';
    expect(await sessions.connect(KIT)).toBe('error');
    expect(sessions.error(KIT.id)?.code).toBe('response.invalid');
    expect(ended.map((e) => e.token)).toEqual(tokens);
  });

  it('cancels a connect that is waiting', async () => {
    let signal: AbortSignal | undefined;
    const { sessions } = setup({
      flow: (request) =>
        new Promise((_resolve, reject) => {
          signal = request.signal;
          request.signal.addEventListener('abort', () => reject(new ErpError('aborted')));
        }),
    });
    const done = sessions.connect(KIT);
    sessions.cancel(KIT.id);
    expect(signal?.aborted).toBe(true);
    expect(await done).toBe('none');
  });
});

describe('renewing', () => {
  it('renews at most every 5 minutes, and only after activity', async () => {
    const { sessions, client, target } = setup();
    await sessions.connect(KIT);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    activity(target);
    expect(client.renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    activity(target, 'pointerdown');
    activity(target, 'scroll');
    activity(target, 'wheel');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RENEW_EVERY_MS - 1);
    activity(target);
    expect(client.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    activity(target, 'touchstart');
    expect(client.renew).toHaveBeenCalledTimes(2);
    // Requests are not activity: nothing renews without the person.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    await sessions.connectors(KIT.id);
    expect(client.renew).toHaveBeenCalledTimes(2);
  });

  it('expires a session left alone, without a request', async () => {
    const { sessions, client, heard } = setup();
    await sessions.connect(KIT);
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('connected');
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('expired');
    expect(heard.at(-1)).toEqual(['wl-kit', 'expired']);
    await expect(sessions.connectors(KIT.id)).rejects.toMatchObject({ code: 'session.expired' });
    expect(client.connectors).not.toHaveBeenCalled();
  });

  it('keeps a renewed session past its first expiry', async () => {
    const { sessions, target } = setup();
    await sessions.connect(KIT);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    activity(target);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('connected');
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('expired');
  });

  it('never keeps a session past its ten hours', async () => {
    const { sessions, target, client } = setup();
    await sessions.connect(KIT);
    for (let t = 0; t < 10 * 60; t += 10) {
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      if (sessions.state(KIT.id) === 'connected') activity(target);
    }
    expect(sessions.state(KIT.id)).toBe('expired');
    expect(client.renew.mock.calls.length).toBeGreaterThan(50);
  });

  it('reads the ERP’s times on its own clock', async () => {
    const { sessions } = setup({ skewMs: -3 * 60 * MINUTE });
    await sessions.connect(KIT);
    expect(sessions.state(KIT.id)).toBe('connected');
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('connected');
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(sessions.state(KIT.id)).toBe('expired');
  });

  it('tries again sooner after a Renew without an answer', async () => {
    const { sessions, client, target } = setup();
    await sessions.connect(KIT);
    client.renew.mockRejectedValueOnce(new ErpError('network'));
    await vi.advanceTimersByTimeAsync(RENEW_EVERY_MS);
    activity(target);
    await vi.advanceTimersByTimeAsync(RENEW_RETRY_MS - 1);
    activity(target);
    expect(client.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    activity(target);
    expect(client.renew).toHaveBeenCalledTimes(2);
    expect(sessions.state(KIT.id)).toBe('connected');
  });

  it.each([
    ['session.expired', 401, 'expired'],
    ['link.revoked', 403, 'revoked'],
  ] as const)('ends the session when Renew answers %s', async (code, status, state) => {
    const { sessions, client, target } = setup();
    await sessions.connect(KIT);
    client.renew.mockRejectedValueOnce(new ErpError(code, { status }));
    await vi.advanceTimersByTimeAsync(RENEW_EVERY_MS);
    activity(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state(KIT.id)).toBe(state);
    await expect(sessions.connectors(KIT.id)).rejects.toMatchObject({ code });
  });
});

describe('requests', () => {
  it('sends the token for the link, and refuses without a session', async () => {
    const { sessions, client, tokens } = setup();
    await expect(sessions.connectors(KIT.id)).rejects.toMatchObject({ code: 'session.none' });
    await sessions.connect(KIT);
    await sessions.connectors(KIT.id);
    expect(client.connectors).toHaveBeenCalledWith(tokens[0], undefined);
  });

  it.each([
    ['session.expired', 401, 'expired'],
    ['link.revoked', 403, 'revoked'],
    ['privilege.denied', 403, 'connected'],
    ['network', null, 'connected'],
  ] as const)('after %s the link is %s', async (code, status, state) => {
    const { sessions, client } = setup();
    await sessions.connect(KIT);
    client.connectors.mockRejectedValueOnce(new ErpError(code, { status }));
    await expect(sessions.connectors(KIT.id)).rejects.toMatchObject({ code });
    expect(sessions.state(KIT.id)).toBe(state);
  });
});

describe('ending', () => {
  it('ends every session with keepalive when the page is hidden', async () => {
    const { sessions, client, target, ended, tokens } = setup();
    await sessions.connect(KIT);
    client.nextLinkId = DOT.erpLinkId;
    await sessions.connect(DOT);
    target.dispatchEvent(new Event('pagehide'));
    expect(ended).toEqual([
      { token: tokens[0], keepalive: true },
      { token: tokens[1], keepalive: true },
    ]);
    expect([sessions.state(KIT.id), sessions.state(DOT.id)]).toEqual(['none', 'none']);
    await expect(sessions.connectors(KIT.id)).rejects.toMatchObject({ code: 'session.none' });
  });

  it('ends one session when the person disconnects', async () => {
    const { sessions, ended, tokens } = setup();
    await sessions.connect(KIT);
    sessions.disconnect(KIT.id);
    expect(ended).toEqual([{ token: tokens[0], keepalive: false }]);
    expect(sessions.state(KIT.id)).toBe('none');
  });

  it('stops listening once disposed', async () => {
    const { sessions, client, target, ended } = setup();
    await sessions.connect(KIT);
    sessions.dispose();
    expect(ended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RENEW_EVERY_MS);
    activity(target);
    target.dispatchEvent(new Event('pagehide'));
    expect(client.renew).not.toHaveBeenCalled();
    expect(ended).toHaveLength(1);
    expect(await sessions.connect(KIT)).toBe('none');
  });
});
