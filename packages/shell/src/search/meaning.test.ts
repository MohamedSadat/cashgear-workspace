// Phase 10, search by meaning in the client (jsdom): when it is offered (as AI's rules, with its
// own switch), the question as the route takes it, only the latest question asked and only once
// the person pauses, the route's hits read as word search's, the pages the words did not find kept
// in the server's order; and Settings' part of it for owners and admins: its switch, the Voyage AI
// key kept as the Anthropic one is, the model, the month's use and the progress.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
Object.assign(globalThis, {
  location: window.location,
  history: window.history,
  EventTarget: window.EventTarget,
});
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { createI18n } = await import('../i18n');
const { CloudContext } = await import('../cloud/CloudUi');
const { AiSettingsSection } = await import('../ai/AiSettings');
const { cloudAiApi, settingsOf } = await import('../ai/api');
const { aiEn } = await import('../ai/i18n');
const {
  MEANING_PAUSE_MS,
  MeaningAsker,
  MeaningError,
  meaningOffered,
  meaningQuestion,
  meaningSearch,
  relatedByMeaning,
} = await import('./meaning');
type RemoteSearchHit = import('../session').RemoteSearchHit;
type AiSettingsState = import('../ai/store').AiSettingsState;
type Cloud = import('../cloud/cloud').Cloud;
type WorkspaceSession = import('../session').WorkspaceSession;

const WS = '01936f6e-0000-7000-8000-00000000e001';
const T = aiEn.ai;
const hit = (pageId: string, title = pageId): RemoteSearchHit => ({
  pageId,
  title,
  snippet: '',
  score: 0.5,
  kind: 'page',
  databaseId: null,
});

const ON = {
  enabled: true,
  provider: 'voyage' as const,
  model: 'voyage-4',
  models: ['voyage-4', 'voyage-4-large', 'voyage-4-lite'],
  keySource: 'own' as const,
};
const ready = (embeddings: typeof ON | undefined, completions = false): AiSettingsState => ({
  status: 'ready',
  settings: {
    enabled: completions,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    models: [],
    keySource: 'own',
    ...(embeddings ? { embeddings } : {}),
  },
});

describe('when search by meaning is offered', () => {
  const context = { signedIn: true, synced: true, role: 'member', online: true };

  it('needs an account, a synced workspace, no guest, a network and its own switch on', () => {
    // On while AI's completions are off: it needs no Anthropic key.
    expect(meaningOffered(ready(ON), context)).toBe(true);
    expect(meaningOffered(ready(ON), { ...context, signedIn: false })).toBe(false);
    expect(meaningOffered(ready(ON), { ...context, synced: false })).toBe(false);
    expect(meaningOffered(ready(ON), { ...context, role: 'guest' })).toBe(false);
    expect(meaningOffered(ready(ON), { ...context, online: false })).toBe(false);
    expect(meaningOffered(ready({ ...ON, enabled: false }, true), context)).toBe(false);
    // A server before Phase 10 says nothing of it: off.
    expect(meaningOffered(ready(undefined, true), context)).toBe(false);
    expect(meaningOffered({ status: 'idle' }, context)).toBe(false);
    expect(meaningOffered({ status: 'loading', settings: null }, context)).toBe(false);
  });

  it('asks the question trimmed, of three characters at least and a thousand at most', () => {
    expect(meaningQuestion('  ab ')).toBeNull();
    expect(meaningQuestion(' كيف ')).toBe('كيف');
    expect(meaningQuestion('x'.repeat(1200))).toHaveLength(1000);
  });

  it('adds only the pages the words did not find and the tab does not hold as trashed', () => {
    const words = [hit('a'), hit('b')];
    const meaning = [hit('c'), hit('a'), hit('d'), hit('e'), hit('c')];
    expect(relatedByMeaning(words, meaning, (id) => id === 'd').map((h) => h.pageId)).toEqual([
      'c',
      'e',
    ]);
  });
});

