// One connector's data in a block: its schema (only the fields this person may see), the view's
// settings for an editor, and the query's records with paging by cursor, the time they were
// loaded, and "Refresh". Phase 7: when the ERP gives this person `edit` on the connector, "Edit
// data" opens its editable fields' cells; changes wait in the block's draft (memory only) for
// "Review changes" and "Commit".
import { CgButton } from '@cashgear/ui';
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  ConnectorSchema,
  ConnectorSummary,
  ErpError,
  Language,
  QueryResponse,
} from '../contract';
import { ErpDrafts, type DraftCommitApi, type ErpDraft } from '../drafts';
import { useErpT } from '../i18n';
import { AiPreparePanel, ConflictPanel, EditBar, ReviewPanel, reviewing } from './editing';
import { useConnectors } from './ErpView';
import type { ErpLinkInfo, ErpViewHost } from './host';
import { errorText, Message, useWait } from './Message';
import { FieldsPanel, FilterPanel, SortPanel } from './panels';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, planQuery, readSettings, type QueryPlan } from './settings';
import { RecordsTable } from './RecordsTable';

type Panel = 'fields' | 'filter' | 'sort' | null;

export function ConnectorView({
  host,
  link,
  connectorId,
  language,
}: {
  host: ErpViewHost;
  link: ErpLinkInfo;
  connectorId: string;
  language: Language;
}) {
  const { t } = useErpT();
  const { sessions, attrs } = host;
  const [schemaTick, setSchemaTick] = useState(0);
  const [schema, setSchema] = useState<
    | { status: 'loading' }
    | { status: 'ready'; value: ConnectorSchema }
    | { status: 'error'; error: ErpError }
  >({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setSchema({ status: 'loading' });
    sessions.schema(link.id, connectorId, { signal: controller.signal }).then(
      (value) => !controller.signal.aborted && setSchema({ status: 'ready', value }),
      (error: ErpError) =>
        !controller.signal.aborted &&
        error.code !== 'aborted' &&
        setSchema({ status: 'error', error }),
    );
    return () => controller.abort();
  }, [sessions, link.id, connectorId, schemaTick]);
  const connectors = useConnectors(host, link.id);
  const summary =
    connectors.status === 'ready' ? connectors.value.find((c) => c.id === connectorId) : undefined;
  const name = summary ? summary.label[language] || summary.label.en : connectorId;

  // The settings change with these four attributes only.
  const { fields, filter, sort, pageSize } = attrs;
  const settings = useMemo(
    () => readSettings({ linkId: null, connectorId: null, fields, filter, sort, pageSize }),
    [fields, filter, sort, pageSize],
  );
  const wait = useWait(schema.status === 'error' ? schema.error : null);

  if (schema.status === 'loading') return <Message text={t('loading')} busy />;
  if (schema.status === 'error')
    return (
      <Message
        text={errorText(t, schema.error, {
          context: 'read',
          company: link.companyName,
          waitSeconds: wait,
        })}
        error={schema.error}
        testId="erp-schema-error"
      >
        <CgButton
          appearance="outline"
          disabled={wait > 0}
          onClick={() => setSchemaTick((n) => n + 1)}
        >
          {t('retry')}
        </CgButton>
        {host.editable && connectors.status === 'ready' && connectors.value.length > 0 && (
          <ChangeData
            connectors={connectors.value}
            current={connectorId}
            language={language}
            onChange={(id) => host.setAttrs(resetFor(id))}
          />
        )}
      </Message>
    );
  return (
    <Loaded
      host={host}
      link={link}
      connectorId={connectorId}
      schema={schema.value}
      connectors={connectors.status === 'ready' ? connectors.value : []}
      name={name}
      language={language}
      plan={planQuery(schema.value, settings)}
      settings={settings}
    />
  );
}

const resetFor = (connectorId: string) => ({
  connectorId,
  fields: null,
  filter: null,
  sort: null,
  pageSize: null,
});

