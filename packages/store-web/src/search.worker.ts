// The browser's search index (D25): MiniSearch in a worker, built from the search entries in
// IndexedDB and kept current by the store. Text arrives normalised (search.ts), so the index
// only splits on spaces and matches word prefixes; every query word must match.
import MiniSearch from 'minisearch';
import type { SearchEntry } from '@cgw/workspace';
import { getAll, openDatabase, request } from './idb';

export type IndexRequest =
  | { id: number; kind: 'load'; database: string }
  | { id: number; kind: 'put'; entry: SearchEntry }
  | { id: number; kind: 'remove'; pageIds: string[] }
  | { id: number; kind: 'search'; workspaceId: string; query: string; limit: number };

export interface IndexHit {
  pageId: string;
  title: string;
  text: string;
  score: number;
}

const index = new MiniSearch<SearchEntry>({
  idField: 'pageId',
  fields: ['title', 'text'],
  storeFields: ['workspaceId', 'title', 'text'],
  tokenize: (text) => text.split(' '),
  processTerm: (term) => term || null,
  searchOptions: {
    prefix: true,
    combineWith: 'AND',
    boost: { title: 4 },
    tokenize: (text) => text.split(' '),
    processTerm: (term) => term || null,
  },
});

function put(entry: SearchEntry) {
  if (index.has(entry.pageId)) index.replace(entry);
  else index.add(entry);
}

async function load(database: string) {
  // Open without upgrading: the page created the database already.
  const db = await openDatabase(indexedDB, database, 1, () => {});
  const tx = db.transaction('search');
  const entries = await getAll<SearchEntry>(tx.objectStore('search'));
  await request(tx.objectStore('search').count());
  db.close();
  index.removeAll();
  index.addAll(entries);
  return entries.length;
}

self.onmessage = async (event: MessageEvent<IndexRequest>) => {
  const message = event.data;
  try {
    let result: unknown = null;
    if (message.kind === 'load') result = await load(message.database);
    else if (message.kind === 'put') put(message.entry);
    else if (message.kind === 'remove') {
      for (const id of message.pageIds) if (index.has(id)) index.discard(id);
    } else {
      const hits = index.search(message.query, {
        filter: (hit) => hit.workspaceId === message.workspaceId,
      });
      result = hits.slice(0, message.limit).map((hit): IndexHit => ({
        pageId: hit.id as string,
        title: hit.title as string,
        text: hit.text as string,
        score: hit.score,
      }));
    }
    self.postMessage({ id: message.id, ok: result });
  } catch (error) {
    self.postMessage({ id: message.id, error: String(error) });
  }
};
