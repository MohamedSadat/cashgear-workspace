// The page's icon and cover. The icon is an emoji, chosen in the library's emoji picker from its
// curated page icons (Track U6); the cover is an image asset kept locally, by id on the page
// record (D6), chosen with the library's file picker (U16). The breadcrumb is U5's.
import {
  CgBreadcrumb,
  CgButton,
  CgEmojiPicker,
  CgFilePicker,
  CgFlyout,
  cgPageIcons,
  type CgBreadcrumbItem,
} from '@cashgear/ui';
import type { PageRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate, routeHash } from '../route';
import { isRowRecord, type WorkspaceSession } from '../session';
import { assetUrl, storeAsset } from './editorHost';

const COVER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function PageHeader({
  session,
  page,
  readOnly,
}: {
  session: WorkspaceSession;
  page: PageRecord;
  readOnly: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [cover, setCover] = useState<string | null>(null);
  // The button that opened the picker: the icon, or "Add icon".
  const opener = useRef<HTMLButtonElement>(null);
  const icons = useMemo(
    () => cgPageIcons(i18n.language.startsWith('ar') ? 'ar' : 'en'),
    [i18n.language],
  );
  useEffect(() => {
    let live = true;
    setCover(null);
    if (page.coverAssetId)
      void assetUrl(session, page.coverAssetId).then((url) => live && setCover(url));
    return () => {
      live = false;
    };
  }, [session, page.coverAssetId]);
  const addCover = async (file: File) => {
    const stored = await storeAsset(session, file);
    if (stored) await session.updatePage(page.id, { coverAssetId: stored.assetId });
  };
  return (
    <div className="cgw-page-header">
      {cover && (
        <div className="cgw-cover">
          <img src={cover} alt="" />
          {!readOnly && (
            <button
              type="button"
              className="cgw-cover-remove cgw-button"
              onClick={() => void session.updatePage(page.id, { coverAssetId: null })}
            >
              {t('page.removeCover')}
            </button>
          )}
        </div>
      )}
      <div className="cgw-page-header-row">
        {page.icon ? (
          <button
            ref={opener}
            type="button"
            className="cgw-page-icon"
            aria-label={t('page.changeIcon')}
            disabled={readOnly}
            onClick={() => setPicking(true)}
          >
            {page.icon}
          </button>
        ) : null}
        {!readOnly && (
          <div className="cgw-page-header-actions">
            {!page.icon && (
              <CgButton
                ref={opener}
                appearance="ghost"
                size="small"
                onClick={() => setPicking(true)}
              >
                {t('page.addIcon')}
              </CgButton>
            )}
            {!page.coverAssetId && (
              <CgFilePicker
                appearance="ghost"
                size="small"
                accept={COVER_TYPES}
                onPick={([file]) => void addCover(file)}
              >
                {t('page.addCover')}
              </CgFilePicker>
            )}
          </div>
        )}
      </div>
      {picking && (
        <CgFlyout
          anchor={opener}
          open
          onOpenChange={(open) => !open && setPicking(false)}
          autoFocus
          returnFocusOnClose
          placement="bottom-start"
          maxHeight="calc(100vh - 16px)"
          scrollable={false}
          role="dialog"
          aria-label={t('page.chooseIcon')}
        >
          <CgEmojiPicker
            items={icons.items}
            groups={icons.groups}
            value={page.icon ?? null}
            labels={{
              search: t('page.searchIcons'),
              grid: t('page.chooseIcon'),
              noMatch: t('page.noIconMatch'),
              remove: t('page.removeIcon'),
            }}
            onEscape={() => setPicking(false)}
            onSelect={(icon) => {
              setPicking(false);
              void session.updatePage(page.id, { icon });
            }}
          />
        </CgFlyout>
      )}
    </div>
  );
}

/** Where the page sits: its section, the pages above it (a row's go through its database). */
export function Breadcrumbs({ session, page }: { session: WorkspaceSession; page: PageRecord }) {
  const { t } = useTranslation();
  const section = session.mirror.sections.get(page.sectionId);
  // A row is not in the tree: its trail goes through its database's page.
  const database = isRowRecord(page) ? session.mirror.pages.get(page.databaseId) : undefined;
  const ancestors = database
    ? [...session.mirror.ancestors(database.id), database]
    : session.mirror.ancestors(page.id);
  const crumb = (record: PageRecord, current = false): CgBreadcrumbItem => ({
    key: record.id,
    text: record.title || t('page.untitled'),
    ...(current ? {} : { href: routeHash({ kind: 'page', pageId: record.id }) }),
    ...(record.icon ? { icon: record.icon } : {}),
  });
  const items: CgBreadcrumbItem[] = [
    ...(section ? [{ key: `section:${section.id}`, text: section.name }] : []),
    ...ancestors.map((ancestor) => crumb(ancestor)),
    crumb(page, true),
  ];
  // A long trail keeps the section, the first page and the last two above this one; the rest
  // are in the "…" menu. The trail's crumbs are plain links; a page chosen from the menu (by key
  // too, where the menu takes the link's Enter itself) is opened here.
  return (
    <CgBreadcrumb
      className="cgw-breadcrumbs"
      label={t('page.breadcrumbs')}
      items={items}
      maxItems={section ? 5 : 4}
      itemsBeforeCollapse={section ? 2 : 1}
      itemsAfterCollapse={3}
      overflowLabel={(hidden) => t('page.breadcrumbsMore', { count: hidden.length })}
      onNavigate={({ item, source, event }) => {
        if (source !== 'overflow' || !item.href) return;
        event.preventDefault();
        navigate({ kind: 'page', pageId: item.key });
      }}
    />
  );
}