function ChangeData({
  connectors,
  current,
  language,
  onChange,
  locked = false,
}: {
  connectors: readonly ConnectorSummary[];
  current: string;
  language: Language;
  onChange: (connectorId: string) => void;
  /** Changes wait to be committed: the data cannot change under them. */
  locked?: boolean;
}) {
  const { t } = useErpT();
  const id = useId();
  const hint = useId();
  return (
    <span className="cgw-erp-field">
      <label htmlFor={id}>{t('dataLabel')}</label>
      <select
        id={id}
        className="cgw-erp-select"
        value={current}
        disabled={locked}
        aria-describedby={locked ? hint : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {!connectors.some((c) => c.id === current) && <option value={current}>{current}</option>}
        {connectors.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label[language] || c.label.en}
          </option>
        ))}
      </select>
      {locked && (
        <span id={hint} className="cgw-erp-muted">
          {t('editLocked')}
        </span>
      )}
    </span>
  );
}

/** The block's draft when this person may change this connector's data here; else null. */
function useDraft(
  host: ErpViewHost,
  link: ErpLinkInfo,
  connectorId: string,
  schema: ConnectorSchema,
  summary: ConnectorSummary | undefined,
): { draft: ErpDraft | null; stale: ErpDraft | null } {
  const { drafts, place, audit } = host;
  const blockId = place?.blockId ?? null;
  const pageId = place?.pageId ?? null;
  const editable =
    summary?.access === 'edit' &&
    schema.maxCommitRecords > 0 &&
    schema.fields.some((f) => f.editable);
  return useMemo(() => {
    if (!drafts || !pageId || !blockId) return { draft: null, stale: null };
    const key = ErpDrafts.key(pageId, blockId);
    const held = drafts.peek(key);
    const other =
      held && (held.place.connectorId !== connectorId || held.place.linkId !== link.id)
        ? held
        : null;
    if (other?.pending()) return { draft: null, stale: other };
    if (!editable) return { draft: held && !other && held.pending() ? held : null, stale: null };
    const draft = drafts.get(
      key,
      {
        linkId: link.id,
        connectorId,
        source: { workspaceId: link.workspaceId, pageId, blockId },
      },
      audit ? (entry) => audit(entry) : undefined,
    );
    return { draft, stale: null };
    // The audit is read when the draft is made: the host is made again every render.
  }, [drafts, pageId, blockId, link.id, link.workspaceId, connectorId, editable]);
}

/** Re-renders with every change of the draft. */
function useDraftRev(draft: ErpDraft | null): number {
  return useSyncExternalStore(
    draft ? draft.subscribe : noopSubscribe,
    draft ? draft.rev : zero,
    draft ? draft.rev : zero,
  );
}
const noopSubscribe = () => () => undefined;
const zero = () => 0;

