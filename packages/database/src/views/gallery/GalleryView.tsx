// The gallery view: the rows as cards in a grid, each with the view's picture (none, the row's page
// cover, or the first image of a files property, read through `host.assets`), its title and the
// view's shown properties; small, medium or large cards, as many to a row as fit. Grid rows are
// virtualised (only those in the window are drawn). One card is in the tab order; the arrows
// move through the grid (mirrored in RTL), Enter opens a card. "New" types a title in place.
import { CgContextMenu, type CgContextMenuActions, type CgContextMenuItem } from '@cashgear/ui';
import type { Id, RowRecord } from '@cgw/workspace';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { InlineEditor } from '../../cells/InlineEditor';
import { useCellEnv } from '../../cells/env';
import { TITLE_PROPERTY } from '../../core';
import { useDatabaseContext } from '../../context';
import type { DatabaseAssets } from '../../host';
import { useDbT } from '../../i18n';
import { shownProperties } from '../../model/properties';
import { revealScroll, sameRange, visibleRange, type Range } from '../../table/windowing';
import { Card, cardDomId } from '../board/Card';
import { draftRow } from '../board/shared';
import type { ViewProps } from '../types';
import {
  COVER_HEIGHT,
  GALLERY_GAP,
  GALLERY_PADDING,
  cardWidth,
  coverAsset,
  galleryColumns,
  galleryLayout,
  galleryMove,
  hasCover,
  sizeOf,
} from './layout';
import '../board/card.css';
import './gallery.css';

