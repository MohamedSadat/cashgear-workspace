// What drawing a cell needs, made once per view and handed to every row: drawing thousands of
// cells while a table scrolls must not subscribe each one to the translations or the host.
import type { Id } from '@cgw/workspace';
import { useMemo } from 'react';
import type { DatabaseActions } from '../actions';
import { usePeople } from '../context';
import type { DatabaseHost, Person } from '../host';
import { useDbT, type DbT } from '../i18n';
import type { TextLookups } from '../model/format';

export interface CellEnv {
  t: DbT;
  locale: string;
  rtl: boolean;
  host: DatabaseHost;
  actions: DatabaseActions;
  editable: boolean;
  people: Map<Id, Person>;
  lookups: TextLookups;
  /** Opens a link the scheme allow-list passed. */
  openLink(href: string): void;
}

export function useCellEnv(
  host: DatabaseHost,
  actions: DatabaseActions,
  editable: boolean,
): CellEnv {
  const { t, locale, rtl } = useDbT();
  const people = usePeople(host);
  return useMemo(() => {
    const lookups: TextLookups = {
      locale,
      person: (id) => people.get(id)?.name,
      page: (id) => host.pageTitle(id),
      file: (id) => host.assets?.info(id)?.fileName,
      checked: t('cell.checked'),
      unchecked: t('cell.unchecked'),
    };
    return {
      t,
      locale,
      rtl,
      host,
      actions,
      editable,
      people,
      lookups,
      openLink(href) {
        if (host.openExternal) host.openExternal(href);
        else window.open(href, '_blank', 'noopener,noreferrer');
      },
    };
  }, [t, locale, rtl, host, actions, editable, people]);
}
