// Schema version 6's plugin block (`pluginBlock`, nodeviews/plugin.ts), by the frame blocks' rules
// (nodeviews/frame.ts): drawn by `host.plugins.mount` for a type the host knows, mounted again only
// when its type, block id or editability changes, with its props and version sent to `update`;
// `setProps` writes them as an ordinary, undoable edit; a placeholder naming the type for a type
// the host does not know, or without a host; and a build without the plugin keeps the node exactly
// as it was through edits around it (INTEGRATIONS.md, Plugin blocks).
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, fragmentToJSON, CONTENT, build } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');
const { insertPluginBlock, unknownPluginText } = await import('./nodeviews/plugin');
type EditorHost = import('./host').EditorHost;
type PluginMountOptions = import('./host').PluginMountOptions;

const { paragraph } = build;
const CHART = JSON.stringify({ databaseId: 'db', viewId: null, chart: 'bar', later: [1, 2] });
const strings = {
  pluginBlock: 'Plugin block',
  pluginUnknown: 'Needs a newer version ({{type}}).',
  pluginUnavailable: 'Cannot be shown here',
} as never;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const plugin = (attrs: Record<string, unknown>) => ({ type: 'pluginBlock', attrs });
const block = (body: object) => build.block(body as never);

function frames() {
  const mounts: { element: HTMLElement; options: PluginMountOptions }[] = [];
  const updates: PluginMountOptions[] = [];
  let destroys = 0;
  const mount = (element: HTMLElement, options: PluginMountOptions) => {
    mounts.push({ element, options });
    const drawn = document.createElement('div');
    drawn.className = 'drawn';
    element.append(drawn);
    return {
      update: (next: PluginMountOptions) => void updates.push(next),
      destroy: () => {
        destroys++;
        drawn.remove();
      },
    };
  };
  return { mount, mounts, updates, destroys: () => destroys };
}

function setup(content: object[], host: EditorHost = { strings }) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), {
    type: 'doc',
    content: content.map((c) => ('type' in c && c.type === 'block' ? c : block(c))),
  } as never);
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    schedule: () => {},
  });
  editors.push(be);
  const editor = be.editor;
  const list = () => blocks.listBlocks(editor.state.doc);
  const bodyOf = (index: number) => blocks.firstBody(list()[index])!;
  const caret = (index: number, offset: number) =>
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, bodyOf(index).pos + 1 + offset),
      ),
    );
  const view = () => element.querySelector<HTMLElement>('[data-body="pluginBlock"]')!;
  return { doc, be, editor, element, list, bodyOf, caret, view };
}

const pluginHost = (types: string[], mount: ReturnType<typeof frames>['mount']): EditorHost => ({
  strings,
  plugins: { has: (type) => types.includes(type), mount },
});

