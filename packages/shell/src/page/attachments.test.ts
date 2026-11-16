// Phase 8: a file block on a device that did not upload its file. Since Phase 2 an image's picture
// came from the server and a file's record never did, so the block read "This file is not on this
// device" and did not open. Now the host brings the record alone (the asset's metadata route) when
// the block is drawn, never the bytes: those come on Open, and are kept as the uploading device
// keeps them. A page of ten 25 MB files costs ten small answers until one is opened.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const Y = await import('yjs');
const { build, documentSchema, writeJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('@cgw/editor');
const { MemoryStore } = await import('@cgw/workspace');
const { localWorkspace } = await import('../../../workspace/src/testing/syncHarness');
const { WorkspaceSession } = await import('../session');
const { assetsOf } = await import('./editorHost');
type AssetRecord = import('@cgw/workspace').AssetRecord;

const ASSET = '01936f6e-0000-7000-8000-0000000000f1';
const editors: { destroy(): void }[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** A second device: the page's file block, the asset only on the server (a fake cloud). */
async function secondDevice(answer: 'record' | 'none' = 'record') {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  const bytes = new TextEncoder().encode('%PDF-1.4 a manual');
  const record: AssetRecord = {
    id: ASSET,
    workspaceId: made.ws.id,
    fileName: 'manual.pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.length,
    sha256: '',
    width: null,
    height: null,
    createdAt: new Date().toISOString(),
    uploaded: true,
  };
  // As the cloud's `assetInfo` does: the metadata route's record, no bytes.
  const info = vi.fn(async (assetId: string) =>
    answer === 'none' || assetId !== ASSET
      ? null
      : { fileName: record.fileName, sizeBytes: record.sizeBytes, contentType: record.contentType },
  );
  // As the cloud's `fetchAsset` does: the record and the bytes, kept on this device.
  const fetched = vi.fn(async (assetId: string) => {
    if (answer === 'none' || assetId !== ASSET) return null;
    await session.store.putAsset(record, bytes);
    session.mirror.putAsset(record);
    return bytes;
  });
  session.remoteAssetInfo = info;
  session.remoteAssets = fetched;
  const saveFile = vi.fn(async () => undefined);
  const strings = { assetMissing: 'This file is not on this device', openFile: 'Open' };
  const draw = () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(CONTENT);
    writeJSON(
      fragment,
      documentSchema(),
      build.docOf(build.block({ type: 'file', attrs: { assetId: ASSET } })),
    );
    const element = document.createElement('div');
    document.body.append(element);
    const editor = createBlockEditor({
      element,
      fragment,
      host: { assets: assetsOf(session, saveFile), strings: strings as never },
    });
    editors.push(editor);
    return element;
  };
  return { session, store, info, fetched, saveFile, bytes, draw };
}

const nameIn = (element: HTMLElement) => element.querySelector('.cgw-file-name')!.textContent;

describe('a file block whose file another device uploaded', () => {
  it('shows its name and size from the record alone, and fetches the bytes only on Open', async () => {
    const device = await secondDevice();
    const element = device.draw();
    await until(() => nameIn(element) === 'manual.pdf', 'the file’s name');
    expect(element.querySelector('.cgw-file')!.getAttribute('data-missing')).toBe('false');
    expect(element.querySelector('.cgw-file-size')!.textContent).not.toBe('');
    expect(element.querySelector('.cgw-file-open')!.getAttribute('aria-label')).toBe(
      'Open manual.pdf',
    );
    // Drawing the page fetched no bytes.
    expect(device.info).toHaveBeenCalledTimes(1);
    expect(device.fetched).not.toHaveBeenCalled();
    expect(await device.store.getAssetBytes(ASSET)).toBeNull();
    // Open fetches them, once, keeps them, and saves the file as the uploading device does.
    element.querySelector<HTMLButtonElement>('.cgw-file-open')!.click();
    await until(() => device.saveFile.mock.calls.length === 1, 'the file saved');
    expect(device.fetched).toHaveBeenCalledTimes(1);
    expect(device.saveFile).toHaveBeenCalledWith('manual.pdf', device.bytes, 'application/pdf');
    expect(await device.store.getAssetBytes(ASSET)).toEqual(device.bytes);
    // Opened again, from what this device keeps now.
    element.querySelector<HTMLButtonElement>('.cgw-file-open')!.click();
    await until(() => device.saveFile.mock.calls.length === 2, 'the file saved again');
    expect(device.fetched).toHaveBeenCalledTimes(1);
  });

  it('keeps the record across a reload of the mirror, asking the server once', async () => {
    const device = await secondDevice();
    const first = device.draw();
    await until(() => nameIn(first) === 'manual.pdf', 'the file’s name');
    await device.session.reloadMirror();
    const again = device.draw();
    expect(nameIn(again)).toBe('manual.pdf');
    expect(device.info).toHaveBeenCalledTimes(1);
    expect(device.fetched).not.toHaveBeenCalled();
  });

  it('says it is not on this device while the server has none, and asks again later', async () => {
    const device = await secondDevice('none');
    const element = device.draw();
    await until(() => device.info.mock.calls.length === 1, 'the ask');
    await new Promise((r) => setTimeout(r, 10));
    expect(nameIn(element)).toBe('This file is not on this device');
    expect(element.querySelector('.cgw-file')!.getAttribute('data-missing')).toBe('true');
    expect(device.fetched).not.toHaveBeenCalled();
    device.draw();
    await until(() => device.info.mock.calls.length === 2, 'the second ask');
  });
});
