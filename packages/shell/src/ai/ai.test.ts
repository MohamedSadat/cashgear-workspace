// Phase 7, AI in the client: the streamed answer read strictly, each action's request holding only
// what the contract names, the JSON answers' shapes and limits, a database proposal made into
// operations, the settings store and when AI is offered, the ERP assist, and the panel: nothing
// enters the page while the answer streams or before Accept, and Accept is one undoable edit.
import { afterEach, describe, expect, it } from 'vitest';
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
const Y = await import('yjs');
const { build, documentSchema, writeJSON, CONTENT, fragmentToJSON, plainText } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('@cgw/editor');
const { pressKey } = await import('../../../editor/src/testing');
const { createI18n } = await import('../i18n');
const { parseAiEvent, readAiEvents } = await import('./events');
const { buildRequest } = await import('./requests');
const { parseActionItems, parseDatabaseProposal, parseErpChanges } = await import('./answers');
const { proposedDatabaseOps, valueOf } = await import('./database');
const { AiSettingsStore, availability } = await import('./store');
const { runCompletion } = await import('./run');
const { erpAssistOf } = await import('./erpAssist');
const { AiPanel, errorKey } = await import('./AiPanel');
const { splitTitle, answerBlocks } = await import('./accept');
const { AiError } = await import('./types');
type AiApi = import('./api').AiApi;
type AiEvent = import('./types').AiEvent;
type AiCompleteRequest = import('./types').AiCompleteRequest;
type AiSettings = import('./types').AiSettings;

const WS = '01936f6e-0000-7000-8000-00000000e001';
const PAGE = '01936f6e-0000-7000-8000-00000000d001';
const SECTION = '01936f6e-0000-7000-8000-00000000c001';

const encoder = new TextEncoder();
/** A body that sends `chunks` as they are, so a line may be split across them. */
const body = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

