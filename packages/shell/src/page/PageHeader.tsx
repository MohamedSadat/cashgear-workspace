// The page's icon and cover. The icon is an emoji (Track U6's picker stand-in); the cover is an
// image asset kept locally, by id on the page record (D6).
import type { PageRecord } from '@cgw/workspace';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSession } from '../session';
import { assetUrl, pickFiles, storeAsset } from './editorHost';

/** A curated set, drawn by the system's emoji font; Unicode data, no third-party list. */
export const PAGE_ICONS = [
  '📄',
  '📝',
  '📌',
  '📎',
  '📁',
  '📂',
  '🗂️',
  '📋',
  '📊',
  '📈',
  '📉',
  '🧾',
  '💼',
  '🏢',
  '🏦',
  '💰',
  '💳',
  '🧮',
  '📦',
  '🚚',
  '🛒',
  '🏷️',
  '📅',
  '🗓️',
  '⏰',
  '✅',
  '☑️',
  '❗',
  '❓',
  '💡',
  '🔑',
  '🔒',
  '🛠️',
  '⚙️',
  '🧰',
  '🔧',
  '🧪',
  '📚',
  '📖',
  '✏️',
  '🖊️',
  '📣',
  '💬',
  '📞',
  '✉️',
  '📬',
  '🌐',
  '🗺️',
  '🏠',
  '🏭',
  '🧑‍💼',
  '👥',
  '🤝',
  '🎯',
  '🏁',
  '🚀',
  '⭐',
  '🔥',
  '🌱',
  '🌍',
  '☀️',
  '🌙',
  '⚡',
  '❤️',
  '👋',
  '🙂',
  '🎉',
  '🏆',
  '🎨',
  '🎵',
  '📷',
  '🎬',
  '🧭',
  '🔍',
  '🧠',
  '📐',
  '🔔',
  '🗒️',
  '📑',
  '🗃️',
];

function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const columns = 8;
  return (
    <>
      <div className="cgw-menu-backdrop" onMouseDown={onClose} />
      <div
        ref={grid}
        className="cgw-emoji-picker"
        role="dialog"
        aria-label={t('page.chooseIcon')}
        onKeyDown={(event) => {
          const buttons = [...(grid.current?.querySelectorAll<HTMLElement>('.cgw-emoji') ?? [])];
          const at = buttons.indexOf(document.activeElement as HTMLElement);
          const rtl = document.documentElement.dir === 'rtl';
          const step: Record<string, number> = {
            ArrowRight: rtl ? -1 : 1,
            ArrowLeft: rtl ? 1 : -1,
            ArrowDown: columns,
            ArrowUp: -columns,
          };
          if (event.key in step && at >= 0) {
            event.preventDefault();
            buttons[Math.max(0, Math.min(buttons.length - 1, at + step[event.key]))]?.focus();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="cgw-emoji-grid" role="group" aria-label={t('page.chooseIcon')}>
          {PAGE_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              className="cgw-emoji"
              aria-label={icon}
              onClick={() => onPick(icon)}
            >
              {icon}
            </button>
          ))}
        </div>
        <button type="button" className="cgw-button" onClick={() => onPick(null)}>
          {t('page.removeIcon')}
        </button>
      </div>
    </>
  );
}

export function PageHeader({
  session,
  page,
  readOnly,
}: {
  session: WorkspaceSession;
  page: PageRecord;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setCover(null);
    if (page.coverAssetId)
      void assetUrl(session, page.coverAssetId).then((url) => live && setCover(url));
    return () => {
      live = false;
    };
  }, [session, page.coverAssetId]);
  const addCover = async () => {
    const [file] = await pickFiles(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    if (!file) return;
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
              <button type="button" className="cgw-link-button" onClick={() => setPicking(true)}>
                {t('page.addIcon')}
              </button>
            )}
            {!page.coverAssetId && (
              <button type="button" className="cgw-link-button" onClick={() => void addCover()}>
                {t('page.addCover')}
              </button>
            )}
          </div>
        )}
      </div>
      {picking && (
        <EmojiPicker
          onClose={() => setPicking(false)}
          onPick={(icon) => {
            setPicking(false);
            void session.updatePage(page.id, { icon });
          }}
        />
      )}
    </div>
  );
}

export function Breadcrumbs({ session, page }: { session: WorkspaceSession; page: PageRecord }) {
  const { t } = useTranslation();
  const section = session.mirror.sections.get(page.sectionId);
  const ancestors = session.mirror.ancestors(page.id);
  // Track U5's breadcrumb with overflow, stand-in: long trails keep the first and the last two.
  const shown = ancestors.length > 3 ? [ancestors[0], null, ...ancestors.slice(-2)] : ancestors;
  return (
    <nav className="cgw-breadcrumbs" aria-label={t('page.breadcrumbs')}>
      <ol>
        {section && <li className="cgw-crumb-section">{section.name}</li>}
        {shown.map((crumb, i) =>
          crumb ? (
            <li key={crumb.id}>
              <a href={`#/p/${crumb.id}`} dir="auto">
                {crumb.icon ? `${crumb.icon} ` : ''}
                {crumb.title || t('page.untitled')}
              </a>
            </li>
          ) : (
            <li key={`gap-${i}`} aria-hidden="true">
              …
            </li>
          ),
        )}
        <li aria-current="page" dir="auto">
          {page.icon ? `${page.icon} ` : ''}
          {page.title || t('page.untitled')}
        </li>
      </ol>
    </nav>
  );
}
