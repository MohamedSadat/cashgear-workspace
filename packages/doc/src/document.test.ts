// PageDocument.setLive (Phase 6): while a page is live (joined on the hub, connected), autosave
// batches for at most 60 ms (30 ms after the last change) instead of 500 ms (150 ms), so each save
// reaches the other editors at once; a batch waiting when the page turns live is written by the
// live delays, counted from its first change.
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PageDocument, type DocumentOptions } from './document';

async function opened(options: DocumentOptions = {}) {
  vi.useFakeTimers();
  const store = new MemoryStore();
  const pageId = uuidv7();
  const page = await PageDocument.open(pageId, store, options);
  const start = Date.now();
  /** When each write was durable, in milliseconds from the start. */
  const saves: number[] = [];
  page.onSaved(() => saves.push(Date.now() - start));
  const type = (text: string) =>
    page.doc.transact(() => page.fragment.insert(page.fragment.length, [new Y.XmlText(text)]));
  /** Types a character every `every` ms for `ms`, starting now. */
  const keepTyping = async (ms: number, every: number) => {
    for (let t = 0; t < ms; t += every) {
      type('x');
      await vi.advanceTimersByTimeAsync(every);
    }
  };
  return { store, page, pageId, saves, type, keepTyping, at: () => Date.now() - start };
}

describe('a live page saves in short batches', () => {
  afterEach(() => vi.useRealTimers());

  it('saves 150 ms after a pause, or every 500 ms of typing, when not live', async () => {
    const { page, saves, type, keepTyping } = await opened();
    expect(page.isLive).toBe(false);
    type('a');
    await vi.advanceTimersByTimeAsync(149);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([150]);
    saves.length = 0;
    await keepTyping(1000, 100);
    expect(saves[0] - 150).toBe(500);
    await page.close();
  });

  it('saves 30 ms after a pause, or every 60 ms of typing, while live', async () => {
    const { page, saves, type, keepTyping, store, pageId } = await opened();
    page.setLive(true);
    expect(page.isLive).toBe(true);
    type('a');
    await vi.advanceTimersByTimeAsync(29);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([30]);
    saves.length = 0;
    await keepTyping(300, 20);
    // Typing never pauses for 30 ms: every write is the 60 ms limit.
    expect(saves.slice(0, 4).map((t, i, all) => (i ? t - all[i - 1] : 60))).toEqual([
      60, 60, 60, 60,
    ]);
    await vi.advanceTimersByTimeAsync(100);
    // Nothing typed is lost: every character is in the log.
    const doc = new Y.Doc();
    for (const u of (await store.loadDoc(pageId)).updates) Y.applyUpdate(doc, u.data);
    expect(doc.getXmlFragment('content').length).toBe(page.fragment.length);
    await page.close();
  });

  it('writes a waiting batch by the live delays once the page turns live, and goes back after', async () => {
    const { page, saves, type, at } = await opened();
    type('a');
    await vi.advanceTimersByTimeAsync(40);
    // 40 ms into a batch: 20 ms are left of the live 60.
    page.setLive(true);
    await vi.advanceTimersByTimeAsync(19);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([60]);

    // Far into a batch already: written at once.
    page.setLive(false);
    type('b');
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toEqual([60]);
    page.setLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([60, at()]);

    // Not live again: the usual delays for the next batch.
    page.setLive(false);
    const from = at();
    type('c');
    await vi.advanceTimersByTimeAsync(149);
    expect(saves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves.at(-1)! - from).toBe(150);
    await page.close();
  });

  it('never waits longer than the delays it was given', async () => {
    const { page, saves, type } = await opened({ maxDelayMs: 10, idleMs: 5 });
    page.setLive(true);
    type('a');
    await vi.advanceTimersByTimeAsync(5);
    expect(saves).toEqual([5]);
    await page.close();
  });
});
