// The forms host over the server's routes (Phase 16): a form's state and its link read, the link
// made, changed and deleted by those routes with their bodies, a refusal's code as the error's
// message (the views say it), and offline before anything is asked.
import { createApi } from '@cgw/api';
import { describe, expect, it } from 'vitest';
import { ShellForms } from './host';

const DB = '01900000-0000-7000-8000-000000000001';
const VIEW = '01900000-0000-7000-8000-000000000002';
const LINK = {
  id: '01900000-0000-7000-8000-000000000003',
  url: 'https://pages.example/_form/abc',
  enabled: true,
  closesAt: null,
  maxAnswers: 5,
  answers: '2',
  state: 'open',
  createdBy: null,
  createdAt: '2026-11-24T10:00:00Z',
  version: 1,
};

function forms(answer: (request: Request) => Response, online = true) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const api = createApi({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: async () => 'token' },
    fetch: (async (input: Request) => {
      const text =
        input.method === 'GET' || input.method === 'DELETE' ? '' : await input.clone().text();
      seen.push({ method: input.method, url: input.url, body: text ? JSON.parse(text) : null });
      return answer(input);
    }) as typeof fetch,
  });
  return { host: new ShellForms({ api, online: () => online }), seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the forms host', () => {
  it("reads a form's answers and link, and makes, changes and deletes the link", async () => {
    const { host, seen } = forms((request) => {
      if (request.method === 'GET')
        return json({ answers: 7, link: LINK, canManage: true, linksAllowed: true });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ ...LINK, enabled: request.method !== 'PUT' });
    });
    const state = await host.state(DB, VIEW);
    expect(state).toEqual({
      answers: 7,
      link: { ...LINK, answers: 2, createdBy: undefined, version: undefined },
      canManage: true,
      linksAllowed: true,
    });
    const settings = { enabled: false, closesAt: '2026-12-01T00:00:00.000Z', maxAnswers: null };
    expect((await host.createLink(DB, VIEW, settings)).enabled).toBe(true);
    expect((await host.updateLink(DB, VIEW, settings)).enabled).toBe(false);
    await host.deleteLink(DB, VIEW);
    const path = `https://api.test/api/v1/databases/${DB}/views/${VIEW}/form`;
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', path],
      ['POST', `${path}/link`],
      ['PUT', `${path}/link`],
      ['DELETE', `${path}/link`],
    ]);
    expect(seen[2].body).toEqual(settings);
  });

  it('says a refusal by its code, and offline as offline', async () => {
    const { host } = forms(() =>
      json({ code: 'form.linkExists', title: 'The form has a link' }, 409),
    );
    await expect(
      host.createLink(DB, VIEW, { enabled: true, closesAt: null, maxAnswers: null }),
    ).rejects.toThrow('form.linkExists');
    const down = forms(() => {
      throw new TypeError('Failed to fetch');
    }, false);
    expect(down.host.online()).toBe(false);
    await expect(down.host.state(DB, VIEW)).rejects.toThrow('offline');
  });
});
