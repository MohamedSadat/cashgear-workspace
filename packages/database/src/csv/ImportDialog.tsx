// The CSV import dialog: pick a file (or drop it), say whether its first row is a header, then
// either map its columns onto this database's properties (matched by name at first) or make a new
// database from it (its properties worked out by `inferProperties`, each type changeable), check
// the first rows as they will be read, and import. Up to `LOCAL_ROW_LIMIT` rows are written on the
// device, by operations in batches; a larger file in a synced workspace goes to the server's
// import route (`host.importCsv`); at most 50,000 rows and 20 MB either way.
import { CgButton, CgPopup } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { parseCsv } from '@cgw/workspace';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  LOCAL_ROW_LIMIT,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
} from '../core';
import { safeKeyBetween } from '../actions';
import { useHost } from '../context';
import type { DatabaseHost } from '../host';
import { useDbT, type DbT } from '../i18n';
import { shapeForType } from '../properties/defs';
import type { DatabasePlace } from '../templates/databaseTemplates';
import {
  IMPORT_TYPES,
  csvTable,
  defaultMapping,
  importOps,
  importTargets,
  inferredProperties,
  newDatabaseOps,
  planImportValues,
  titleFromFile,
  type CsvTable,
  type ImportProblem,
} from './importPlan';
import './csv.css';

/** Operations per `host.apply` while importing on the device. */
const BATCH = 400;
const PREVIEW = 5;
const CSV_MAX_ROWS = 50_000;
const CSV_MAX_BYTES = 20 * 1024 * 1024;

export interface ImportDialogProps {
  host: DatabaseHost;
  /** The database to import into (null: only a new database can be made). */
  databaseId: Id | null;
  /** Where a new database goes (default: beside this database). */
  place?: DatabasePlace;
  /** Closed: with the database the rows went into, when an import was made. */
  onClose(result?: { databaseId: Id; created: number }): void;
}

type Phase =
  | { kind: 'pick'; error?: string }
  | { kind: 'ready' }
  | { kind: 'importing'; done: number; total: number }
  | {
      kind: 'done';
      databaseId: Id;
      created: number;
      problems: ImportProblem[];
      serverProblems: { line: number; message: string }[];
    }
  | { kind: 'failed'; message: string };

interface Loaded {
  name: string;
  text: string;
  parsed: string[][];
}

