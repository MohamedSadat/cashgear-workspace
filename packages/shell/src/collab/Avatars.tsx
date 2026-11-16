// Who is on a page, drawn with the library's avatars (Track U7): initials on the person's colour
// with the name as the accessible name; the others on the open page in the top bar, and those who
// have a page open beside it in the sidebar.
import { CgAvatarStack, type CgAvatarStackItem } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useTranslation } from 'react-i18next';
import { avatarColours } from './colour';
import type { Collab } from './collab';
import { usePageOpenBy, usePeopleOnPage } from './context';
import type { PeopleDirectory } from './people';
import type { PagePresence } from './presence';

/** At most this many avatars side by side; the rest are counted. */
const TOP_BAR_MAX = 4;
const SIDEBAR_MAX = 3;

function useNames(people: PeopleDirectory | null) {
  const { t } = useTranslation();
  // An avatar needs a name: one the directory has empty is "Someone" too.
  return (userId: Id) => people?.name(userId) || t('presence.someone');
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
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  const items: CgAvatarStackItem[] = ids.map((id) => ({
    key: id,
    name: nameOf(id),
    ...avatarColours(id),
  }));
  return (
    <CgAvatarStack
      className="cgw-presence-bar"
      data-testid="presence-bar"
      items={items}
      max={TOP_BAR_MAX}
      label={t('presence.onPage', { count: ids.length })}
      overflowLabel={(hidden) =>
        t('presence.more', { names: list.format(hidden.map((item) => item.name)) })
      }
    />
  );
}

/** Beside a page in the sidebar: the others who have it open now, one image named by them. */
export function SidePresence({
  collab,
  pageId,
  people,
  initials = true,
}: {
  collab: Collab | null;
  pageId: Id;
  people: PeopleDirectory | null;
  /**
   * Letters on the avatars. A tree row is named by its title and this image's name: letters drawn
   * there are text in the row its name leaves out (Axe's label-in-name), so the tree draws the
   * colours alone.
   */
  initials?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const ids = usePageOpenBy(collab, pageId);
  const nameOf = useNames(people);
  if (!ids.length) return null;
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  const items: CgAvatarStackItem[] = ids.map((id) => ({
    key: id,
    name: nameOf(id),
    ...avatarColours(id),
    ...(initials ? {} : { initials: '' }),
  }));
  return (
    <CgAvatarStack
      className="cgw-side-presence"
      data-testid="side-presence"
      variant="image"
      size="tiny"
      items={items}
      max={SIDEBAR_MAX}
      label={t('presence.openBy', { names: list.format(items.map((item) => item.name)) })}
      overflowLabel={(hidden) =>
        t('presence.more', { names: list.format(hidden.map((item) => item.name)) })
      }
    />
  );
}