describe('the route', () => {
  it('asks by the workspace, the question and the limit, and reads the hits as word search’s', async () => {
    const asked: URL[] = [];
    const api = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: async (input: RequestInfo | URL) => {
        const request = input as Request;
        asked.push(new URL(request.url));
        return new Response(
          JSON.stringify({
            hits: [
              {
                pageId: 'p1',
                title: 'Supplier contracts',
                snippet: 'Terms with',
                score: '0.81',
                kind: 'row',
                databaseId: 'd1',
              },
              {
                pageId: 'p2',
                title: 'Notes',
                snippet: '',
                score: 0.7,
                kind: 'odd',
                databaseId: null,
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const hits = await meaningSearch(api, WS, 'who sells us oil?');
    expect(asked[0]!.pathname).toBe(`/api/v1/workspaces/${WS}/search/meaning`);
    expect(asked[0]!.searchParams.get('q')).toBe('who sells us oil?');
    expect(asked[0]!.searchParams.get('limit')).toBe('10');
    expect(hits).toEqual([
      {
        pageId: 'p1',
        title: 'Supplier contracts',
        snippet: 'Terms with',
        score: 0.81,
        kind: 'row',
        databaseId: 'd1',
      },
      { pageId: 'p2', title: 'Notes', snippet: '', score: 0.7, kind: 'page', databaseId: null },
    ]);
  });

  it('throws the problem’s code, and `network` with no answer', async () => {
    const refusing = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: async () =>
        new Response(JSON.stringify({ code: 'ai.disabled', title: 'Off' }), {
          status: 403,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    });
    await expect(meaningSearch(refusing, WS, 'anything')).rejects.toMatchObject({
      code: 'ai.disabled',
      status: 403,
    });
    const down = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    await expect(meaningSearch(down, WS, 'anything')).rejects.toBeInstanceOf(MeaningError);
  });
});

describe('asking once the person pauses', () => {
  afterEach(() => vi.useRealTimers());

  it('asks only the question that stood for the pause, and drops a stale answer', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const aborted: string[] = [];
    const answers = new Map<string, (hits: RemoteSearchHit[]) => void>();
    const shown: [string, string[]][] = [];
    const asker = new MeaningAsker(
      (q, signal) => {
        asked.push(q);
        signal.addEventListener('abort', () => aborted.push(q));
        return new Promise((resolve) => answers.set(q, resolve));
      },
      (q, hits) => shown.push([q, hits.map((h) => h.pageId)]),
    );
    asker.ask('sup');
    vi.advanceTimersByTime(MEANING_PAUSE_MS - 100);
    asker.ask('supp');
    asker.ask('suppliers');
    vi.advanceTimersByTime(MEANING_PAUSE_MS - 1);
    expect(asked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(asked).toEqual(['suppliers']);
    // The same question again changes nothing; a new one cancels the request out.
    asker.ask('suppliers');
    asker.ask('suppliers of oil');
    expect(aborted).toEqual(['suppliers']);
    answers.get('suppliers')!([hit('late')]);
    vi.advanceTimersByTime(MEANING_PAUSE_MS);
    answers.get('suppliers of oil')!([hit('p1'), hit('p2')]);
    await vi.runAllTimersAsync();
    expect(shown).toEqual([['suppliers of oil', ['p1', 'p2']]]);
    // No question (cleared, or meaning turned off): nothing is asked.
    asker.ask(null);
    vi.advanceTimersByTime(MEANING_PAUSE_MS * 2);
    expect(asked).toEqual(['suppliers', 'suppliers of oil']);
  });
});

describe('Settings’ search by meaning', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  /** Waits for `check`, bounded by time (5 s): Windows rounds each short timer up, CI runs cold. */
  async function until(check: () => boolean, what = 'the condition') {
    const end = Date.now() + 5000;
    while (!check() && Date.now() < end)
      await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    if (!check()) throw new Error(`Timed out waiting for ${what}`);
  }

  /** The section for a person of `role`, over a server whose settings the test holds. */
  async function render(role: 'owner' | 'member', embeddings: Record<string, unknown>) {
    const puts: Record<string, unknown>[] = [];
    let current = {
      enabled: false,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      models: ['claude-opus-5-5'],
      hasKey: false,
      embeddings: { ...ON, enabled: false, hasKey: false, ...embeddings },
    };
    const api = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'bearer', token: async () => 'test' },
      fetch: async (input: RequestInfo | URL) => {
        const request = input as Request;
        if (request.method === 'PUT') {
          const body = (await request.json()) as { embeddings?: Record<string, unknown> };
          puts.push(body);
          const change = body.embeddings ?? {};
          if (change.enabled === true && !current.embeddings.hasKey)
            return new Response(JSON.stringify({ code: 'ai.keyMissing' }), {
              status: 400,
              headers: { 'Content-Type': 'application/problem+json' },
            });
          current = {
            ...current,
            embeddings: {
              ...current.embeddings,
              ...(change.enabled === undefined ? {} : { enabled: change.enabled as boolean }),
              ...(change.model === undefined ? {} : { model: change.model as string }),
              ...(change.apiKey === undefined ? {} : { hasKey: change.apiKey !== null }),
            },
          };
        }
        return new Response(JSON.stringify(current), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const listeners = new Set<() => void>();
    const cloud = {
      api,
      account: { id: 'u1', email: 'owner@example.test', displayName: 'Owner' },
      status: { state: 'synced' },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } as unknown as Cloud;
    const workspace = { id: WS, name: 'Team', localOnly: false, role };
    const session = {
      workspaceId: WS,
      current: workspace,
      mirror: { workspaces: new Map([[WS, workspace]]), subscribe: () => () => {} },
    } as unknown as WorkspaceSession;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const i18n = createI18n('en');
    await act(async () =>
      root!.render(
        h(
          I18nextProvider,
          { i18n },
          h(CloudContext.Provider, { value: cloud }, h(AiSettingsSection, { session })),
        ),
      ),
    );
    return { container, puts };
  }

  const part = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="embeddings-settings"]');

  it('turns on only with a key, keeps the key out of sight, and changes the model', async () => {
    const { container, puts } = await render('owner', {});
    await until(() => !!part(container), 'the section');
    const section = part(container)!;
    expect(section.textContent).toContain(T.embeddingsNote);
    expect(section.querySelector('[data-testid="embeddings-key-state"]')!.textContent).toBe(
      T.noKey,
    );
    const toggle = section.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => toggle.click());
    // No key yet: nothing is sent, and the person is told why.
    expect(puts).toEqual([]);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(T.embeddingsKeyMissing);
    const key = section.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(key, '  pa-voyage-test-key-0001  ');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
    );
    await until(() => puts.length === 1, 'the key saved');
    expect(puts[0]).toEqual({ embeddings: { apiKey: 'pa-voyage-test-key-0001' } });
    await until(() => key.value === '', 'the field emptied');
    await act(async () =>
      part(container)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await until(() => puts.length === 2, 'turned on');
    expect(puts[1]).toEqual({ embeddings: { enabled: true } });
    const select = part(container)!.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      T.modelVoyage4,
      T.modelVoyage4Large,
      T.modelVoyage4Lite,
    ]);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'voyage-4-large');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => puts.length === 3, 'the model');
    expect(puts[2]).toEqual({ embeddings: { model: 'voyage-4-large' } });
    // The key itself never shows: only whether one is set.
    expect(container.textContent).not.toContain('pa-voyage-test-key-0001');
  });

  it('shows the month’s use and the pages ready while on, and a member only whether it is on', async () => {
    const owner = await render('owner', {
      enabled: true,
      hasKey: true,
      usage: { month: '2026-11', requests: 12, tokens: '34567' },
      progress: { pages: 40, embedded: 31 },
    });
    await until(() => !!part(owner.container), 'the section');
    expect(owner.container.querySelector('[data-testid="embeddings-usage"]')!.textContent).toBe(
      T.embeddingsUsage.replace('{{requests}}', '12').replace('{{tokens}}', '34,567'),
    );
    expect(owner.container.querySelector('[data-testid="embeddings-progress"]')!.textContent).toBe(
      T.embeddingsProgress.replace('{{embedded}}', '31').replace('{{pages}}', '40'),
    );
    act(() => root?.unmount());
    document.body.replaceChildren();
    const member = await render('member', { enabled: true });
    await until(() => !!member.container.querySelector('[data-testid="embeddings-state"]'));
    expect(part(member.container)).toBeNull();
    expect(member.container.querySelector('[data-testid="embeddings-state"]')!.textContent).toBe(
      T.embeddingsStateOn,
    );
  });

  it('hears the server’s own code when it refuses a change (the client read its body first)', async () => {
    const api = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'bearer', token: async () => 'test' },
      fetch: async () =>
        new Response(JSON.stringify({ code: 'ai.keyMissing', title: 'No key' }), {
          status: 400,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    });
    await expect(
      cloudAiApi(api).saveSettings(WS, { embeddings: { enabled: true } }),
    ).rejects.toMatchObject({ code: 'ai.keyMissing', status: 400 });
  });

  it('reads a server before Phase 10 as having no search by meaning', () => {
    const old = settingsOf({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      models: [],
    } as unknown as Parameters<typeof settingsOf>[0]);
    expect(old.embeddings).toBeUndefined();
  });
});