function Loaded({
  host,
  link,
  connectorId,
  schema,
  connectors,
  name,
  language,
  plan,
  settings,
}: {
  host: ErpViewHost;
  link: ErpLinkInfo;
  connectorId: string;
  schema: ConnectorSchema;
  connectors: readonly ConnectorSummary[];
  name: string;
  language: Language;
  plan: QueryPlan;
  settings: ReturnType<typeof readSettings>;
}) {
  const { t, locale } = useErpT();
  const { sessions } = host;
  const [panel, setPanel] = useState<Panel>(null);
  const [refresh, setRefresh] = useState(0);
  const panelId = useId();
  const pageSizeId = useId();
  const info = sessions.session(link.id);

  // Phase 7: changing the data, when the ERP lets this person.
  const summary = connectors.find((c) => c.id === connectorId);
  const { draft, stale } = useDraft(host, link, connectorId, schema, summary);
  useDraftRev(draft);
  useDraftRev(stale);
  const phase = draft?.phase() ?? null;
  const [editMode, setEditMode] = useState(() => !!draft?.hasChanges());
  const [aiOpen, setAiOpen] = useState(false);
  const api = useMemo<DraftCommitApi>(
    () => ({
      commit: (request, options) => sessions.commit(link.id, connectorId, request, options),
      commitStatus: (commitId, options) =>
        sessions.commitStatus(link.id, connectorId, commitId, options),
    }),
    [sessions, link.id, connectorId],
  );
  // A commit written: the page is read again, so what shows is the ERP's.
  const committedId = phase?.kind === 'committed' ? phase.response.commitId : null;
  useEffect(() => {
    if (committedId) setRefresh((n) => n + 1);
  }, [committedId]);
  // A commit whose session ended before it answered: asked about once connected again.
  const waiting = phase?.kind === 'unknown' && phase.reconnect;
  useEffect(() => {
    if (waiting && draft) void draft.resume(api, schema);
  }, [waiting, draft, api, schema]);
  const pending = !!draft?.pending();

  // The query, by its key; a cursor belongs to the query that gave it.
  const requestKey = plan.kind === 'query' ? JSON.stringify(plan.request) : '';
  const [paging, setPaging] = useState<{ key: string; cursors: (string | null)[] }>({
    key: requestKey,
    cursors: [null],
  });
  const cursors = paging.key === requestKey ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  const [result, setResult] = useState<{
    key: string;
    response: QueryResponse | null;
    error: ErpError | null;
    loadedAt: Date | null;
    loading: boolean;
  }>({ key: '', response: null, error: null, loadedAt: null, loading: true });

  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    const request = { ...(JSON.parse(requestKey) as object), cursor } as Parameters<
      typeof sessions.query
    >[2];
    setResult((r) => ({ ...r, loading: true, error: null }));
    sessions.query(link.id, connectorId, request, { schema, signal: controller.signal }).then(
      (response) => {
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, response, error: null, loadedAt: new Date(), loading: false });
      },
      (error: ErpError) => {
        if (controller.signal.aborted || error.code === 'aborted') return;
        setResult({ key: requestKey, response: null, error, loadedAt: null, loading: false });
      },
    );
    return () => controller.abort();
  }, [sessions, link.id, connectorId, schema, requestKey, cursor, refresh]);
  const wait = useWait(result.error);

  const editable = host.editable;
  const maxPageSize = schema.maxPageSize;
  const pageSize = settings.pageSize ?? DEFAULT_PAGE_SIZE;
  const sizes = [
    ...new Set([...PAGE_SIZES.filter((n) => n <= maxPageSize), Math.min(pageSize, maxPageSize)]),
  ].sort((a, b) => a - b);
  const fieldCount = plan.kind === 'query' ? plan.columns.length : 0;
  const filterCount = (settings.search.trim() ? 1 : 0) + Object.keys(settings.equals).length;
  const sortCount = settings.sort.length;
  const toggle = (which: Exclude<Panel, null>) =>
    setPanel((open) => (open === which ? null : which));
  const disclosure = (which: Exclude<Panel, null>, label: string) => (
    <CgButton
      appearance={panel === which ? 'soft' : 'ghost'}
      intent={panel === which ? 'primary' : undefined}
      size="small"
      aria-expanded={panel === which}
      aria-controls={panel === which ? panelId : undefined}
      onClick={() => toggle(which)}
    >
      {label}
    </CgButton>
  );

  const loadedAt =
    result.loadedAt && result.key === requestKey
      ? new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(result.loadedAt)
      : null;
  const response = result.key === requestKey ? result.response : null;
  const pageIndex = cursors.length - 1;

  return (
    <div className="cgw-erp-loaded" aria-busy={result.loading || undefined}>
      <div className="cgw-erp-head">
        <span className="cgw-erp-title" dir="auto" data-testid="erp-title">
          {name}
        </span>
        {info && (
          <span className="cgw-erp-muted cgw-erp-who" dir="auto">
            {t('connectedAs', { company: info.companyName, user: info.user.displayName })}
          </span>
        )}
        <span className="cgw-erp-head-end">
          {loadedAt && (
            <span className="cgw-erp-muted" data-testid="erp-loaded-at">
              {t('loadedAt', { time: loadedAt })}
            </span>
          )}
          <CgButton
            appearance="ghost"
            size="small"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={!requestKey}
          >
            {t('refresh')}
          </CgButton>
          {draft && (
            <CgButton
              appearance={editMode ? 'soft' : 'outline'}
              intent={editMode ? 'primary' : undefined}
              size="small"
              aria-pressed={editMode}
              onClick={() => setEditMode((on) => !on)}
            >
              {t('editData')}
            </CgButton>
          )}
        </span>
      </div>
      {stale && (
        <Message text={t('staleDraft')} testId="erp-stale-draft">
          <CgButton appearance="outline" onClick={() => void stale.discard()}>
            {t('discardThem')}
          </CgButton>
        </Message>
      )}
      {editable && (
        <div className="cgw-erp-toolbar" role="group" aria-label={t('settings')}>
          {connectors.length > 0 && (
            <ChangeData
              connectors={connectors}
              current={connectorId}
              language={language}
              locked={pending}
              onChange={(id) => id !== connectorId && host.setAttrs(resetFor(id))}
            />
          )}
          {disclosure('fields', t('fieldsCount', { count: fieldCount }))}
          {disclosure(
            'filter',
            filterCount ? t('filterCount', { count: filterCount }) : t('filter'),
          )}
          {disclosure('sort', sortCount ? t('sortCount', { count: sortCount }) : t('sort'))}
          <span className="cgw-erp-field">
            <label htmlFor={pageSizeId}>{t('pageSize')}</label>
            <select
              id={pageSizeId}
              className="cgw-erp-select"
              value={Math.min(pageSize, maxPageSize)}
              onChange={(event) => {
                const n = Number(event.target.value);
                host.setAttrs({ pageSize: n === DEFAULT_PAGE_SIZE ? null : n });
              }}
            >
              {sizes.map((n) => (
                <option key={n} value={n}>
                  {new Intl.NumberFormat(locale).format(n)}
                </option>
              ))}
            </select>
          </span>
        </div>
      )}
      {editable && panel && (
        <div id={panelId} className="cgw-erp-panel">
          {panel === 'fields' && (
            <FieldsPanel host={host} schema={schema} settings={settings} language={language} />
          )}
          {panel === 'filter' && (
            <FilterPanel host={host} schema={schema} settings={settings} language={language} />
          )}
          {panel === 'sort' && (
            <SortPanel host={host} schema={schema} settings={settings} language={language} />
          )}
          <CgButton appearance="ghost" size="small" onClick={() => setPanel(null)}>
            {t('close')}
          </CgButton>
        </div>
      )}
      {draft && (editMode || pending || phase?.kind === 'committed') && (
        <EditBar
          draft={draft}
          schema={schema}
          api={api}
          aiOpen={aiOpen}
          {...(host.ai ? { onAi: () => setAiOpen((open) => !open) } : {})}
        />
      )}
      {draft && host.ai && aiOpen && (
        <AiPreparePanel
          ai={host.ai}
          draft={draft}
          schema={schema}
          records={response?.records ?? []}
          language={language}
          onClose={() => setAiOpen(false)}
          onPrepared={() => setEditMode(true)}
        />
      )}
      {draft && phase && reviewing(phase) ? (
        <ReviewPanel draft={draft} schema={schema} api={api} language={language} />
      ) : draft && phase?.kind === 'conflict' ? (
        <ConflictPanel
          key={phase.request.commitId}
          draft={draft}
          schema={schema}
          language={language}
        />
      ) : plan.kind === 'noField' ? (
        <Message text={t('noFieldVisible')} testId="erp-no-field" />
      ) : plan.kind === 'filterDenied' ? (
        <Message text={t('filterDenied')} testId="erp-filter-denied" />
      ) : plan.kind === 'filterNotFilterable' ? (
        <Message text={t('filterNotFilterable')} testId="erp-filter-not-filterable" />
      ) : (
        <>
          {plan.hidden > 0 && (
            <p className="cgw-erp-note" data-testid="erp-hidden">
              {t('fieldsHidden', { count: plan.hidden })}
            </p>
          )}
          {result.error && result.key === requestKey ? (
            <Message
              text={errorText(t, result.error, {
                context: 'read',
                company: link.companyName,
                waitSeconds: wait,
              })}
              error={result.error}
              testId="erp-query-error"
            >
              <CgButton
                appearance="outline"
                disabled={wait > 0}
                onClick={() => setRefresh((n) => n + 1)}
              >
                {t('retry')}
              </CgButton>
            </Message>
          ) : !response ? (
            <Message text={t('loading')} busy />
          ) : (
            <RecordsTable
              name={name}
              schema={schema}
              columns={plan.columns}
              sort={plan.request.sort ?? []}
              response={response}
              language={language}
              from={pageIndex * plan.request.pageSize + 1}
              canBack={pageIndex > 0}
              onBack={() => setPaging({ key: requestKey, cursors: cursors.slice(0, -1) })}
              onNext={() =>
                response.nextCursor &&
                setPaging({ key: requestKey, cursors: [...cursors, response.nextCursor] })
              }
              {...(draft ? { edit: { draft, active: editMode && !draft.locked() } } : {})}
            />
          )}
        </>
      )}
    </div>
  );
}