describe('the plugin block', () => {
  it('names the type in its placeholder when the host has no definition for it, or no host', async () => {
    const one = setup([
      paragraph('a'),
      plugin({ type: 'vendor.timeline', version: 3, props: '{}' }),
    ]);
    await tick();
    expect(one.view().getAttribute('aria-label')).toBe('Plugin block');
    expect(one.view().getAttribute('role')).toBe('group');
    expect(one.view().querySelector('.cgw-embed-placeholder')!.textContent).toBe(
      'Needs a newer version (vendor.timeline).',
    );
    expect(one.view().querySelector<HTMLElement>('.cgw-embed-frame')!.hidden).toBe(true);
    // A host with plugins, but not this one.
    const f = frames();
    const two = setup(
      [plugin({ type: 'vendor.timeline', version: 3, props: '{}' })],
      pluginHost(['cashgear.chart'], f.mount),
    );
    await tick();
    expect(two.view().querySelector('.cgw-embed-placeholder')!.textContent).toBe(
      'Needs a newer version (vendor.timeline).',
    );
    expect(f.mounts).toHaveLength(0);
    // A block with no type at all.
    expect(unknownPluginText(strings, null)).toBe('Needs a newer version.');
    // The English default when the catalogue lacks the strings.
    expect(unknownPluginText(undefined, 'x.y')).toBe(
      'This block needs a newer version of Cash Gear Workspace (x.y).',
    );
  });

  it('is drawn by the host for a type it knows, updated in place, mounted again only for a new key', async () => {
    const f = frames();
    const { view, editor, doc } = setup(
      [paragraph('a'), plugin({ type: 'cashgear.chart', version: 1, props: CHART })],
      pluginHost(['cashgear.chart'], f.mount),
    );
    await tick();
    expect(f.mounts).toHaveLength(1);
    const { options } = f.mounts[0];
    expect(options).toMatchObject({
      type: 'cashgear.chart',
      version: 1,
      props: CHART,
      editable: true,
    });
    expect(options.blockId).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(view().querySelector('.drawn')).not.toBeNull();

    // `setProps` is an ordinary edit of the page: the props and the version, in Yjs, undoable.
    const next = JSON.stringify({ ...JSON.parse(CHART), chart: 'pie' });
    options.setProps(next, 2);
    await tick();
    const stored = fragmentToJSON(doc.getXmlFragment(CONTENT)).content![1].content![0];
    expect(stored).toEqual({
      type: 'pluginBlock',
      attrs: { type: 'cashgear.chart', version: 2, props: next },
    });
    // The frame kept its mount and was told.
    expect(f.mounts).toHaveLength(1);
    expect(f.updates.at(-1)).toMatchObject({ props: next, version: 2 });
    // Nothing but a JSON object, with a whole version, is ever written.
    options.setProps('[1,2]', 3);
    options.setProps('not json', 3);
    options.setProps(next, 0);
    options.setProps(next, 1.5);
    expect(fragmentToJSON(doc.getXmlFragment(CONTENT)).content![1].content![0]).toEqual(stored);

    // Read-only: mounted again (editability is in the key), and `setProps` writes nothing.
    editor.setEditable(false);
    await tick();
    expect(f.mounts).toHaveLength(2);
    expect(f.destroys()).toBe(1);
    expect(f.mounts[1].options.editable).toBe(false);
    f.mounts[1].options.setProps(JSON.stringify({ chart: 'line' }), 2);
    expect(fragmentToJSON(doc.getXmlFragment(CONTENT)).content![1].content![0]).toEqual(stored);
  });

  it('is kept byte for byte by a build without the plugin, through edits around it', async () => {
    const attrs = { type: 'vendor.timeline', version: 7, props: '{"z":1,"a":[2,{"b":null}]}' };
    const { doc, editor, caret } = setup([paragraph('before'), plugin(attrs), paragraph('after')]);
    await tick();
    const content = doc.getXmlFragment(CONTENT);
    const element = () => (content.get(1) as InstanceType<typeof Y.XmlElement>).get(0) as never;
    const before = (element() as { getAttributes(): unknown }).getAttributes();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    // Typing before and after it, a new block, and a deletion around it.
    caret(0, 6);
    editor.commands.insertContent(' more');
    caret(2, 0);
    editor.commands.insertContent('so ');
    editor.commands.enter();
    editor.commands.insertContent('new line');
    caret(0, 0);
    editor.commands.deleteRange({
      from: editor.state.selection.from,
      to: editor.state.selection.from + 1,
    });
    await tick();
    expect(updates.length).toBeGreaterThan(0);
    const json = fragmentToJSON(content);
    const body = json.content!.find((b) => b.content?.[0]?.type === 'pluginBlock')!.content![0];
    expect(body).toEqual({ type: 'pluginBlock', attrs });
    expect((element() as { getAttributes(): unknown }).getAttributes()).toEqual(before);
    // No update after the first edit touched the plugin block's element.
    const after = new Y.Doc();
    for (const update of updates) Y.applyUpdate(after, update);
    expect(JSON.stringify(Y.decodeUpdate(Y.mergeUpdates(updates)))).not.toContain(
      'vendor.timeline',
    );
  });

  it('is inserted by `insertPluginBlock` as a block of its own, with its first props or none', async () => {
    const f = frames();
    const { editor, doc, caret } = setup(
      [paragraph('a')],
      pluginHost(['cashgear.kanban'], f.mount),
    );
    caret(0, 1);
    insertPluginBlock(editor, { type: 'cashgear.kanban', version: 1 });
    insertPluginBlock(editor, { type: 'cashgear.kanban', version: 1, props: '{"groupBy":"s"}' });
    // A props text that is not a JSON object is left out.
    insertPluginBlock(editor, { type: 'cashgear.kanban', version: 1, props: '[]' });
    await tick();
    const bodies = fragmentToJSON(doc.getXmlFragment(CONTENT))
      .content!.map((b) => b.content?.[0])
      .filter((b) => b?.type === 'pluginBlock');
    expect(bodies).toEqual([
      { type: 'pluginBlock', attrs: { type: 'cashgear.kanban', version: 1 } },
      {
        type: 'pluginBlock',
        attrs: { type: 'cashgear.kanban', version: 1, props: '{"groupBy":"s"}' },
      },
      { type: 'pluginBlock', attrs: { type: 'cashgear.kanban', version: 1 } },
    ]);
    // Read-only, nothing is inserted.
    editor.setEditable(false);
    insertPluginBlock(editor, { type: 'cashgear.kanban', version: 1 });
    expect(
      fragmentToJSON(doc.getXmlFragment(CONTENT)).content!.filter(
        (b) => b.content?.[0]?.type === 'pluginBlock',
      ),
    ).toHaveLength(3);
  });
});
