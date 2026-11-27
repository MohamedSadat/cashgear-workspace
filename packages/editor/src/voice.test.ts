// After 0.19.0: a voice note, recorded by the host and kept as a file block, which plays an audio
// file under its name ("Voice note" in the slash menu only where the host can record).
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, CONTENT, build } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { actionByName } = await import('./actions');
const blocks = await import('./blocks');
type EditorHost = import('./host').EditorHost;
type AssetInfo = import('./host').AssetInfo;

const { paragraph } = build;
const VOICE = '01936f6e-0000-7000-8000-0000000000f1';
const PDF = '01936f6e-0000-7000-8000-0000000000f2';
const strings = { openFile: 'Open', assetMissing: 'Not on this device' } as never;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const block = (body: object) => build.block(body as never);
const file = (assetId: string) => ({ type: 'file', attrs: { assetId } });

function assetsHost(records: Record<string, AssetInfo>, stored: File[] = []) {
  const asked: string[] = [];
  const assets: NonNullable<EditorHost['assets']> = {
    url: async (assetId) => {
      asked.push(assetId);
      return `blob:test/${assetId}`;
    },
    info: (assetId) => records[assetId],
    store: async (f) => {
      stored.push(f);
      const assetId = `01936f6e-0000-7000-8000-00000000010${stored.length}`;
      records[assetId] = { fileName: f.name, sizeBytes: f.size, contentType: f.type };
      return { assetId, width: null, height: null };
    },
    pick: async () => [],
    open: () => {},
  };
  return { assets, asked };
}

function setup(content: object[], host: EditorHost) {
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
  return { editor: be.editor, element };
}

describe('a voice note', () => {
  it('is offered only where the host records and stores files', () => {
    const action = actionByName('voiceNote')!;
    expect(action.glyph).toBe('mic');
    const { assets } = assetsHost({});
    expect(action.available!({ strings })).toBe(false);
    expect(action.available!({ strings, assets })).toBe(false);
    expect(action.available!({ strings, assets, voice: { record: async () => null } })).toBe(true);
  });

  it('is stored as a file and put in a file block; a cancelled one adds nothing', async () => {
    const stored: File[] = [];
    const { assets } = assetsHost({}, stored);
    let next: File | null = null;
    const host: EditorHost = { strings, assets, voice: { record: async () => next } };
    const { editor } = setup([paragraph('a')], host);
    const list = () => blocks.listBlocks(editor.state.doc);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, blocks.firstBody(list()[0])!.pos + 2),
      ),
    );
    await actionByName('voiceNote')!.apply(editor, host);
    expect(stored).toEqual([]);
    expect(list()).toHaveLength(1);

    next = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'Voice note.webm', {
      type: 'audio/webm',
    });
    await actionByName('voiceNote')!.apply(editor, host);
    expect(stored).toHaveLength(1);
    const bodies = list().map((b) => blocks.firstBody(b)!.node);
    expect(bodies[1].type.name).toBe('file');
    expect(bodies[1].attrs.assetId).toBe('01936f6e-0000-7000-8000-000000000101');
  });
});

describe('the file block', () => {
  it('plays an audio file under its name, and draws no player for any other', async () => {
    const { assets, asked } = assetsHost({
      [VOICE]: { fileName: 'Voice note.webm', sizeBytes: 2048, contentType: 'audio/webm' },
      [PDF]: { fileName: 'Report.pdf', sizeBytes: 4096, contentType: 'application/pdf' },
    });
    const { element } = setup([file(VOICE), file(PDF)], { strings, assets });
    await tick();
    const [voice, pdf] = [...element.querySelectorAll<HTMLElement>('[data-body="file"]')];
    expect(voice.dataset.audio).toBe('true');
    const player = voice.querySelector('audio')!;
    expect(player.controls).toBe(true);
    expect(player.getAttribute('aria-label')).toBe('Voice note.webm');
    expect(player.getAttribute('src')).toBe(`blob:test/${VOICE}`);
    expect(voice.querySelector('.cgw-file-name')!.textContent).toBe('Voice note.webm');
    expect(pdf.dataset.audio).toBe('false');
    expect(pdf.querySelector('audio')).toBeNull();
    // Its bytes are asked once, and never for the PDF.
    expect(asked).toEqual([VOICE]);
  });
});
