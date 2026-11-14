// Avatars: a local stand-in for Track U7's avatar (PROGRESS.md), initials on the person's colour
// with the name as the accessible name; the others on the open page in the top bar, and those who
// have a page open beside it in the sidebar.
import type { Id } from '@cgw/workspace';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { colourIndex, initialsOf } from './colour';
import type { Collab } from './collab';
import { usePageOpenBy, usePeopleOnPage } from './context';
import type { PeopleDirectory } from './people';
import type { PagePresence } from './presence';

export interface AvatarProps {
  userId: Id;
  name: string;
  size?: 'tiny' | 'small' | 'medium';
  /** The name is written beside it: the avatar is decoration only. */
  decorative?: boolean;
}

export function Avatar({ userId, name, size = 'small', decorative = false }: AvatarProps) {
  const style = {
    '--cgw-face-bg': `var(--cgw-presence-${colourIndex(userId)})`,
  } as CSSProperties;
  return (
    <span
      className={`cgw-face is-${size}`}
      style={style}
      data-colour={colourIndex(userId)}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name, title: name })}
    >
      {initialsOf(name)}
    </span>
  );
}

/** At most this many avatars side by side; the rest are counted. */
const TOP_BAR_MAX = 4;
const SIDEBAR_MAX = 3;

function useNames(people: PeopleDirectory | null) {
  const { t } = useTranslation();
  return (userId: Id) => people?.name(userId) ?? t('presence.someone');
}

/**
 * The others on the open page, in the top bar. It renders when someone comes or goes, never as
 * cursors move (the editor draws those itself).
 */
export function PresenceBar({
  store,
  people,
}: {
  store: PagePresence | null;
  people: PeopleDirectory | null;
}) {
  const { t, i18n } = useTranslation();
  const ids = usePeopleOnPage(store);
  const nameOf = useNames(people);
  if (!ids.length) return null;
  const shown = ids.slice(0, TOP_BAR_MAX);
  const rest = ids.slice(TOP_BAR_MAX);
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  return (
    <div
      className="cgw-presence-bar"
      role="group"
      aria-label={t('presence.onPage', { count: ids.length })}
      data-testid="presence-bar"
    >
      {shown.map((id) => (
        <Avatar key={id} userId={id} name={nameOf(id)} />
      ))}
      {rest.length > 0 && (
        <span
          className="cgw-face is-small is-more"
          role="img"
          aria-label={t('presence.more', { names: list.format(rest.map(nameOf)) })}
          title={list.format(rest.map(nameOf))}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/** Beside a page in the sidebar: the others who have it open now. */
export function SidePresence({
  collab,
  pageId,
  people,
}: {
  collab: Collab | null;
  pageId: Id;
  people: PeopleDirectory | null;
}) {
  const { t, i18n } = useTranslation();
  const ids = usePageOpenBy(collab, pageId);
  const nameOf = useNames(people);
  if (!ids.length) return null;
  const names = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(ids.map(nameOf));
  return (
    <span
      className="cgw-side-presence"
      role="img"
      aria-label={t('presence.openBy', { names })}
      title={t('presence.openBy', { names })}
      data-testid="side-presence"
    >
      {ids.slice(0, SIDEBAR_MAX).map((id) => (
        <Avatar key={id} userId={id} name={nameOf(id)} size="tiny" decorative />
      ))}
      {ids.length > SIDEBAR_MAX && (
        <span className="cgw-face is-tiny is-more" aria-hidden="true">
          +{ids.length - SIDEBAR_MAX}
        </span>
      )}
    </span>
  );
}
