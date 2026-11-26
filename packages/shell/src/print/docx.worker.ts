// Phase 19: a page's Word file written off the main thread (ARCHITECTURE.md, "Word, PDF and print"):
// `@cgw/doc/out`'s writer, then fflate's zip, so typing on another page goes on as it was. The
// collected input comes in, the file's bytes go back.
import { writeDocx, type OutInput } from '@cgw/doc/out';
import { strToU8, zipSync, type Zippable } from 'fflate';

self.onmessage = (event: MessageEvent<OutInput>) => {
  try {
    const files: Zippable = {};
    for (const part of writeDocx(event.data)) {
      const data = typeof part.data === 'string' ? strToU8(part.data) : part.data;
      // XML compresses; pictures are compressed already.
      files[part.path] = [data, { level: part.path.startsWith('word/media/') ? 0 : 6 }];
    }
    // `[Content_Types].xml` first, as Word writes it.
    const ordered: Zippable = { '[Content_Types].xml': files['[Content_Types].xml'] };
    for (const [path, entry] of Object.entries(files))
      if (!(path in ordered)) ordered[path] = entry;
    const made = new Date(event.data.madeAt);
    const zipped = zipSync(ordered, { mtime: Number.isNaN(made.getTime()) ? new Date() : made });
    self.postMessage({ ok: zipped }, { transfer: [zipped.buffer] });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
