// Zipping and unzipping off the main thread (ARCHITECTURE.md, Performance: background work).
import { unzipSync, zipSync, type Zippable } from 'fflate';

export type ZipRequest =
  { kind: 'zip'; files: Record<string, Uint8Array> } | { kind: 'unzip'; bytes: Uint8Array };

self.onmessage = (event: MessageEvent<ZipRequest>) => {
  try {
    if (event.data.kind === 'zip') {
      const files: Zippable = {};
      // Text compresses; images and other media are already compressed.
      for (const [path, bytes] of Object.entries(event.data.files))
        files[path] = [bytes, { level: /\.(md|json|txt|csv)$/.test(path) ? 6 : 0 }];
      const zipped = zipSync(files, { mtime: new Date() });
      self.postMessage({ ok: zipped }, { transfer: [zipped.buffer] });
    } else {
      const files = unzipSync(event.data.bytes);
      self.postMessage({ ok: files });
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
