// The import panel (Settings → Your data → Import from Markdown, Notion or Word): what to import,
// the section it goes into, the file or folder, then the import's progress with a Stop button, and
// at its end the report of what was made and what was skipped, and why (M8.4).
import { CgButton, CgFilePicker, CgProgressBar, CgRadioGroup } from '@cashgear/ui';
import { useRef, useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../Dialog';
import { navigate } from '../../route';
import type { WorkspaceSession } from '../../session';
import { treeRows } from '../../sidebar/tree';
import type { SectionRecord } from '@cgw/workspace';
import { IMPORT_MAX_BYTES, IMPORT_MAX_PAGES } from './limits';
import type { ImportKind, ImportSource } from './plan';
import { ImportRefused, type ImportReport, type RefusalCode } from './report';
import type { ImportOutcome, RunOptions } from './run';
import './import.css';

type Phase =
  | { kind: 'choose' }
  | { kind: 'reading' }
  | { kind: 'writing'; done: number; total: number }
  | { kind: 'stopping' }
  | { kind: 'done'; topId: string; report: ImportReport }
  | { kind: 'refused'; code: RefusalCode; count?: number };

const MB = 1024 * 1024;

const ACCEPT: Record<ImportKind, string> = {
  markdown: '.zip,.md,.markdown,application/zip,text/markdown',
  notion: '.zip,application/zip',
  word: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * A folder picker: the browsers' attribute, which React does not type. The library's file picker
 * (Track U16) takes files only, so the folder keeps its own input (phase-8 swaps).
 */
const folderPicker = {
  webkitdirectory: '',
  directory: '',
} as InputHTMLAttributes<HTMLInputElement>;

/**
 * The sections a new page may go at the top of, by the sidebar's own rule for its "Add a page in"
 * control: the section rows its tree draws (`treeRows`), each of which offers it (`PageTree`'s
 * `mayHold` holds at every section's top). The server still decides.
 */
export function sectionsForNewPages(session: WorkspaceSession): SectionRecord[] {
  const workspaceId = session.workspaceId;
  if (!workspaceId) return [];
  return treeRows(session.mirror, workspaceId, new Set()).flatMap((row) =>
    row.kind === 'section' ? [row.section] : [],
  );
}

export interface ImportPanelProps {
  session: WorkspaceSession;
  onClose(): void;
  /** How the import runs (tests plan on this thread). */
  runOptions?: Pick<RunOptions, 'inline'>;
}

export function ImportPanel({ session, onClose, runOptions }: ImportPanelProps) {
  const { t, i18n } = useTranslation();
  const number = (n: number) => n.toLocaleString(i18n.language);
  const sections = sectionsForNewPages(session);
  const [kind, setKind] = useState<ImportKind>('markdown');
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const stop = useRef<AbortController | null>(null);
  const drawn = useRef(0);
  const folder = useRef<HTMLInputElement>(null);
  const busy = phase.kind === 'reading' || phase.kind === 'writing' || phase.kind === 'stopping';

  const start = async (source: ImportSource) => {
    const controller = new AbortController();
    stop.current = controller;
    setPhase({ kind: 'reading' });
    try {
      const { runImport } = await import('./run');
      const outcome: ImportOutcome = await runImport(
        session,
        {
          kind,
          source,
          sectionId,
          untitled: t('page.untitled'),
          viewName: t('database.templates.tableView'),
          name: t(kind === 'notion' ? 'exchange.fromNotion' : 'exchange.importTitle'),
        },
        {
          ...runOptions,
          signal: controller.signal,
          onPhase: (next, progress) => {
            if (controller.signal.aborted) return;
            if (next === 'reading') return setPhase({ kind: 'reading' });
            // The count is drawn at most every 100 ms: a render per page would slow the import.
            const now = performance.now();
            const last = progress && progress.done === progress.total;
            if (now - drawn.current < 100 && !last && progress?.done) return;
            drawn.current = now;
            setPhase({ kind: 'writing', done: progress?.done ?? 0, total: progress?.total ?? 0 });
          },
        },
      );
      setPhase({ kind: 'done', ...outcome });
    } catch (error) {
      if (!(error instanceof ImportRefused)) console.error(error);
      const refused = error instanceof ImportRefused ? error : new ImportRefused('failed');
      setPhase({ kind: 'refused', code: refused.code, count: refused.count });
    } finally {
      stop.current = null;
    }
  };

  /** Sizes are known before a byte is read: more than the limit is refused at once. */
  const tooLarge = (bytes: number) => {
    if (bytes <= IMPORT_MAX_BYTES) return false;
    setPhase({ kind: 'refused', code: 'tooLarge', count: IMPORT_MAX_BYTES / MB });
    return true;
  };

  const onFile = async (chosen: File | undefined) => {
    if (!chosen || tooLarge(chosen.size)) return;
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    await start({ kind: 'bytes', name: chosen.name, bytes });
  };

  const onFolder = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length || tooLarge(chosen.reduce((n, f) => n + f.size, 0))) return;
    const files = await Promise.all(
      chosen.map(async (f) => ({
        path: f.webkitRelativePath || f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );
    const name = files[0].path.split('/')[0] || chosen[0].name;
    await start({ kind: 'folder', name, files });
  };

  const close = () => {
    // Closing while it runs stops it: what was made is removed, then the panel says so.
    if (busy) {
      stop.current?.abort();
      setPhase({ kind: 'stopping' });
      return;
    }
    onClose();
  };

  return (
    <Dialog title={t('exchange.importTitle')} onClose={close}>
      <div className="cgw-import" data-testid="import-panel">
        {phase.kind === 'choose' && (
          <>
            <CgRadioGroup<ImportKind>
              legend={t('exchange.importKind')}
              value={kind}
              onValueChange={setKind}
              options={[
                { value: 'markdown', label: t('exchange.kindMarkdown') },
                { value: 'notion', label: t('exchange.kindNotion') },
                { value: 'word', label: t('exchange.kindWord') },
              ]}
            />
            {sections.length > 1 && (
              <label className="cgw-import-field">
                <span>{t('exchange.importSection')}</span>
                <select
                  className="cgw-input"
                  value={sectionId}
                  onChange={(event) => setSectionId(event.target.value)}
                >
                  {sections.map((section) => (
                    <option key={section.id} value={section.id} dir="auto">
                      {section.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="cgw-muted">{t('exchange.importWhere')}</p>
            <p className="cgw-muted">
              {t('exchange.importLimits', {
                pages: number(IMPORT_MAX_PAGES),
                megabytes: number(IMPORT_MAX_BYTES / MB),
              })}
            </p>
            <div className="cgw-dialog-buttons cgw-import-buttons">
              {kind === 'markdown' && (
                <CgButton
                  appearance="outline"
                  disabled={!sectionId}
                  onClick={() => folder.current?.click()}
                >
                  {t('exchange.chooseFolder')}
                </CgButton>
              )}
              <CgFilePicker
                intent="primary"
                containerClassName="cgw-import-file"
                accept={ACCEPT[kind]}
                disabled={!sectionId}
                onPick={([chosen]) => void onFile(chosen)}
                // A file the dialog let through of another kind: the import says why it refuses.
                onReject={([chosen]) => void onFile(chosen)}
              >
                {t('exchange.chooseFile')}
              </CgFilePicker>
            </div>
            <input
              ref={folder}
              type="file"
              hidden
              multiple
              {...folderPicker}
              aria-label={t('exchange.chooseFolder')}
              data-testid="import-folder"
              onChange={(event) => {
                const list = event.target.files;
                void onFolder(list).finally(() => (event.target.value = ''));
              }}
            />
          </>
        )}
        {busy && (
          <div className="cgw-import-progress">
            {/* The phase is announced; the count changes too often to be. */}
            <p role="status" aria-live="polite">
              {t(
                phase.kind === 'reading'
                  ? 'exchange.reading'
                  : phase.kind === 'stopping'
                    ? 'exchange.stopping'
                    : 'exchange.writingPhase',
              )}
            </p>
            {phase.kind === 'writing' && phase.total > 0 && (
              <p className="cgw-muted">
                {t('exchange.writing', { done: number(phase.done), total: number(phase.total) })}
              </p>
            )}
            <CgProgressBar
              aria-label={t('exchange.progress')}
              {...(phase.kind === 'writing' && phase.total
                ? { value: phase.done, max: phase.total }
                : {})}
            />
            <div className="cgw-dialog-buttons">
              <button
                type="button"
                className="cgw-button"
                // Focus follows the panel: the button that was pressed has gone.
                autoFocus
                disabled={phase.kind === 'stopping'}
                onClick={() => {
                  stop.current?.abort();
                  setPhase({ kind: 'stopping' });
                }}
              >
                {t('exchange.stop')}
              </button>
            </div>
          </div>
        )}
        {phase.kind === 'done' && (
          <ImportReportView
            report={phase.report}
            onOpen={() => {
              navigate({ kind: 'page', pageId: phase.topId });
              onClose();
            }}
            onAgain={() => setPhase({ kind: 'choose' })}
            onClose={onClose}
          />
        )}
        {phase.kind === 'refused' && (
          <>
            <p role="alert" className="cgw-import-refused">
              {t(`exchange.refused.${phase.code}`, { number: number(phase.count ?? 0) })}
            </p>
            <div className="cgw-dialog-buttons">
              <button type="button" className="cgw-button" onClick={onClose}>
                {t('exchange.close')}
              </button>
              <button
                type="button"
                className="cgw-button is-primary"
                autoFocus
                onClick={() => setPhase({ kind: 'choose' })}
              >
                {t('exchange.tryAgain')}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** An import's report: what was made, then what was skipped and why, with a few examples. */
export function ImportReportView({
  report,
  onOpen,
  onAgain,
  onClose,
}: {
  report: ImportReport;
  onOpen(): void;
  onAgain(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { made } = report;
  return (
    <div className="cgw-import-report" data-testid="import-report">
      {/* Announced when the import ends: what was made. */}
      <div role="status">
        <h3 id="cgw-import-made">{t('exchange.madeTitle')}</h3>
        <ul aria-labelledby="cgw-import-made">
          <li>{t('exchange.madePages', { count: made.pages })}</li>
          {made.databases > 0 && <li>{t('exchange.madeDatabases', { count: made.databases })}</li>}
          {made.rows > 0 && <li>{t('exchange.madeRows', { count: made.rows })}</li>}
          {made.images > 0 && <li>{t('exchange.madeImages', { count: made.images })}</li>}
          {made.files > 0 && <li>{t('exchange.madeFiles', { count: made.files })}</li>}
        </ul>
      </div>
      <h3 id="cgw-import-skipped">{t('exchange.skippedTitle')}</h3>
      {report.skipped.length ? (
        <ul aria-labelledby="cgw-import-skipped" className="cgw-import-skipped">
          {report.skipped.map((entry) => (
            <li key={entry.code} data-code={entry.code}>
              <span>
                {t('exchange.skipCount', {
                  text: t(`exchange.skip.${entry.code}`),
                  count: entry.count,
                })}
              </span>
              {entry.examples.length > 0 && (
                <span className="cgw-import-examples">
                  <span className="cgw-visually-hidden">{t('exchange.examples')}</span>
                  {entry.examples.map((example) => (
                    <bdi key={example} className="cgw-import-example">
                      {example}
                    </bdi>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('exchange.nothingSkipped')}</p>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('exchange.close')}
        </button>
        <button type="button" className="cgw-button" onClick={onAgain}>
          {t('exchange.importAgain')}
        </button>
        <button type="button" className="cgw-button is-primary" autoFocus onClick={onOpen}>
          {t('exchange.openImported')}
        </button>
      </div>
    </div>
  );
}
