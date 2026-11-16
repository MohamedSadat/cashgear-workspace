// The gallery view: the rows as cards in a grid, each with the view's picture (none, the row's page
// cover, or the first image of a files property, read through `host.assets`), its title and the
// view's shown properties; small, medium or large cards, as many to a row as fit. Grid rows are
// virtualised (only those in the window are drawn). One card is in the tab order; the arrows
// move through the grid (mirrored in RTL), Enter opens a card. "New" types a title in place.
//
// Cards move (Phase 8) as the board's do: a drag by the pointer (`cgTrackDrag`: a copy follows it,
// one `CgDropIndicator` shows where it lands) or by the keys (Space picks a card up, the arrows
// move it through the grid, Space or Enter drops it, Escape cancels), spoken through the
// `CgLiveAnnouncer`. The order is the rows' own (their order keys, one `page.move`), as a board's
// within a column and every view without a sort; a view with a sort keeps the sort's order, so its
// cards do not move by hand.
import {
  CgContextMenu,
  CgDropIndicator,
  CgLiveAnnouncer,
  cgStartsDrag,
  cgTrackDrag,
  type CgContextMenuActions,
  type CgContextMenuItem,
  type CgDropIndicatorHandle,
  type CgLiveAnnouncerHandle,
} from '@cashgear/ui';
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
  type PointerEvent,
} from 'react';
import { InlineEditor } from '../../cells/InlineEditor';
import { needsMove, placeAt, targetIndex } from '../board/layout';
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
  galleryDropAt,
  galleryDropIndex,
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
  const { t, locale } = useDbT();
  const env = useCellEnv(host, actions, editable);
  const sorted = view.config.sorts.length > 0;
  const draggable = editable && !sorted;
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
  // ---- Moving a card ---------------------------------------------------------------------------
  const live = useRef<CgLiveAnnouncerHandle>(null);
  const grid = useRef<HTMLDivElement>(null);
  const indicator = useRef<CgDropIndicatorHandle>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const geometry = useRef({ layout, cols, width });
  geometry.current = { layout, cols, width };
  const shownAt = useRef<number | null>(null);
  /** The indicator before the card at an insertion index (after the last card at the end). */
  const showIndicator = (index: number) => {
    // Most frames of a drag land where the last one did: nothing to move.
    if (shownAt.current === index) return;
    shownAt.current = index;
    const g = geometry.current;
    const at = galleryDropAt(index, rowsRef.current.length, g.cols, g.width);
    const top = g.layout.offsets[at.row] ?? 0;
    const bottom = g.layout.offsets[at.row + 1] ?? top;
    indicator.current?.show({
      orientation: 'vertical',
      block: top,
      inline: at.inline,
      length: Math.max(20, bottom - top - GALLERY_GAP),
    });
  };
  const hideIndicator = () => {
    shownAt.current = null;
    indicator.current?.hide();
  };

  /** Moves a card to `index` among the other cards; tells the person where it went. */
  const commitMove = (row: RowRecord, index: number | null) => {
    const list = rowsRef.current;
    const others = list.filter((r) => r.id !== row.id);
    if (index === null || !needsMove(row, others, index)) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    void actions.moveRow(row, placeAt(others, index));
    live.current?.announce(
      t('gallery.dropped', {
        title: row.title || t('untitled'),
        index: (index + 1).toLocaleString(locale),
      }),
    );
  };

  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !draggable || picked.current) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!card || !cgStartsDrag(event.target, card)) return;
    const row = rowsRef.current.find((r) => r.id === card.dataset.card);
    const body = grid.current;
    if (!row || !body) return;
    const from = rowsRef.current.indexOf(row);
    let drop: number | null = null;
    stopDrag.current?.();
    stopDrag.current = cgTrackDrag(event.nativeEvent, card, {
      scroller: scroller.current,
      ghostClassName: 'cgw-drag-ghost',
      onMove(x, y) {
        const box = body.getBoundingClientRect();
        const rtlNow = getComputedStyle(body).direction === 'rtl';
        const g = geometry.current;
        const at = galleryDropIndex(
          g.layout,
          rowsRef.current.length,
          g.cols,
          g.width,
          rtlNow ? box.right - x : x - box.left,
          y - box.top,
        );
        drop = targetIndex(true, from, at);
        if (drop === null) hideIndicator();
        else showIndicator(at);
      },
      onDrop() {
        hideIndicator();
        stopDrag.current = null;
        commitMove(row, drop);
      },
      onCancel() {
        hideIndicator();
        stopDrag.current = null;
      },
    });
  };

  /** A card picked up by the keys: where it came from and where it would land. */
  const picked = useRef<{ row: RowRecord; from: number; index: number } | null>(null);
  const endPick = (commit: boolean) => {
    const p = picked.current;
    picked.current = null;
    hideIndicator();
    if (!p) return;
    document.getElementById(cardDomId(idPrefix, p.row.id))?.removeAttribute('data-cg-dragging');
    if (!commit || p.index === p.from) {
      live.current?.announce(t('card.cancelled'));
      return;
    }
    commitMove(p.row, p.index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[data-card]')) return;
    const index = indexOf(target);
    const row = rows[index];
    if (!row) return;
    const p = picked.current;
    if (p) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') return endPick(false);
      if (event.key === ' ' || event.key === 'Enter') return endPick(true);
      const next = galleryMove(
        p.index,
        rows.length,
        cols,
        event.key,
        getComputedStyle(target).direction === 'rtl',
      );
      if (next === null || next === p.index) return;
      p.index = next;
      // Shown as an insertion among every card: after itself when it goes later.
      showIndicator(next > p.from ? next + 1 : next);
      live.current?.announce(
        t('gallery.position', {
          index: (next + 1).toLocaleString(locale),
          count: rows.length.toLocaleString(locale),
        }),
      );
      return;
    }
    if (event.key === ' ' && draggable) {
      event.preventDefault();
      picked.current = { row, from: index, index };
      target.setAttribute('data-cg-dragging', '');
      live.current?.announce(t('card.pickedUp', { title: row.title || t('untitled') }));
      return;
    }
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
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (picked.current && !scroller.current?.contains(event.relatedTarget as Node | null))
      endPick(false);
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
      {sorted && editable && rows.length > 1 ? (
        <p className="cgw-board-note">{t('gallery.sorted')}</p>
      ) : null}
      <div
        ref={scroller}
        className="cgw-gallery-scroll"
        role="region"
        aria-label={t('gallery.label', { name })}
        aria-busy={snapshot.loading || undefined}
        onScroll={measure}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div ref={grid} className="cgw-gallery-grid" style={{ blockSize: layout.total }}>
          <CgDropIndicator ref={indicator} className="cgw-db-drop-indicator" />
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
                draggable={draggable}
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
      <CgLiveAnnouncer ref={live} />
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
