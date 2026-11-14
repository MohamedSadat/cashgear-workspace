// A block's "Import this range into a database" (M5.5): the workbook's sheets (`GET …/sheets`),
// a sheet and a range (the block's own at first), a new database under the page or one that
// exists, then the range as CSV (`GET …/range`, canonical text) into the CSV import the database
// views already have, which writes on the device or through the server's import as it does for a
// file. Nothing of the workbook is kept but what the import writes.
import { parseRange, rangeCells } from '@cgw/editor';
import { ImportDialog } from '@cgw/database';
import type { DatabasePlace } from '@cgw/database';
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import type { ShellDatabaseHost } from '../database/host';
import { Dialog } from '../Dialog';
import { isRowRecord, type WorkspaceSession } from '../session';
import { failureCode, statusOf, workbookApi, type WorkbookSheet } from './api';
import type { RangeImportSource } from './requests';
import { RANGE_EXAMPLE } from './view';
import { useUnavailable } from './WorkbookPicker';
import './sheet.css';

/** Where a new database goes: under the block's page; beside a row's database; else the top. */
function placeFor(session: WorkspaceSession, pageId: Id | null): DatabasePlace | null {
  const page = pageId ? session.record(pageId) : undefined;
  const workspaceId = page?.workspaceId ?? session.workspaceId;
  if (!workspaceId) return null;
  if (page && !isRowRecord(page))
    return {
      workspaceId,
      sectionId: page.sectionId,
      parentPageId: page.id,
      orderKey: session.keyFor(page.sectionId, page.id),
    };
  const holder = isRowRecord(page) ? session.mirror.pages.get(page.databaseId) : undefined;
  const sectionId = holder?.sectionId ?? session.mirror.sectionsOf(workspaceId)[0]?.id;
  if (!sectionId) return null;
  const parentPageId = holder?.parentPageId ?? null;
  return {
    workspaceId,
    sectionId,
    parentPageId,
    orderKey: session.keyFor(sectionId, parentPageId),
  };
}

/** A file name for the CSV: the import names a new database after it. */
const csvName = (workbook: string, sheet: string) =>
  `${`${workbook} ${sheet}`.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'range'}.csv`;

