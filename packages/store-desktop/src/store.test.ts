// The LocalStore conformance suite against the desktop's SQLite store (crates/cgw-store), through
// the same frames the app sends over Tauri. CI builds cgw-store-cli first; locally the suite is
// skipped, with a note, until it is built.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Id, MirrorSnapshot } from '@cgw/workspace';
import { describeLocalStore } from '@cgw/workspace/testing';
import { DesktopStore } from './store';
import { cliPath, cliTransport } from './testing/cli';
import { decodeFrame, encodeFrame } from './frame';

/** Stores written by earlier releases' own cgw-store, and what each answered (make.mjs there). */
const FIXTURES = resolve(import.meta.dirname, '../../../crates/cgw-store/tests/fixtures');

interface Fixture {
  version: number;
  workspaces: Id[];
  pages: Id[];
  logPage: Id;
  assets: Id[];
  history: Id;
  reads: { request: Record<string, unknown>; answer: unknown; blobs: number[][] }[];
}

/** A copy of a fixture in a fresh directory, and the old release's answers. */
function fixture(version: number) {
  const dir = mkdtempSync(join(tmpdir(), `cgw-store-v${version}-`));
  cpSync(join(FIXTURES, `v${version}`), dir, { recursive: true });
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Fixture;
  const answer = <T>(request: Record<string, unknown>) => {
    const read = expected.reads.find((r) => isDeepStrictEqual(r.request, request));
    if (!read) throw new Error(`No answer kept for ${JSON.stringify(request)}`);
    return { value: read.answer as T, blobs: read.blobs.map((b) => new Uint8Array(b)) };
  };
  return { dir, expected, answer };
}

