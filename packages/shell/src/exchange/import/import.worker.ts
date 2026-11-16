// An import planned off the main thread (ARCHITECTURE.md, Performance: background work): the
// archive unzipped, every file read and every operation built here; the main thread only writes.
import { planImport, type ImportRequest } from './plan';
import { ImportRefused } from './report';

self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  try {
    const plan = await planImport(event.data);
    const transfer = [...new Set(plan.assets.map((a) => a.bytes.buffer))] as ArrayBuffer[];
    self.postMessage({ ok: plan }, { transfer });
  } catch (error) {
    if (error instanceof ImportRefused)
      self.postMessage({
        refused: error.code,
        ...(error.count !== undefined ? { count: error.count } : {}),
      });
    else self.postMessage({ error: String(error) });
  }
};