async function collect(stream: AsyncGenerator<AiEvent>) {
  const out: AiEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const done = (inputTokens = 10, outputTokens = 5): AiEvent => ({
  type: 'done',
  stopReason: 'end',
  usage: { inputTokens, outputTokens },
});

/** A fake API: what it was asked, and answers the test scripts (with an optional gate). */
function fakeApi(script: (request: AiCompleteRequest) => AiEvent[], gate?: Promise<void>) {
  const requests: AiCompleteRequest[] = [];
  let settings: AiSettings = {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    hasKey: true,
  };
  const api: AiApi = {
    settings: async () => settings,
    saveSettings: async (_workspaceId, change) => {
      settings = {
        ...settings,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.model ? { model: change.model } : {}),
        ...(change.apiKey === undefined ? {} : { hasKey: change.apiKey !== null }),
      };
      return settings;
    },
    async *complete(request, signal) {
      requests.push(JSON.parse(JSON.stringify(request)) as AiCompleteRequest);
      const events = script(request);
      for (const [index, event] of events.entries()) {
        if (signal?.aborted) throw new AiError('aborted');
        if (gate && event.type === 'done') await gate;
        if (signal?.aborted) throw new AiError('aborted');
        yield event;
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
  return { api, requests };
}

describe('the streamed answer', () => {
  it('reads lines split across chunks, in order, up to done', async () => {
    const events = await collect(
      readAiEvents(
        body([
          '{"type":"start","requestId":"r1","model":"claude-opus-5-5"}\n{"type":"te',
          'xt","text":"Hel"}\n{"type":"text","text":"lo"}\n',
          '{"type":"done","stopReason":"end","usage":{"inputTokens":"12","outputTokens":3}}\n',
        ]),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'done']);
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('ends with response.invalid on a line that breaks the contract, or with no end', async () => {
    await expect(collect(readAiEvents(body(['{"type":"text","text":3}\n'])))).rejects.toMatchObject(
      { code: 'response.invalid' },
    );
    await expect(collect(readAiEvents(body(['not json\n'])))).rejects.toMatchObject({
      code: 'response.invalid',
    });
    await expect(
      collect(readAiEvents(body(['{"type":"text","text":"a"}\n']))),
    ).rejects.toMatchObject({ code: 'response.invalid' });
    expect(parseAiEvent({ type: 'error', code: 'ai.refused' })).toEqual({
      type: 'error',
      code: 'ai.refused',
    });
    expect(parseAiEvent({ type: 'error', code: 'anything' })).toBeNull();
    expect(parseAiEvent({ type: 'sources', pages: [{ pageId: PAGE }] })).toBeNull();
  });
});

describe('each action’s request', () => {
  const place = {
    workspaceId: WS,
    pageId: PAGE,
    language: 'en' as const,
    pageText: () => 'Page text',
  };
  const selection = { from: 3, to: 9, text: 'chosen' };

  it('holds only the fields the contract names', () => {
    expect(buildRequest({ action: 'rewrite', selection, instruction: 'improve' }, place)).toEqual({
      workspaceId: WS,
      pageId: PAGE,
      language: 'en',
      action: 'rewrite',
      input: { text: 'chosen', instruction: 'improve' },
    });
    expect(
      buildRequest({ action: 'rewrite', selection, instruction: 'translate', target: 'ar' }, place)
        .input,
    ).toEqual({ text: 'chosen', instruction: 'translate', target: 'ar' });
    expect(
      buildRequest(
        { action: 'rewrite', selection, instruction: 'custom', prompt: ' formal ' },
        place,
      ).input,
    ).toEqual({ text: 'chosen', instruction: 'custom', prompt: 'formal' });
    expect(buildRequest({ action: 'summarise' }, place).input).toEqual({ text: 'Page text' });
    expect(buildRequest({ action: 'actionItems' }, place).input).toEqual({ text: 'Page text' });
    expect(buildRequest({ action: 'generatePage', prompt: 'A plan' }, place)).toMatchObject({
      pageId: PAGE,
      input: { prompt: 'A plan' },
    });
    // Neither a new database nor a question is about the page: no page id is sent.
    const database = buildRequest({ action: 'generateDatabase', prompt: 'Vendors' }, place);
    expect(database).toEqual({
      workspaceId: WS,
      language: 'en',
      action: 'generateDatabase',
      input: { prompt: 'Vendors' },
    });
    const ask = buildRequest({ action: 'ask', question: 'Where is the plan?' }, place);
    expect('pageId' in ask).toBe(false);
    expect(ask.input).toEqual({ question: 'Where is the plan?' });
  });

  it('says what is too long or empty before anything is sent', () => {
    const long = { ...place, pageText: () => 'x'.repeat(100_001) };
    expect(() => buildRequest({ action: 'summarise' }, long)).toThrow(
      expect.objectContaining({ code: 'too.long' }),
    );
    expect(() =>
      buildRequest(
        {
          action: 'rewrite',
          selection: { ...selection, text: 'y'.repeat(20_001) },
          instruction: 'improve',
        },
        place,
      ),
    ).toThrow(expect.objectContaining({ code: 'too.long' }));
    expect(() => buildRequest({ action: 'ask', question: '   ' }, place)).toThrow(
      expect.objectContaining({ code: 'request.empty' }),
    );
    expect(() => buildRequest({ action: 'generatePage', prompt: 'p'.repeat(4001) }, place)).toThrow(
      expect.objectContaining({ code: 'too.long' }),
    );
  });
});

describe('the JSON answers', () => {
  it('reads action items, with or without a fence, and refuses other shapes', () => {
    expect(
      parseActionItems('{"items":[{"text":" Call Laila "},{"text":"Send the plan"}]}'),
    ).toEqual(['Call Laila', 'Send the plan']);
    expect(parseActionItems('```json\n{"items":[]}\n```')).toEqual([]);
    for (const bad of ['[]', '{"items":[{"text":""}]}', '{"items":[1]}', 'nope'])
      expect(() => parseActionItems(bad)).toThrow(
        expect.objectContaining({ code: 'answer.invalid' }),
      );
  });

  it('reads a database within its limits, the first property the title', () => {
    const proposal = parseDatabaseProposal(
      JSON.stringify({
        name: 'Vendors',
        properties: [
          { name: 'Name', type: 'number' },
          { name: 'Status', type: 'select', options: ['Active', 'Paused'] },
          { name: 'Since', type: 'date' },
        ],
        rows: [
          { values: ['Qorvath', 'Active', '2026-01-02'] },
          { values: ['Velmorra'] },
          { values: { Name: 'Brinmoor', Status: 'Paused', Extra: 'x' } },
        ],
      }),
    );
    expect(proposal.properties.map((p) => p.type)).toEqual(['text', 'select', 'date']);
    // In the properties' order, as the server's structured answer gives them; by name read too.
    expect(proposal.rows).toEqual([
      { Name: 'Qorvath', Status: 'Active', Since: '2026-01-02' },
      { Name: 'Velmorra', Status: null, Since: null },
      { Name: 'Brinmoor', Status: 'Paused', Since: null },
    ]);
    const tooMany = {
      name: 'X',
      properties: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, type: 'text' })),
      rows: [],
    };
    expect(() => parseDatabaseProposal(JSON.stringify(tooMany))).toThrow();
    const repeated = {
      name: 'X',
      properties: [
        { name: 'A', type: 'text' },
        { name: 'a', type: 'text' },
      ],
      rows: [],
    };
    expect(() => parseDatabaseProposal(JSON.stringify(repeated))).toThrow();
    const badType = {
      name: 'X',
      properties: [
        { name: 'A', type: 'text' },
        { name: 'B', type: 'formula' },
      ],
      rows: [],
    };
    expect(() => parseDatabaseProposal(JSON.stringify(badType))).toThrow();
  });

  it('reads ERP changes, the last for a record’s field kept', () => {
    expect(
      parseErpChanges(
        '{"changes":[{"id":"7","field":"mobile","to":"1"},{"id":"7","field":"mobile","to":"2"},{"id":"8","field":"blocked","to":true}]}',
      ),
    ).toEqual([
      { id: '7', field: 'mobile', to: '2' },
      { id: '8', field: 'blocked', to: true },
    ]);
    expect(() => parseErpChanges('{"changes":[{"id":"7","field":"x","to":{}}]}')).toThrow();
  });
});

describe('a database proposal accepted', () => {
  it('makes the database under the page, its view and its rows with typed values', () => {
    const proposal = parseDatabaseProposal(
      JSON.stringify({
        name: 'Suppliers',
        properties: [
          { name: 'Name', type: 'text' },
          { name: 'Tier', type: 'select', options: ['Gold'] },
          { name: 'Tags', type: 'multiSelect' },
          { name: 'Spend', type: 'number' },
          { name: 'Active', type: 'checkbox' },
          { name: 'Since', type: 'date' },
        ],
        rows: [
          {
            values: {
              Name: 'Qorvath',
              Tier: 'Silver',
              Tags: ['local', 'steel'],
              Spend: '1,250.5',
              Active: true,
              Since: '2026-02-03',
            },
          },
          {
            values: {
              Name: 'Velmorra',
              Tier: 'Gold',
              Tags: 'steel',
              Spend: null,
              Active: 'no',
              Since: 'soon',
            },
          },
        ],
      }),
    );
    let n = 0;
    const made = proposedDatabaseOps(
      proposal,
      { workspaceId: WS, sectionId: SECTION, parentPageId: PAGE, orderKey: 'a0' },
      { table: 'Table' },
      { newId: () => `01936f6e-0000-7000-8000-${String(++n).padStart(12, '0')}` },
    );
    const [databaseOp, viewOp, ...rowOps] = made.ops;
    const database = databaseOp.payload as {
      title: string;
      parentPageId: string;
      database: {
        properties: {
          id: string;
          name: string;
          type: string;
          options?: { id: string; name: string }[];
        }[];
      };
    };
    expect(databaseOp.type).toBe('page.create');
    expect(database.title).toBe('Suppliers');
    expect(database.parentPageId).toBe(PAGE);
    const props = database.database.properties;
    expect(props.map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      ['Tier', 'select'],
      ['Tags', 'multiSelect'],
      ['Spend', 'number'],
      ['Active', 'checkbox'],
      ['Since', 'date'],
    ]);
    // A row may name an option the proposal did not list: it is made, once.
    expect(props[1].options!.map((o) => o.name)).toEqual(['Gold', 'Silver']);
    expect(props[2].options!.map((o) => o.name)).toEqual(['local', 'steel']);
    expect(viewOp.type).toBe('view.upsert');
    const rows = rowOps.map(
      (op) => op.payload as { title: string; row: { values: Record<string, unknown> } },
    );
    expect(rows.map((r) => r.title)).toEqual(['Qorvath', 'Velmorra']);
    const id = (name: string) => props.find((p) => p.name === name)!.id;
    const option = (prop: string, name: string) =>
      props.find((p) => p.name === prop)!.options!.find((o) => o.name === name)!.id;
    expect(rows[0].row.values).toEqual({
      [id('Tier')]: option('Tier', 'Silver'),
      [id('Tags')]: [option('Tags', 'local'), option('Tags', 'steel')],
      [id('Spend')]: 1250.5,
      [id('Active')]: true,
      [id('Since')]: { start: '2026-02-03' },
    });
    // What does not read as the type is left empty, never guessed.
    expect(rows[1].row.values).toEqual({
      [id('Tier')]: option('Tier', 'Gold'),
      [id('Tags')]: [option('Tags', 'steel')],
      [id('Active')]: false,
    });
    expect(valueOf({ id: 'p', name: 'n', type: 'url' }, '  ')).toBeUndefined();
  });
});

describe('when AI is offered', () => {
  const ready = { signedIn: true, synced: true, role: 'member', online: true };
  const on = {
    status: 'ready' as const,
    settings: { enabled: true, provider: 'anthropic' as const, model: 'm', models: [] },
  };

  it('needs an account, a synced workspace, no guest, a network and AI on', () => {
    expect(availability(on, ready)).toBe('ready');
    expect(availability(on, { ...ready, signedIn: false })).toBe('signedOut');
    expect(availability(on, { ...ready, synced: false })).toBe('localWorkspace');
    expect(availability(on, { ...ready, role: 'guest' })).toBe('guest');
    expect(availability(on, { ...ready, online: false })).toBe('offline');
    expect(availability({ ...on, settings: { ...on.settings, enabled: false } }, ready)).toBe(
      'off',
    );
    expect(availability({ status: 'idle' }, ready)).toBe('loading');
  });

  it('keeps what the server answers, and hears a refusal as off', async () => {
    const { api } = fakeApi(() => []);
    const store = new AiSettingsStore(api);
    store.load(WS);
    await until(() => store.state(WS).status === 'ready', 'the settings');
    await store.save(WS, { enabled: false });
    expect(store.state(WS)).toMatchObject({ status: 'ready', settings: { enabled: false } });
    await store.save(WS, { enabled: true });
    store.refusedAsOff(WS);
    expect(store.state(WS)).toMatchObject({ settings: { enabled: false } });
  });
});

describe('a completion', () => {
  it('streams its text, then ends done; a stop ends it as aborted', async () => {
    const { api } = fakeApi(() => [
      { type: 'start', requestId: 'r', model: 'claude-opus-5-5' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
      done(),
    ]);
    const states: string[] = [];
    const run = await runCompletion(
      api,
      buildRequest(
        { action: 'summarise' },
        { workspaceId: WS, pageId: PAGE, language: 'en', pageText: () => 't' },
      ),
      (state) => states.push(state.status),
      new AbortController().signal,
      (callback) => callback(),
    );
    expect(run).toMatchObject({ status: 'done', text: 'Hello there', stopReason: 'end' });
    expect(states.at(-1)).toBe('done');
    const controller = new AbortController();
    controller.abort();
    const stopped = await runCompletion(
      api,
      buildRequest(
        { action: 'summarise' },
        { workspaceId: WS, pageId: PAGE, language: 'en', pageText: () => 't' },
      ),
      () => {},
      controller.signal,
    );
    expect(stopped).toMatchObject({ status: 'failed', code: 'aborted' });
  });
});

describe('the ERP assist', () => {
  const request = {
    instruction: 'Block the vendors with no mobile',
    connector: { id: 'vendors', schemaVersion: 'vendors.1' },
    fields: [{ name: 'blocked', label: 'Blocked', type: 'boolean' as const }],
    records: [
      { id: '7', key: 'V-1007', values: { vendorName: 'Zarkonite', mobile: null } },
      { id: '8', key: 'V-1008', values: { vendorName: 'Brinmoor', mobile: '010' } },
    ],
  };

  it('sends the block’s records and fields as given, and keeps only their changes', async () => {
    const { api, requests } = fakeApi(() => [
      {
        type: 'text',
        text: JSON.stringify({
          changes: [
            { id: '7', field: 'blocked', to: true },
            { id: '9', field: 'blocked', to: true },
            { id: '8', field: 'bankAccount', to: 'x' },
          ],
        }),
      },
      done(),
    ]);
    const assist = erpAssistOf(
      api,
      WS,
      () => PAGE,
      () => 'ar',
    );
    expect(await assist.prepare(request)).toEqual([{ id: '7', field: 'blocked', to: true }]);
    expect(requests).toEqual([
      {
        workspaceId: WS,
        action: 'erpChanges',
        pageId: PAGE,
        language: 'ar',
        input: {
          instruction: request.instruction,
          connector: request.connector,
          fields: request.fields,
          records: request.records,
        },
      },
    ]);
  });

  it('refuses too many records, and passes the provider’s refusal on', async () => {
    const { api } = fakeApi(() => [{ type: 'error', code: 'ai.refused' }]);
    const assist = erpAssistOf(
      api,
      WS,
      () => PAGE,
      () => 'en',
    );
    await expect(assist.prepare(request)).rejects.toMatchObject({ code: 'ai.refused' });
    const many = {
      ...request,
      records: Array.from({ length: 501 }, (_, i) => ({ id: `${i}`, key: `${i}`, values: {} })),
    };
    await expect(assist.prepare(many)).rejects.toMatchObject({ code: 'too.long' });
  });
});

describe('accepting', () => {
  it('takes a generated page’s title from its first heading, and names an answer’s sources', () => {
    expect(splitTitle('# Launch plan\n\n- one\n- two')).toEqual({
      title: 'Launch plan',
      body: '- one\n- two',
    });
    expect(splitTitle('Plain first line\nrest')).toEqual({
      title: 'Plain first line',
      body: 'rest',
    });
    const blocks = answerBlocks('It is in [1].', [{ pageId: PAGE }], 'Sources');
    expect(JSON.stringify(blocks.at(-1))).toContain(`"pageMention","attrs":{"pageId":"${PAGE}"`);
    expect(errorKey('limit.size')).toBe('ai.tooLong');
    expect(errorKey('something.new')).toBe('ai.generic');
  });
});

// The panel --------------------------------------------------------------------------------------

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const i18n = createI18n(language);
  act(() => root.render(h(I18nextProvider, { i18n }, node)));
  return container;
}

function pageEditor() {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(CONTENT);
  writeJSON(
    fragment,
    documentSchema(),
    build.docOf(build.paragraph('First point.'), build.paragraph('Second point.')),
  );
  const element = document.createElement('div');
  document.body.append(element);
  const editor = createBlockEditor({ element, fragment, host: {} });
  const text = () => plainText(fragmentToJSON(fragment));
  return { editor, fragment, text };
}

const page = {
  id: PAGE,
  workspaceId: WS,
  sectionId: SECTION,
  parentPageId: null,
  kind: 'page',
  title: 'Notes',
} as unknown as import('../session').AnyPage;

describe('the AI panel', () => {
  it('writes nothing while the answer streams or before Accept; Accept is one undoable edit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api, requests } = fakeApi(
      () => [
        { type: 'start', requestId: 'r', model: 'claude-opus-5-5' },
        { type: 'text', text: '## Summary\n\n' },
        { type: 'text', text: 'Two points.' },
        done(),
      ],
      gate,
    );
    const { editor, fragment, text } = pageEditor();
    const before = text();
    const store = new AiSettingsStore(api);
    const container = render(
      h(AiPanel, {
        ai: { store, workspaceId: WS, availability: 'ready', canManage: false },
        session: {} as never,
        page,
        editor,
        doc: { fragment } as never,
        editable: true,
        databases: null,
        request: { action: 'summarise', n: 1 },
        onClose: () => {},
      }),
    );
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    act(() => button('Ask').click());
    await until(() => container.textContent!.includes('Two points.'), 'the streamed text');
    // Streaming: shown in the panel, not in the page.
    expect(text()).toBe(before);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Only the page's text went, with its title: nothing else of the page.
    expect(requests).toEqual([
      {
        workspaceId: WS,
        pageId: PAGE,
        language: 'en',
        action: 'summarise',
        input: { text: 'Notes\n\nFirst point.\nSecond point.' },
      },
    ]);
    release();
    await until(() => !!button('Insert at the top'), 'the proposal');
    expect(text()).toBe(before);
    await act(async () => button('Insert at the top').click());
    await until(() => text() !== before, 'the accepted edit');
    expect(text()).toBe('Summary\nTwo points.\nFirst point.\nSecond point.');
    expect(container.textContent).toContain('Added to the page.');
    // Ctrl+Z, through the editor's own keys.
    pressKey(editor.editor.view, 'Mod-z');
    expect(text()).toBe(before);
    editor.destroy();
  });

  it('Discard drops the proposal and the page is untouched; Arabic draws right to left', async () => {
    const { api } = fakeApi(() => [{ type: 'text', text: 'نص مقترح' }, done()]);
    const { editor, fragment, text } = pageEditor();
    const before = text();
    const container = render(
      h(AiPanel, {
        ai: {
          store: new AiSettingsStore(api),
          workspaceId: WS,
          availability: 'ready',
          canManage: false,
        },
        session: {} as never,
        page,
        editor,
        doc: { fragment } as never,
        editable: true,
        databases: null,
        request: {
          action: 'rewrite',
          selection: { from: 2, to: 8, text: 'First ' },
          n: 1,
        },
        onClose: () => {},
      }),
      'ar',
    );
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label);
    act(() => button('اسأل')!.click());
    await until(() => !!button('استبدال النص المحدد'), 'the proposal');
    expect(container.querySelector('[data-testid="ai-text"]')!.getAttribute('dir')).toBe('auto');
    act(() => button('تجاهل')!.click());
    expect(container.querySelector('[data-testid="ai-answer"]')).toBeNull();
    expect(text()).toBe(before);
    editor.destroy();
  });

  it('says why AI is not offered, and offers no action then', () => {
    const { api } = fakeApi(() => []);
    const { editor, fragment } = pageEditor();
    const container = render(
      h(AiPanel, {
        ai: {
          store: new AiSettingsStore(api),
          workspaceId: WS,
          availability: 'off',
          canManage: false,
        },
        session: {} as never,
        page,
        editor,
        doc: { fragment } as never,
        editable: true,
        databases: null,
        request: { action: 'summarise', n: 1 },
        onClose: () => {},
      }),
    );
    expect(container.querySelector('[data-testid="ai-unavailable"]')!.textContent).toContain(
      'AI is off for this workspace.',
    );
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    editor.destroy();
  });
});
