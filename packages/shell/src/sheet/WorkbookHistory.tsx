// A workbook's history (Phase 9, M9.3): its kept versions (the newest 10), newest first, each with
// when it was saved and by whom; one opened read-only in Sheet's embed by that version's own
// short signed URL; and, for someone with `edit` or above, an older one restored as a new newest
// version (the server copies its bytes, saved by the restorer now, and keeps every version). The
// server decides every read and the restore; a refusal says so. Opened from the workbook list and
// from a block's menu.
import { SheetEmbed, type SheetErrorCode, type SheetSource, type SheetView } from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import {
  canEditWorkbook,
  failureCode,
  type Workbook,
  type WorkbookApi,
  type WorkbookVersion,
} from './api';
import type { EmbedFactory, EmbedLike } from './SheetBlock';
import './sheet.css';

/** A version is drawn as the first sheet's cells in use, as a new block shows a workbook. */
const VERSION_VIEW: SheetView = { kind: 'range', sheet: null, range: null };
/** The frame's most height in the dialog. */
const MAX_FRAME = 420;

const ERROR_TEXT: Record<SheetErrorCode, string> = {
  'source.unavailable': 'sheets.errorUnavailable',
  'source.forbidden': 'sheets.errorUnavailable',
  'view.notFound': 'sheets.errorNotFound',
  'workbook.tooLarge': 'sheets.errorTooLarge',
  'range.tooLarge': 'sheets.errorRangeTooLarge',
  'contract.unsupported': 'sheets.errorContract',
};

/** The content's entity tag, `"<versionId>"`, as the restore's `If-Match`. */
export const etagOf = (versionId: Id) => `"${versionId}"`;

type Listing =
  | { kind: 'loading' }
  | { kind: 'ready'; versions: WorkbookVersion[] }
  | { kind: 'failed'; code: string };

type Shown =
  | { kind: 'none' }
  | { kind: 'loading'; versionId: Id }
  | { kind: 'loaded'; versionId: Id; height: number | null }
  | { kind: 'error'; versionId: Id; text: string };

export interface WorkbookHistoryProps {
  api: WorkbookApi;
  workbook: Workbook;
  /** The build's Sheet origin (`sheetOriginOf`); without one a version cannot be shown. */
  sheetOrigin: string | null;
  theme: 'light' | 'dark';
  onClose(): void;
  /** A version was restored: what shows the workbook reads it again. */
  onRestored?(): void;
  /** Tests: makes the embed (default: SheetEmbed). */
  embed?: EmbedFactory;
}

