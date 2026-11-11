// The LocalStore conformance suite against the desktop's SQLite store (crates/cgw-store), through
// the same frames the app sends over Tauri. CI builds cgw-store-cli first; locally the suite is
// skipped, with a note, until it is built.
import { describe, expect, it } from 'vitest';
import { describeLocalStore } from '@cgw/workspace/testing';
import { DesktopStore } from './store';
import { cliPath, cliTransport } from './testing/cli';
import { decodeFrame, encodeFrame } from './frame';

describe('frames', () => {
  it('round-trip a header and bytes', () => {
    const frame = encodeFrame({ op: 'x', n: 1 }, [new Uint8Array([0, 255, 3]), new Uint8Array()]);
    const decoded = decodeFrame(frame);
    expect(decoded.header).toEqual({ op: 'x', n: 1 });
    expect(decoded.blobs.map((b) => [...b])).toEqual([[0, 255, 3], []]);
    expect(() => decodeFrame(frame.subarray(0, frame.length - 2))).toThrow();
  });
});

if (cliPath()) {
  const open: { close: () => Promise<void> }[] = [];
  describeLocalStore('SQLite (cgw-store)', async () => {
    const cli = cliTransport();
    open.push(cli);
    const store = await DesktopStore.open(cli.transport);
    const close = store.close.bind(store);
    store.close = async () => {
      await close();
      await cli.close();
    };
    return store;
  });

  describe('SQLite store', () => {
    it('keeps everything across a restart of the process', async () => {
      const first = cliTransport();
      const store = await DesktopStore.open(first.transport);
      await store.appendDocUpdates('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', [
        { updateId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', data: new Uint8Array([1, 2, 3]) },
      ]);
      await store.setPref('x', { y: 1 });
      await first.close();
      const second = cliTransport(first.dir);
      const again = await DesktopStore.open(second.transport);
      const doc = await again.loadDoc('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
      expect(doc.updates.map((u) => [...u.data])).toEqual([[1, 2, 3]]);
      expect(await again.getPref('x')).toEqual({ y: 1 });
      await second.close();
    });
  });
} else if (process.env.CI) {
  it('cgw-store-cli is built in CI', () => {
    throw new Error('cgw-store-cli is missing: CI builds it before the unit tests');
  });
} else {
  it.skip('SQLite store conformance (build cgw-store-cli to run it)', () => {});
}