export function RangeImport({
  session,
  cloud,
  databases,
  source,
  onDone,
}: {
  session: WorkspaceSession;
  cloud: Cloud | null;
  databases: ShellDatabaseHost;
  source: RangeImportSource;
  onDone: (made: { databaseId: Id } | null) => void;
}) {
  const { t } = useTranslation();
  const unavailable = useUnavailable(session, cloud);
  const api = useMemo(() => (cloud ? workbookApi(cloud.api) : null), [cloud]);
  const [sheets, setSheets] = useState<WorkbookSheet[] | null>(null);
  const [sheet, setSheet] = useState(source.sheet ?? '');
  const [range, setRange] = useState(source.range ?? '');
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [databaseId, setDatabaseId] = useState<Id | ''>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!api || unavailable) return;
    let live = true;
    api.sheets(source.workbookId).then(
      (list) => {
        if (!live) return;
        const visible = list.filter((s) => !s.hidden);
        setSheets(visible);
        setSheet((current) => {
          const named = visible.find(
            (s) => s.name.toLocaleLowerCase() === current.toLocaleLowerCase(),
          );
          return named?.name ?? visible[0]?.name ?? '';
        });
      },
      (error: unknown) =>
        live &&
        setMessage(
          failureCode(error) === 'offline' ? t('sheets.offlineNone') : t('sheets.importFailed'),
        ),
    );
    return () => {
      live = false;
    };
  }, [api, unavailable, source.workbookId, t]);

  const choices = useMemo(() => {
    const out: { id: Id; title: string }[] = [];
    for (const database of session.mirror.databases.values()) {
      const page = session.mirror.pages.get(database.id);
      if (!page || page.trashedAt || database.workspaceId !== session.workspaceId) continue;
      if (!session.canEdit(page.id)) continue;
      out.push({ id: page.id, title: page.title || t('database.untitledDatabase') });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }, [session, t]);
  const usedRange = sheets?.find((s) => s.name === sheet)?.usedRange ?? null;

  const next = async () => {
    if (!api || busy) return;
    const text = range.trim().toUpperCase();
    if (text && !parseRange(text)) return setMessage(t('sheets.rangeInvalid'));
    if (target === 'existing' && !databaseId) return setMessage(t('sheets.importChoose'));
    setBusy(true);
    setMessage(null);
    try {
      const answer = await api.range(source.workbookId, sheet || null, text || null);
      if (!answer.csv.trim()) {
        setMessage(t('sheets.importEmpty'));
        return;
      }
      setFile(new File([answer.csv], csvName(source.name, answer.sheet), { type: 'text/csv' }));
    } catch (error) {
      const status = statusOf(error);
      setMessage(
        failureCode(error) === 'offline'
          ? t('sheets.offlineNone')
          : status === 413
            ? t('sheets.importTooLarge')
            : t('sheets.importFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  // The range as a file, into the CSV import (its own dialog from here).
  if (file)
    return (
      <ImportDialog
        host={databases}
        databaseId={target === 'existing' && databaseId ? databaseId : null}
        place={placeFor(session, source.pageId) ?? undefined}
        initialFile={file}
        onClose={(result) => onDone(result ? { databaseId: result.databaseId } : null)}
      />
    );

  const cells = range.trim() ? rangeCells(range.trim().toUpperCase()) : null;
  return (
    <Dialog title={t('sheets.importTitle', { name: source.name })} onClose={() => onDone(null)}>
      {unavailable ? (
        <p role="status" className="cgw-muted">
          {t(
            unavailable === 'local'
              ? 'sheets.local'
              : unavailable === 'signedOut'
                ? 'sheets.signIn'
                : 'sheets.offlineNone',
          )}
        </p>
      ) : (
        <form
          className="cgw-workbook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void next();
          }}
        >
          <label htmlFor="cgw-range-sheet">{t('sheets.sheet')}</label>
          <select
            id="cgw-range-sheet"
            className="cgw-input"
            value={sheet}
            disabled={!sheets}
            onChange={(event) => setSheet(event.target.value)}
          >
            {(sheets ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <label htmlFor="cgw-range-range">{t('sheets.range')}</label>
          <input
            id="cgw-range-range"
            className="cgw-input"
            dir="ltr"
            value={range}
            placeholder={usedRange ?? RANGE_EXAMPLE}
            aria-describedby="cgw-range-hint"
            onChange={(event) => {
              setRange(event.target.value);
              setMessage(null);
            }}
          />
          <span id="cgw-range-hint" className="cgw-muted">
            {cells
              ? t('sheets.importCells', { count: cells })
              : t('sheets.importUsed', { range: usedRange ?? '' })}
          </span>
          <fieldset>
            <legend>{t('sheets.importTarget')}</legend>
            <label className="cgw-workbook-choice">
              <input
                type="radio"
                name="cgw-range-target"
                checked={target === 'new'}
                onChange={() => setTarget('new')}
              />
              {t('sheets.importNew')}
            </label>
            <label className="cgw-workbook-choice">
              <input
                type="radio"
                name="cgw-range-target"
                checked={target === 'existing'}
                disabled={!choices.length}
                onChange={() => setTarget('existing')}
              />
              {t('sheets.importExisting')}
            </label>
            {target === 'existing' && (
              <select
                className="cgw-input"
                aria-label={t('sheets.importExisting')}
                value={databaseId}
                onChange={(event) => setDatabaseId(event.target.value)}
              >
                <option value="" />
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
          {message && (
            <p role="alert" className="cgw-muted">
              {message}
            </p>
          )}
        </form>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={() => onDone(null)}>
          {t('frame.cancel')}
        </button>
        {!unavailable && (
          <button
            type="button"
            className="cgw-button is-primary"
            disabled={busy || !sheets}
            onClick={() => void next()}
          >
            {busy ? t('sheets.importReading') : t('sheets.importNext')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