export function WorkbookHistory({
  api,
  workbook,
  sheetOrigin,
  theme,
  onClose,
  onRestored,
  embed: makeEmbed,
}: WorkbookHistoryProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language === 'ar' ? 'ar' : 'en';
  const editor = canEditWorkbook(workbook.access);
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const [reading, setReading] = useState(0);
  const [shown, setShown] = useState<Shown>({ kind: 'none' });
  const [confirming, setConfirming] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const embedRef = useRef<EmbedLike | null>(null);

  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const refusal = useCallback(
    (error: unknown) => {
      const code = failureCode(error);
      return code === 'offline'
        ? t('sheets.offlineNone')
        : code === 'access.denied'
          ? t('sheets.refused')
          : code === 'version.conflict'
            ? t('sheets.historyConflict')
            : t('sheets.historyFailed');
    },
    [t],
  );

  useEffect(() => {
    let live = true;
    setListing({ kind: 'loading' });
    api.versions(workbook.id).then(
      (versions) => live && setListing({ kind: 'ready', versions }),
      (error: unknown) => live && setListing({ kind: 'failed', code: failureCode(error) }),
    );
    return () => {
      live = false;
    };
  }, [api, workbook.id, reading]);

  // ---- One version, read-only in the embed --------------------------------------------------
  const shownId = shown.kind === 'none' ? null : shown.versionId;
  useEffect(() => {
    const container = stage.current;
    if (!shownId || !container) return;
    if (!sheetOrigin) {
      setShown({ kind: 'error', versionId: shownId, text: t('sheets.noOrigin') });
      return;
    }
    let alive = true;
    let embed: EmbedLike | null = null;
    let retried = false;
    const source = async (): Promise<SheetSource | null> => {
      const content = await api.versionContent(workbook.id, shownId);
      return content.readUrl && content.etag
        ? { kind: 'url', url: content.readUrl, etag: content.etag }
        : null;
    };
    const fail = (text: string) => alive && setShown({ kind: 'error', versionId: shownId, text });
    void source().then(
      (first) => {
        if (!alive) return;
        if (!first) return fail(t('sheets.historyFailed'));
        const make: EmbedFactory =
          makeEmbed ?? ((c, o, e) => new SheetEmbed(c, o, e) as unknown as EmbedLike);
        try {
          embed = make(
            container,
            {
              sheetOrigin,
              source: first,
              view: VERSION_VIEW,
              theme,
              direction: language === 'ar' ? 'rtl' : 'ltr',
              locale: language,
              title: t('sheets.versionTitle', { name: workbook.name }),
            },
            {
              loaded: (drawn) =>
                alive &&
                setShown({ kind: 'loaded', versionId: shownId, height: drawn.size.height }),
              resize: (size) =>
                alive &&
                setShown((current) =>
                  current.kind === 'loaded' && current.versionId === shownId
                    ? { ...current, height: size.height }
                    : current,
                ),
              error: (failure) => {
                if (!alive) return;
                // The signed URL expired: one new one, then as unavailable.
                if (failure.code === 'source.forbidden' && !retried) {
                  retried = true;
                  void source().then(
                    (next) => (next ? embed?.refresh(next) : fail(t('sheets.errorUnavailable'))),
                    (error: unknown) => fail(refusal(error)),
                  );
                  return;
                }
                fail(t(ERROR_TEXT[failure.code] as 'sheets.errorUnavailable'));
              },
            },
          );
          embedRef.current = embed;
        } catch (error) {
          console.warn('The version could not be shown:', error);
          fail(t('sheets.errorUnavailable'));
        }
      },
      (error: unknown) => fail(refusal(error)),
    );
    return () => {
      alive = false;
      embed?.destroy();
      embedRef.current = null;
    };
    // One embed per version shown; the theme goes to it below.
  }, [shownId, sheetOrigin, api, workbook.id]);

  useEffect(() => {
    embedRef.current?.setTheme({
      theme,
      direction: language === 'ar' ? 'rtl' : 'ltr',
      locale: language,
    });
  }, [theme, language]);

  // ---- Restore ----------------------------------------------------------------------------------
  const versions = listing.kind === 'ready' ? listing.versions : [];
  const current = versions.find((v) => v.current) ?? null;
  const restore = async (version: WorkbookVersion) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.restoreVersion(workbook.id, version.id, current ? etagOf(current.id) : null);
      setConfirming(null);
      setMessage({
        text: t('sheets.historyRestored', { when: date(version.savedAt) }),
        alert: false,
      });
      onRestored?.();
    } catch (error) {
      setConfirming(null);
      setMessage({ text: refusal(error), alert: true });
    } finally {
      setBusy(false);
      setReading((n) => n + 1);
    }
  };

  const savedLine = (version: WorkbookVersion) =>
    version.savedBy
      ? t('sheets.savedBy', { when: date(version.savedAt), name: version.savedBy.name })
      : t('sheets.saved', { when: date(version.savedAt) });
  const shownVersion = versions.find((v) => v.id === shownId) ?? null;

  return (
    <Dialog title={t('sheets.historyTitle', { name: workbook.name })} onClose={onClose}>
      <div className="cgw-workbook-history" data-testid="workbook-history">
        <p className="cgw-workbooks-muted">{t('sheets.historyNote')}</p>
        {listing.kind === 'loading' ? (
          <p aria-busy="true" className="cgw-workbooks-muted">
            {t('app.loading')}
          </p>
        ) : listing.kind === 'failed' ? (
          <p role="alert" className="cgw-sheet-message is-warn">
            {listing.code === 'offline'
              ? t('sheets.offlineNone')
              : listing.code === 'access.denied'
                ? t('sheets.refused')
                : t('sheets.historyFailed')}{' '}
            <button
              type="button"
              className="cgw-button cgw-sheet-button"
              onClick={() => setReading((n) => n + 1)}
            >
              {t('sheets.historyRetry')}
            </button>
          </p>
        ) : versions.length === 0 ? (
          <p className="cgw-workbooks-muted" data-testid="workbook-history-empty">
            {t('sheets.historyEmpty')}
          </p>
        ) : (
          <ol className="cgw-workbook-versions" aria-label={t('sheets.historyList')}>
            {versions.map((version) => {
              const line = savedLine(version);
              const isShown = version.id === shownId;
              return (
                <li key={version.id} className="cgw-workbook-version" data-version={version.id}>
                  <span className="cgw-workbook-version-line">
                    <span>{line}</span>
                    {version.current ? (
                      <span className="cgw-workbook-current">{t('sheets.historyCurrent')}</span>
                    ) : null}
                  </span>
                  <span className="cgw-workbooks-actions">
                    <button
                      type="button"
                      className="cgw-button cgw-sheet-button"
                      aria-pressed={isShown}
                      aria-label={t('sheets.historyShowNamed', { when: date(version.savedAt) })}
                      onClick={() =>
                        setShown(
                          isShown ? { kind: 'none' } : { kind: 'loading', versionId: version.id },
                        )
                      }
                    >
                      {isShown ? t('sheets.historyHide') : t('sheets.historyShow')}
                    </button>
                    {editor && !version.current ? (
                      <button
                        type="button"
                        className="cgw-button cgw-sheet-button"
                        disabled={busy}
                        aria-label={t('sheets.historyRestoreNamed', {
                          when: date(version.savedAt),
                        })}
                        onClick={() => setConfirming(version.id)}
                      >
                        {t('sheets.historyRestore')}
                      </button>
                    ) : null}
                  </span>
                  {confirming === version.id ? (
                    <span className="cgw-workbook-confirm" role="group" aria-label={line}>
                      <span>{t('sheets.historyConfirm', { when: date(version.savedAt) })}</span>
                      <button
                        type="button"
                        className="cgw-button cgw-sheet-button is-primary"
                        disabled={busy}
                        onClick={() => void restore(version)}
                      >
                        {t('sheets.historyRestoreNow')}
                      </button>
                      <button
                        type="button"
                        className="cgw-button cgw-sheet-button"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {t('frame.cancel')}
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {!editor && versions.length > 1 ? (
          <p className="cgw-workbooks-muted" data-testid="workbook-history-reader">
            {t('sheets.historyReader')}
          </p>
        ) : null}
        {message ? (
          <p
            className={message.alert ? 'cgw-sheet-message is-warn' : 'cgw-workbooks-muted'}
            role={message.alert ? 'alert' : 'status'}
            data-testid="workbook-history-message"
          >
            {message.text}
          </p>
        ) : null}
        {shown.kind !== 'none' ? (
          <section
            className="cgw-workbook-preview"
            aria-label={
              shownVersion
                ? t('sheets.historyShown', { when: date(shownVersion.savedAt) })
                : t('sheets.block')
            }
            data-state={shown.kind}
          >
            {shownVersion ? (
              <p className="cgw-workbooks-muted">
                {t('sheets.historyShown', { when: date(shownVersion.savedAt) })}
              </p>
            ) : null}
            {shown.kind === 'loading' ? (
              <p aria-busy="true" className="cgw-workbooks-muted">
                {t('sheets.loading')}
              </p>
            ) : shown.kind === 'error' ? (
              <p role="alert" className="cgw-sheet-message is-warn">
                {shown.text}
              </p>
            ) : null}
          </section>
        ) : null}
        <div
          ref={stage}
          className="cgw-workbook-frame"
          hidden={shown.kind === 'none' || shown.kind === 'error'}
          data-shown={shown.kind === 'loaded' || undefined}
          style={
            shown.kind === 'loaded' && shown.height
              ? { blockSize: `${Math.max(1, Math.min(shown.height, MAX_FRAME))}px` }
              : undefined
          }
        />
      </div>
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('frame.close')}
        </button>
      </div>
    </Dialog>
  );
}