export function GalleryView({
  database,
  view,
  source,
  snapshot,
  embedded,
  searching,
  newRowRequest,
}: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { t } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const idPrefix = `g${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const config = view.config;
  const size = sizeOf(config);
  const cover = hasCover(config) ? COVER_HEIGHT[size] : 0;
  const shown = useMemo(() => shownProperties(database, config, true), [database, config]);
  const titleDef = database.properties.find((p) => p.id === TITLE_PROPERTY);
  // A multi-select group does not apply here: each row once, in the query's order.
  const rows = useMemo(() => {
    const seen = new Set<Id>();
    return snapshot.rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
  }, [snapshot.rows]);

  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 960, height: 600, top: 0 });
  const cols = galleryColumns(box.width, size);
  const width = cardWidth(box.width, cols);
  const layout = useMemo(
    () => galleryLayout(rows, shown, cols, cover, editable),
    [rows, shown, cols, cover, editable],
  );
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = {
      width: el.clientWidth || 960,
      height: el.clientHeight || 600,
      top: el.scrollTop,
    };
    setBox((prev) =>
      prev.width === next.width && prev.height === next.height && prev.top === next.top
        ? prev
        : next,
    );
  }, []);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const [range, setRange] = useState<Range>({ start: 0, end: 6 });
  useLayoutEffect(() => {
    const next = visibleRange(layout, Math.max(0, box.top - GALLERY_PADDING), box.height, 2);
    setRange((prev) => (sameRange(prev, next) ? prev : next));
  }, [layout, box]);

  // The last grid row in the window fetches the next page.
  useEffect(() => {
    if (!source || snapshot.complete || snapshot.loading) return;
    if (range.end >= layout.count) source.loadMore();
  }, [range, layout.count, source, snapshot.complete, snapshot.loading]);

  // ---- New -------------------------------------------------------------------------------------
  const [draft, setDraft] = useState(false);
  const lastNewRequest = useRef(newRowRequest);
  useEffect(() => {
    if (newRowRequest === lastNewRequest.current) return;
    lastNewRequest.current = newRowRequest;
    setDraft(true);
    const el = scroller.current;
    if (el) el.scrollTop = layout.total;
  }, [newRowRequest, layout.total]);

  // ---- Focus -----------------------------------------------------------------------------------
  const [active, setActive] = useState(0);
  const activeIndex = Math.max(0, Math.min(active, rows.length - 1));
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    const row = index === null ? undefined : rows[index];
    if (!row) return;
    const el = document.getElementById(cardDomId(idPrefix, row.id));
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });
  const indexOf = (target: EventTarget | null) => {
    const id = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-card]')?.dataset.card;
    return id ? rows.findIndex((r) => r.id === id) : -1;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[data-card]')) return;
    const index = indexOf(target);
    const row = rows[index];
    if (!row) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      host.openRow(row.id);
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      void cardMenu.current?.showNear(target, row);
      return;
    }
    const rtl = getComputedStyle(target).direction === 'rtl';
    const next = galleryMove(index, rows.length, cols, event.key, rtl);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    pendingFocus.current = next;
    const el = scroller.current;
    if (el) {
      const top = revealScroll(
        layout,
        Math.floor(next / cols),
        el.scrollTop - GALLERY_PADDING,
        el.clientHeight,
        0,
      );
      if (top !== null) el.scrollTop = top + GALLERY_PADDING;
    }
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = indexOf(event.target);
    if (index >= 0 && index !== active) setActive(index);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, [role="checkbox"]')) return;
    const row = rows[indexOf(target)];
    if (row) host.openRow(row.id);
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = rows[indexOf(event.target)];
    if (!row) return;
    event.preventDefault();
    void cardMenu.current?.showFromEvent(event as MouseEvent<HTMLElement>, row);
  };

  const cardMenu = useRef<CgContextMenuActions<RowRecord>>(null);
  const cardItems = useMemo<CgContextMenuItem<RowRecord>[]>(
    () => [
      {
        key: 'open',
        text: t('row.open'),
        command: ({ invocation }) => host.openRow(invocation.context.id),
      },
      {
        key: 'duplicate',
        text: t('row.duplicate'),
        disabled: !editable,
        command: ({ invocation }) => void actions.duplicateRow(invocation.context),
      },
      {
        key: 'delete',
        text: t('row.delete'),
        intent: 'danger',
        disabled: !editable,
        beginGroup: true,
        command: ({ invocation }) => void actions.trashRow(invocation.context),
      },
    ],
    [t, host, actions, editable],
  );

  // ---- Drawing -------------------------------------------------------------------------------------
  const name = host.pageTitle(database.id) || t('untitledDatabase');
  const tiles: number[] = [];
  for (let r = range.start; r < range.end; r++)
    for (let i = r * cols; i < Math.min(rows.length + (editable ? 1 : 0), (r + 1) * cols); i++)
      tiles.push(i);
  if (rows.length && !tiles.includes(activeIndex)) tiles.push(activeIndex);
  const empty = snapshot.complete && !snapshot.loading && rows.length === 0;

  return (
    <div className={`cgw-gallery${embedded ? ' is-embedded' : ''}`} data-size={size}>
      <div
        ref={scroller}
        className="cgw-gallery-scroll"
        role="region"
        aria-label={t('gallery.label', { name })}
        aria-busy={snapshot.loading || undefined}
        onScroll={measure}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div className="cgw-gallery-grid" style={{ blockSize: layout.total }}>
          {tiles.map((i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const style = {
              insetBlockStart: layout.offsets[r],
              insetInlineStart: c * (width + GALLERY_GAP),
              insetInlineEnd: 'auto',
              inlineSize: width,
              blockSize: layout.offsets[r + 1] - layout.offsets[r] - GALLERY_GAP,
            };
            if (i === rows.length) {
              return (
                <div key="new" className="cgw-card cgw-gallery-new" style={style}>
                  {draft && titleDef ? (
                    <div className="cgw-gallery-draft">
                      <InlineEditor
                        def={titleDef}
                        row={draftRow(database)}
                        env={env}
                        label={t('card.newLabel')}
                        className="cgw-card-input"
                        commit={(value) => {
                          if (typeof value === 'string' && value.trim())
                            void actions.createRow({ title: value, view });
                        }}
                        onDone={() => setDraft(false)}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="cgw-board-new cgw-gallery-new-button"
                      onClick={() => setDraft(true)}
                    >
                      <span aria-hidden="true">＋ </span>
                      {t('gallery.newCard')}
                    </button>
                  )}
                </div>
              );
            }
            const row = rows[i];
            const asset = cover ? coverAsset(row, config, (id) => host.assets?.info(id)) : null;
            return (
              <Card
                key={row.id}
                row={row}
                cardKey={row.id}
                idPrefix={idPrefix}
                shown={shown}
                env={env}
                active={i === activeIndex}
                draggable={false}
                style={style}
                cover={
                  cover ? (
                    <Cover
                      assets={host.assets}
                      assetId={asset}
                      height={cover}
                      label={t('gallery.noCover')}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </div>
        {empty ? (
          <p className="cgw-gallery-empty">
            {searching || (config.filter?.children.length ?? 0) > 0
              ? t('gallery.noMatch')
              : t('gallery.empty')}
          </p>
        ) : null}
      </div>
      <div className="cgw-table-foot" role="status">
        {snapshot.complete
          ? t('rowCount', { count: snapshot.total })
          : t('rowsShown', { shown: rows.length, total: snapshot.total })}
      </div>
      <CgContextMenu<RowRecord> items={cardItems} actionsRef={cardMenu} ariaLabel={t('row.menu')} />
    </div>
  );
}

/** Picture URLs, asked once per file and kept while the page lives. */
const coverUrls = new WeakMap<DatabaseAssets, Map<Id, Promise<string | null>>>();
function coverUrl(assets: DatabaseAssets, id: Id): Promise<string | null> {
  let urls = coverUrls.get(assets);
  if (!urls) coverUrls.set(assets, (urls = new Map()));
  let url = urls.get(id);
  if (!url) {
    url = assets.url(id).catch(() => null);
    urls.set(id, url);
  }
  return url;
}

/** A card's picture: the image once its URL is known, a plain area until then or without one. */
const Cover = memo(function Cover({
  assets,
  assetId,
  height,
  label,
}: {
  assets: DatabaseAssets | undefined;
  assetId: Id | null;
  height: number;
  label: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!assets || !assetId) return;
    let live = true;
    void coverUrl(assets, assetId).then((found) => {
      if (live) setUrl(found);
    });
    return () => {
      live = false;
    };
  }, [assets, assetId]);
  return (
    <div
      className="cgw-gallery-cover"
      style={{ blockSize: height }}
      data-empty={!url || failed || undefined}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="cgw-views-sr">{label}</span>
      )}
    </div>
  );
});
