// What every component of one database's views shares: the host, the database's id, the
// actions that write to it, and whether the person may change it. One provider per
// `DatabaseView` (and per `RowProperties`).
import type { Id } from '@cgw/workspace';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { createActions, type DatabaseActions } from './actions';
import type { DatabaseRecord, ViewRecord } from './core';
import type { DatabaseHost, Person, RowRequest, RowSnapshot, RowSource } from './host';
import type { TextLookups } from './model/format';
import { useDbT } from './i18n';

export interface DatabaseContextValue {
  host: DatabaseHost;
  databaseId: Id;
  actions: DatabaseActions;
  /** The person may change the database, its views and rows (and the page around allows it). */
  editable: boolean;
}

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabaseContext(): DatabaseContextValue {
  const value = useContext(DatabaseContext);
  if (!value) throw new Error('A database component is drawn outside its DatabaseView');
  return value;
}

/** The context value for one database, its actions made once. */
export function useDatabaseContextValue(
  host: DatabaseHost,
  databaseId: Id,
  editable: boolean,
): DatabaseContextValue {
  const actions = useMemo(() => createActions(host, databaseId), [host, databaseId]);
  return useMemo(
    () => ({ host, databaseId, actions, editable }),
    [host, databaseId, actions, editable],
  );
}

/** A live read from the host: re-renders when `host.subscribe` says something changed. */
export function useHost<T>(host: DatabaseHost, read: () => T): T {
  return useSyncExternalStore(host.subscribe, read, read);
}

export const useDatabase = (host: DatabaseHost, id: Id): DatabaseRecord | null =>
  useHost(host, () => host.database(id));

export const useViews = (host: DatabaseHost, id: Id): ViewRecord[] =>
  useHost(host, () => host.views(id));

const EMPTY_SNAPSHOT: RowSnapshot = {
  rows: [],
  groups: null,
  total: 0,
  complete: false,
  localOnly: false,
  loading: true,
  error: null,
};

/**
 * A row source for a query, made again when the query changes and closed when it is replaced or
 * the component goes; with its live snapshot.
 */
export function useRowSource(
  host: DatabaseHost,
  databaseId: Id,
  request: RowRequest | null,
): { source: RowSource | null; snapshot: RowSnapshot } {
  const key = request ? JSON.stringify(request) : '';
  const [source, setSource] = useState<RowSource | null>(null);
  useEffect(() => {
    if (!key) {
      setSource(null);
      return;
    }
    const made = host.rows(databaseId, JSON.parse(key) as RowRequest);
    setSource(made);
    return () => made.close();
  }, [host, databaseId, key]);
  const snapshot = useSyncExternalStore(
    source ? source.subscribe : noSubscribe,
    source ? source.snapshot : emptySnapshot,
    source ? source.snapshot : emptySnapshot,
  );
  return { source, snapshot };
}

const noSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

/** People by id, from the host (re-read when it changes). */
export function usePeople(host: DatabaseHost): Map<Id, Person> {
  const people = useHost(host, () => host.people());
  return useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
}

/** What `cellText` needs: names, titles and file names in the interface language. */
export function useLookups(host: DatabaseHost): TextLookups {
  const { t, locale } = useDbT();
  const people = usePeople(host);
  return useMemo(
    () => ({
      locale,
      person: (id) => people.get(id)?.name,
      page: (id) => host.pageTitle(id),
      file: (id) => host.assets?.info(id)?.fileName,
      checked: t('cell.checked'),
      unchecked: t('cell.unchecked'),
    }),
    [locale, people, host, t],
  );
}