const sorted = <T>(rows: T[]) =>
  [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

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

  describe('SQLite store migration', () => {
    for (const version of [1, 2])
      it(`opens a store version ${version} wrote at version 3, with all it held`, async () => {
        const { dir, expected, answer } = fixture(version);
        const original = readFileSync(join(dir, 'workspace.db'));
        const cli = cliTransport(dir);
        const store = await DesktopStore.open(cli.transport);
        expect(await store.schemaVersion()).toBe(3);

        const mirror = answer<MirrorSnapshot>({ op: 'readMirror', workspaceId: null }).value;
        const now = await store.readMirror(null);
        for (const key of Object.keys(mirror) as (keyof MirrorSnapshot)[])
          expect(sorted<unknown>(now[key]), key).toEqual(sorted<unknown>(mirror[key]));
        for (const pageId of expected.pages) {
          const old = answer<{
            hasSnapshot: boolean;
            snapshotCovers: number;
            updates: { updateId: Id; localSeq: number; seq: number | null }[];
          }>({ op: 'loadDoc', pageId });
          const data = old.value.hasSnapshot ? old.blobs.slice(1) : old.blobs;
          expect(await store.loadDoc(pageId)).toEqual({
            snapshot: old.value.hasSnapshot ? old.blobs[0] : null,
            snapshotCovers: old.value.snapshotCovers,
            updates: old.value.updates.map((u, i) => ({ ...u, data: data[i] })),
          });
          expect(await store.listHistory(pageId)).toEqual(
            answer({ op: 'listHistory', pageId }).value,
          );
          expect(await store.repairState(pageId)).toBeNull();
        }
        expect(await store.getHistory(expected.history)).toEqual(
          answer({ op: 'getHistory', id: expected.history }).blobs[0],
        );
        for (const id of expected.assets)
          expect(await store.getAssetBytes(id)).toEqual(
            answer({ op: 'getAssetBytes', id }).blobs[0],
          );
        expect(await store.nextOutboxBatch(100)).toEqual(
          answer({ op: 'nextOutboxBatch', limit: 100 }).value,
        );
        const [ws] = expected.workspaces;
        for (const query of ['quarter', 'تقرير'])
          expect((await store.search(ws, query, 10)).map((h) => h.pageId)).toEqual(
            answer<{ pageId: Id }[]>({ op: 'search', workspaceId: ws, query, limit: 10 }).value.map(
              (h) => h.pageId,
            ),
          );
        for (const key of ['toggles', 'theme', 'missing'])
          expect(await store.getPref(key)).toEqual(
            answer({ op: 'getPref', key }).value ?? undefined,
          );
        if (version >= 2) {
          for (const workspaceId of expected.workspaces) {
            expect(await store.syncCursor(workspaceId)).toEqual(
              answer({ op: 'syncCursor', workspaceId }).value,
            );
            expect(await store.docCursors(workspaceId)).toEqual(
              answer({ op: 'docCursors', workspaceId }).value,
            );
            expect(await store.nextOutboxBatch(100, workspaceId)).toEqual(
              answer({ op: 'nextOutboxBatch', limit: 100, workspaceId }).value,
            );
          }
          for (const pageId of expected.pages)
            expect(await store.docCursor(pageId)).toEqual(
              answer({ op: 'docCursor', pageId }).value,
            );
          const unsent = answer<{ pageId: Id; updateId: Id }[]>({
            op: 'unsentDocUpdates',
            limit: 100,
          });
          expect(
            (await store.unsentDocUpdates(100)).flatMap((d) =>
              d.updates.map((u) => [d.pageId, u.updateId, [...u.data]]),
            ),
          ).toEqual(unsent.value.map((u, i) => [u.pageId, u.updateId, [...unsent.blobs[i]]]));
          expect(await store.pendingAssets(100)).toEqual(
            answer({ op: 'pendingAssets', limit: 100 }).value,
          );
        }

        // What schema 3 adds is there, empty, and works on what the old release wrote.
        for (const workspaceId of expected.workspaces) {
          expect(await store.pins(workspaceId)).toEqual([]);
          const held = await store.heldPages(workspaceId);
          const usage = await store.storageUsage(workspaceId);
          expect(usage.pages).toBe(held.length);
          expect(usage.quarantineBytes).toBe(0);
        }
        expect(await store.heldPages(ws)).toContain(expected.logPage);
        expect(await store.quarantine(null)).toEqual([]);
        const pin = { workspaceId: ws, pageId: expected.logPage, subtree: true, pinnedAt: 'x' };
        await store.pin(pin);
        expect(await store.pins(ws)).toEqual([pin]);
        const entry = await store.setAsideDoc(expected.logPage, 'doc.epochMismatch');
        const log = answer({ op: 'loadDoc', pageId: expected.logPage }).blobs;
        // A version-1 workspace is local: nothing of it is set aside.
        expect(entry?.parts ?? null).toEqual(version >= 2 ? log : null);
        await cli.close();

        // The old release's store was copied, as it was, before anything changed.
        expect(readFileSync(join(dir, `workspace.v${version}.db`))).toEqual(original);
      });

    it('refuses a store a newer version wrote, and leaves it as it was', async () => {
      const first = cliTransport();
      const store = await DesktopStore.open(first.transport);
      await store.setPref('kept', true);
      await first.close();
      const path = join(first.dir, 'workspace.db');
      const db = new DatabaseSync(path);
      db.prepare("UPDATE meta SET value = '4' WHERE key = 'schemaVersion'").run();
      db.close();
      const before = readFileSync(path);
      const second = cliTransport(first.dir);
      await expect(DesktopStore.open(second.transport)).rejects.toThrow(
        /written by a newer version \(4\)/,
      );
      await second.close();
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(first.dir).filter((f) => f.startsWith('workspace.v'))).toEqual([]);
      expect(existsSync(join(first.dir, 'workspace.v4.db'))).toBe(false);
    });
  });
} else if (process.env.CI) {
  it('cgw-store-cli is built in CI', () => {
    throw new Error('cgw-store-cli is missing: CI builds it before the unit tests');
  });
} else {
  it.skip('SQLite store conformance (build cgw-store-cli to run it)', () => {});
}
