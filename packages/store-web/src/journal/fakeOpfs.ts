// An Origin Private File System folder in memory, for tests in Node: files with FileSystem-
// SyncAccessHandle's exclusive lock (a second handle on a locked file fails as Chrome's does),
// and a way to tear a file's tail as a crash in the middle of a write would.
import type { AccessHandle, DirectoryLike, FileHandleLike } from './core';

class FakeFile {
  bytes = new Uint8Array(0);
  locked = false;
}

class FakeAccess implements AccessHandle {
  private open = true;
  constructor(private readonly file: FakeFile) {}

  private check() {
    if (!this.open) throw new DOMException('The handle is closed', 'InvalidStateError');
  }

  read(buffer: Uint8Array, { at }: { at: number }): number {
    this.check();
    const part = this.file.bytes.subarray(at, at + buffer.length);
    buffer.set(part);
    return part.length;
  }

  write(buffer: Uint8Array, { at }: { at: number }): number {
    this.check();
    const end = at + buffer.length;
    if (end > this.file.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(buffer, at);
    return buffer.length;
  }

  truncate(size: number): void {
    this.check();
    const next = new Uint8Array(size);
    next.set(this.file.bytes.subarray(0, size));
    this.file.bytes = next;
  }

  getSize(): number {
    this.check();
    return this.file.bytes.length;
  }

  flush(): void {
    this.check();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.file.locked = false;
  }
}

export class FakeDirectory implements DirectoryLike {
  readonly files = new Map<string, FakeFile>();
  /** Whether a locked file can still be read whole (`getFile`), as some browsers allow. */
  readLocked = true;

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FileHandleLike> {
    let file = this.files.get(name);
    if (!file) {
      if (!options.create) throw new DOMException(`No file ${name}`, 'NotFoundError');
      file = new FakeFile();
      this.files.set(name, file);
    }
    const found = file;
    return {
      createSyncAccessHandle: async () => {
        if (found.locked)
          throw new DOMException('Another handle holds the file', 'NoModificationAllowedError');
        found.locked = true;
        return new FakeAccess(found);
      },
      getFile: async () => {
        if (found.locked && !this.readLocked)
          throw new DOMException('The file is locked', 'NoModificationAllowedError');
        const copy = found.bytes.slice();
        return { arrayBuffer: async () => copy.buffer };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    const file = this.files.get(name);
    if (!file) throw new DOMException(`No file ${name}`, 'NotFoundError');
    if (file.locked) throw new DOMException('The file is locked', 'NoModificationAllowedError');
    this.files.delete(name);
  }

  async *keys(): AsyncIterable<string> {
    for (const name of [...this.files.keys()]) yield name;
  }

  /** Every lock let go, as when the browser ends (a crash or a close). */
  releaseAll(): void {
    for (const file of this.files.values()) file.locked = false;
  }

  /** A crash in the middle of a write: `bytes` more of a record that never finished. */
  tear(name: string, bytes: Uint8Array): void {
    const file = this.files.get(name)!;
    const grown = new Uint8Array(file.bytes.length + bytes.length);
    grown.set(file.bytes);
    grown.set(bytes, file.bytes.length);
    file.bytes = grown;
  }

  sizes(): Record<string, number> {
    return Object.fromEntries([...this.files].map(([name, file]) => [name, file.bytes.length]));
  }
}