export function ImportDialog({ host, databaseId, place, onClose }: ImportDialogProps) {
  const { t } = useDbT();
  const database = useHost(host, () => (databaseId ? host.database(databaseId) : null));
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Loaded | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [mode, setMode] = useState<'into' | 'new'>(databaseId ? 'into' : 'new');
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [mapping, setMapping] = useState<(PropertyId | null)[]>([]);
  const [types, setTypes] = useState<PropertyType[]>([]);
  const [newId] = useState(() => host.newId());

  const columnName = (n: number) => t('csv.columnName', { n });
  const table = useMemo(
    () => (file ? csvTable(file.parsed, hasHeader, (n) => t('csv.columnName', { n })) : null),
    [file, hasHeader, t],
  );
  const inferred = useMemo(() => (table ? inferredProperties(table, newId) : []), [table, newId]);
  const newProperties = useMemo(
    () =>
      inferred.map((def, i) =>
        i === 0 || !types[i] || types[i] === def.type
          ? def
          : shapeForType(def, types[i], statusNames(t)),
      ),
    [inferred, types, t],
  );

  const read = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > CSV_MAX_BYTES) return setPhase({ kind: 'pick', error: t('csv.tooLarge') });
    try {
      const text = await picked.text();
      const parsed = parseCsv(text);
      if (parsed.length - (hasHeader ? 1 : 0) > CSV_MAX_ROWS)
        return setPhase({ kind: 'pick', error: t('csv.tooLarge') });
      if (!parsed.length) return setPhase({ kind: 'pick', error: t('csv.empty') });
      setFile({ name: picked.name, text, parsed });
      const next = csvTable(parsed, hasHeader, columnName);
      setMapping(database ? defaultMapping(database, next) : []);
      setTypes([]);
      setPhase({ kind: 'ready' });
    } catch {
      setPhase({ kind: 'pick', error: t('csv.readFailed') });
    }
  };
  const onHeaderChange = (on: boolean) => {
    setHasHeader(on);
    if (file && database)
      setMapping(defaultMapping(database, csvTable(file.parsed, on, columnName)));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void read(event.dataTransfer.files?.[0]);
  };

  // ---- Importing --------------------------------------------------------------------------------
  const rowsInFile = table?.records.length ?? 0;
  const large = rowsInFile > LOCAL_ROW_LIMIT;
  const tooManyLocal = large && !host.importCsv;

  const applyInBatches = async (ops: ReturnType<typeof importOps>, rows: number, target: Id) => {
    let done = 0;
    setPhase({ kind: 'importing', done: 0, total: rows });
    for (let i = 0; i < ops.length; i += BATCH) {
      const batch = ops.slice(i, i + BATCH);
      await host.apply(batch);
      done += batch.filter((op) => op.type === 'page.create' && op.entityId !== target).length;
      setPhase({ kind: 'importing', done: Math.min(done, rows), total: rows });
    }
  };

  const start = async () => {
    if (!table || !file || tooManyLocal) return;
    try {
      if (mode === 'into' && database) {
        if (large && host.importCsv) {
          setPhase({ kind: 'importing', done: 0, total: rowsInFile });
          const answer = await host.importCsv(database.id, {
            csv: file.text,
            columns: mapping,
            header: hasHeader,
          });
          setPhase({
            kind: 'done',
            databaseId: database.id,
            created: answer.created,
            problems: [],
            serverProblems: answer.problems,
          });
          return;
        }
        const planned = planImportValues(database, table, mapping);
        const page = host.page(database.id);
        const ops = importOps(database.id, planned, {
          workspaceId: database.workspaceId,
          sectionId: page?.sectionId ?? '',
          newId: () => host.newId(),
          endKey: host.rowOrderKey(database.id, 'end'),
        });
        await applyInBatches(ops, planned.rows.length, database.id);
        setPhase({
          kind: 'done',
          databaseId: database.id,
          created: planned.rows.length,
          problems: planned.problems,
          serverProblems: [],
        });
        return;
      }
      const where = place ?? placeBeside(host, databaseId);
      if (!where) throw new Error('place');
      const made = newDatabaseOps({
        table: large ? { ...table, records: [] } : table,
        properties: newProperties,
        databaseId: newId,
        title: titleFromFile(file.name),
        viewName: t('templates.tableView'),
        place: where,
        newId: () => host.newId(),
      });
      await applyInBatches(made.ops, made.planned.rows.length, newId);
      if (large && host.importCsv) {
        setPhase({ kind: 'importing', done: 0, total: rowsInFile });
        const answer = await host.importCsv(newId, {
          csv: file.text,
          columns: newProperties.map((p) => p.id),
          header: hasHeader,
        });
        setPhase({
          kind: 'done',
          databaseId: newId,
          created: answer.created,
          problems: [],
          serverProblems: answer.problems,
        });
        return;
      }
      setPhase({
        kind: 'done',
        databaseId: newId,
        created: made.planned.rows.length,
        problems: made.planned.problems,
        serverProblems: [],
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setPhase({
        kind: 'failed',
        message: code === 'db.tooLarge' ? t('csv.tooLarge') : t('csv.failed'),
      });
    }
  };

  const close = () => {
    if (phase.kind === 'importing') return;
    onClose(
      phase.kind === 'done' ? { databaseId: phase.databaseId, created: phase.created } : undefined,
    );
  };

  // ---- Drawing -------------------------------------------------------------------------------------
  const preview = useMemo(() => {
    if (!table) return null;
    const head = { ...table, records: table.records.slice(0, PREVIEW) };
    if (mode === 'into' && database) return planImportValues(database, head, mapping);
    const draft: DatabaseRecord = {
      id: newId,
      workspaceId: '',
      properties: newProperties,
      version: 1,
      rowCount: 0,
      createdAt: '',
    };
    return planImportValues(
      draft,
      head,
      newProperties.map((p) => p.id),
    );
  }, [table, mode, database, mapping, newProperties, newId]);
  const bad = new Set(preview?.problems.map((p) => `${p.line}:${p.column}`) ?? []);
  const targets = database ? importTargets(database) : [];

  const footer = (
    <div className="cgw-csv-actions">
      {phase.kind === 'done' || phase.kind === 'failed' ? (
        <CgButton intent="primary" onClick={close}>
          {t('done')}
        </CgButton>
      ) : (
        <>
          <CgButton appearance="ghost" onClick={close} disabled={phase.kind === 'importing'}>
            {t('cancel')}
          </CgButton>
          <CgButton
            intent="primary"
            disabled={phase.kind !== 'ready' || tooManyLocal}
            onClick={() => void start()}
          >
            {t('csv.start')}
          </CgButton>
        </>
      )}
    </div>
  );

  return (
    <CgPopup
      open
      headerText={t('csv.title')}
      closeButtonAriaLabel={t('csv.close')}
      width="min(48rem, calc(100vw - 24px))"
      className="cgw-csv-dialog"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={footer}
    >
      <div className="cgw-csv">
        <div
          className="cgw-csv-pick"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <input
            ref={input}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="cgw-views-sr"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void read(event.target.files?.[0])}
          />
          <CgButton
            appearance="outline"
            data-cg-initial-focus=""
            disabled={phase.kind === 'importing'}
            onClick={() => input.current?.click()}
          >
            {file ? t('csv.change') : t('csv.pick')}
          </CgButton>
          <span className="cgw-csv-hint">
            {file ? t('csv.file', { name: file.name, count: rowsInFile }) : t('csv.drop')}
          </span>
        </div>
        {phase.kind === 'pick' && phase.error ? (
          <p className="cgw-csv-error" role="alert">
            {phase.error}
          </p>
        ) : null}
        {table && (phase.kind === 'ready' || phase.kind === 'importing') ? (
          <>
            <label className="cgw-csv-check">
              <input
                type="checkbox"
                checked={hasHeader}
                disabled={phase.kind === 'importing'}
                onChange={(event) => onHeaderChange(event.target.checked)}
              />
              {t('csv.header')}
            </label>
            {databaseId ? (
              <fieldset className="cgw-csv-mode" disabled={phase.kind === 'importing'}>
                <legend>{t('csv.mode')}</legend>
                <label>
                  <input
                    type="radio"
                    name="cgw-csv-mode"
                    checked={mode === 'into'}
                    onChange={() => setMode('into')}
                  />
                  {t('csv.into')}
                </label>
                <label>
                  <input
                    type="radio"
                    name="cgw-csv-mode"
                    checked={mode === 'new'}
                    onChange={() => setMode('new')}
                  />
                  {t('csv.newDatabase')}
                </label>
              </fieldset>
            ) : null}
            <MappingTable
              table={table}
              mode={mode}
              t={t}
              targets={targets}
              mapping={mapping}
              properties={newProperties}
              disabled={phase.kind === 'importing'}
              bad={bad}
              preview={PREVIEW}
              onMap={(col, id) =>
                setMapping((prev) =>
                  prev.map((m, i) => (i === col ? id : m === id && id !== null ? null : m)),
                )
              }
              onType={(col, type) =>
                setTypes((prev) => {
                  const next = [...prev];
                  next[col] = type;
                  return next;
                })
              }
            />
            {large ? (
              <p
                className={tooManyLocal ? 'cgw-csv-error' : 'cgw-csv-note'}
                role={tooManyLocal ? 'alert' : undefined}
              >
                {tooManyLocal
                  ? t('csv.tooManyLocal', { count: LOCAL_ROW_LIMIT })
                  : t('csv.viaServer')}
              </p>
            ) : null}
          </>
        ) : null}
        {phase.kind === 'importing' ? (
          <p className="cgw-csv-note" role="status">
            {t('csv.importing', { done: phase.done, total: phase.total })}
            <progress max={phase.total} value={phase.done} />
          </p>
        ) : null}
        {phase.kind === 'done' ? (
          <div role="status">
            <p className="cgw-csv-note">{t('csv.done', { count: phase.created })}</p>
            {phase.problems.length || phase.serverProblems.length ? (
              <>
                <p className="cgw-csv-note">
                  {t('csv.problems', {
                    count: phase.problems.length + phase.serverProblems.length,
                  })}
                </p>
                <ul className="cgw-csv-problems">
                  {phase.problems.slice(0, 20).map((p, i) => (
                    <li key={i} dir="auto">
                      {t('csv.problem', { line: p.line, column: p.column, text: p.text })}
                    </li>
                  ))}
                  {phase.serverProblems.slice(0, 20).map((p, i) => (
                    <li key={`s${i}`} dir="auto">
                      {t('csv.serverProblem', { line: p.line, message: p.message })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
        {phase.kind === 'failed' ? (
          <p className="cgw-csv-error" role="alert">
            {phase.message}
          </p>
        ) : null}
      </div>
    </CgPopup>
  );
}

const statusNames = (t: DbT) => ({
  todo: t('option.defaultTodo'),
  inProgress: t('option.defaultInProgress'),
  complete: t('option.defaultComplete'),
});

/** Beside a database: the same section and parent, just after it. */
function placeBeside(host: DatabaseHost, databaseId: Id | null): DatabasePlace | null {
  const page = databaseId ? host.page(databaseId) : null;
  if (!page) return null;
  return {
    workspaceId: page.workspaceId,
    sectionId: page.sectionId,
    parentPageId: page.parentPageId,
    orderKey: safeKeyBetween(page.orderKey, null),
  };
}

function MappingTable({
  table,
  mode,
  t,
  targets,
  mapping,
  properties,
  disabled,
  bad,
  preview,
  onMap,
  onType,
}: {
  table: CsvTable;
  mode: 'into' | 'new';
  t: DbT;
  targets: PropertyDef[];
  mapping: (PropertyId | null)[];
  properties: PropertyDef[];
  disabled: boolean;
  bad: Set<string>;
  preview: number;
  onMap(col: number, id: PropertyId | null): void;
  onType(col: number, type: PropertyType): void;
}) {
  const records = table.records.slice(0, preview);
  return (
    <div className="cgw-csv-table-box">
      <table className="cgw-csv-table">
        <caption className="cgw-csv-caption">{t('csv.preview')}</caption>
        <thead>
          <tr>
            {table.header.map((name, col) => (
              <th key={col} scope="col">
                <span className="cgw-csv-column" dir="auto">
                  {name}
                </span>
                {mode === 'into' ? (
                  <select
                    className="cgw-select"
                    aria-label={t('csv.property')}
                    value={mapping[col] ?? ''}
                    disabled={disabled}
                    onChange={(event) => onMap(col, event.target.value || null)}
                  >
                    <option value="">{t('csv.skip')}</option>
                    {targets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : col === 0 ? (
                  <span className="cgw-csv-type">{t('type.title')}</span>
                ) : (
                  <select
                    className="cgw-select"
                    aria-label={t('csv.type')}
                    value={properties[col]?.type ?? 'text'}
                    disabled={disabled}
                    onChange={(event) => onType(col, event.target.value as PropertyType)}
                  >
                    {IMPORT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`type.${type}`)}
                      </option>
                    ))}
                  </select>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => (
            <tr key={i}>
              {table.header.map((name, col) => {
                const problem =
                  bad.has(`${table.firstLine + i}:${name}`) && !!(mode === 'new' || mapping[col]);
                const skipped = mode === 'into' && !mapping[col];
                return (
                  <td
                    key={col}
                    dir="auto"
                    data-skipped={skipped || undefined}
                    data-problem={problem || undefined}
                    title={problem ? t('csv.unreadable') : undefined}
                  >
                    {record[col] ?? ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
