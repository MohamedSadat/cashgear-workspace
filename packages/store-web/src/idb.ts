// Promise wrappers for IndexedDB, small enough to read: a request becomes a promise, and a
// transaction resolves when it commits. Awaiting these inside a transaction keeps it alive.

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

export function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, version);
    open.onupgradeneeded = (event) => upgrade(open.result, event.oldVersion, open.transaction!);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () =>
      reject(new Error('The local store is open in an older tab; close it and reload.'));
  });
}

/** Every value of an index for a key, or of a store. */
export function getAll<T>(
  source: IDBObjectStore | IDBIndex,
  query?: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  return request(source.getAll(query) as IDBRequest<T[]>);
}
