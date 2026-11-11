// The page's handle on the search worker. Searches wait for the first load; changes go to the
// worker as they are written to IndexedDB.
import type { SearchEntry } from '@cgw/workspace';
import type { IndexHit, IndexRequest } from './search.worker';

export interface SearchIndex {
  load(database: string): Promise<number>;
  put(entry: SearchEntry): void;
  remove(pageIds: string[]): void;
  search(workspaceId: string, query: string, limit: number): Promise<IndexHit[]>;
  close(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Request = IndexRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

export function workerIndex(): SearchIndex {
  const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let next = 1;
  let loaded: Promise<number> = Promise.resolve(0);
  worker.onmessage = (event: MessageEvent<{ id: number; ok?: unknown; error?: string }>) => {
    const waiting = pending.get(event.data.id);
    if (!waiting) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) waiting.reject(new Error(event.data.error));
    else waiting.resolve(event.data.ok);
  };
  const send = <T>(message: Request): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...message, id });
    });
  return {
    load(database) {
      loaded = send<number>({ kind: 'load', database });
      return loaded;
    },
    put(entry) {
      void send({ kind: 'put', entry });
    },
    remove(pageIds) {
      if (pageIds.length) void send({ kind: 'remove', pageIds });
    },
    async search(workspaceId, query, limit) {
      await loaded.catch(() => 0);
      return send<IndexHit[]>({ kind: 'search', workspaceId, query, limit });
    },
    close() {
      worker.terminate();
      for (const waiting of pending.values()) waiting.reject(new Error('The search index closed'));
      pending.clear();
    },
  };
}
