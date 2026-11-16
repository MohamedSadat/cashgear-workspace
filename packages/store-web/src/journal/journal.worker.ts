// The journal's worker (client.ts, core.ts): the Origin Private File System's sync access handles
// exist only in dedicated workers. Calls are taken one at a time, in the order they came.
import { JOURNAL_DIR, type JournalCall } from './client';
import { JournalCore, type DirectoryLike } from './core';

let core: JournalCore | null = null;
let queue: Promise<void> = Promise.resolve();

async function run(call: JournalCall): Promise<unknown> {
  switch (call.kind) {
    case 'open': {
      // File handles without sync access (WebKit before 15.2): the journal is off.
      if (
        typeof FileSystemFileHandle === 'undefined' ||
        !('createSyncAccessHandle' in FileSystemFileHandle.prototype)
      )
        throw new Error('No sync access handles here');
      // Throws where there is no Origin Private File System (Firefox's private windows).
      const root = await navigator.storage.getDirectory();
      const dir = (await root.getDirectoryHandle(JOURNAL_DIR, {
        create: true,
      })) as unknown as DirectoryLike;
      core = new JournalCore(dir, {
        maxLiveBytes: call.maxLiveBytes,
        rewriteAfter: call.rewriteAfter,
        newId: () => crypto.randomUUID(),
      });
      return core.open(call.preferred);
    }
    case 'append':
      if (!core) throw new Error('The journal is not open');
      return core.append(call.updates);
    case 'forget':
      return core?.forget(call.what);
    case 'adopt':
      return core?.adopt(call.keep);
    case 'close':
      await core?.close();
      core = null;
      return undefined;
  }
}

self.onmessage = (event: MessageEvent<JournalCall & { id: number }>) => {
  const { id, ...call } = event.data;
  queue = queue.then(async () => {
    try {
      const ok = await run(call as JournalCall);
      (self as unknown as Worker).postMessage({ id, ok });
    } catch (error) {
      (self as unknown as Worker).postMessage({
        id,
        error: String((error as Error)?.message ?? error),
      });
    }
  });
};
