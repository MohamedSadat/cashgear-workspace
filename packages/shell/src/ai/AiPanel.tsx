// The AI panel beside the page (INTEGRATIONS.md, AI, Proposals): choose what AI should do, watch
// the answer arrive, then Accept it as an ordinary edit, Discard it, or try again. Nothing enters
// the page while the answer streams; Stop ends it. The server decides every request again: this
// only shows what may be asked here.
import { fragmentToJSON, plainText, type PageDocument } from '@cgw/doc';
import type { BlockEditor } from '@cgw/editor';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShellDatabaseHost } from '../database/host';
import { routeHash, navigate } from '../route';
import { isRowRecord, type AnyPage, type WorkspaceSession } from '../session';
import { useSection } from '../i18n/sections';
import { formatShortcut } from '../shortcuts';
import { acceptProposal, splitTitle, type AcceptOutcome } from './accept';
import { parseActionItems, parseDatabaseProposal, type DatabaseProposal } from './answers';
import type { AiHandle } from './context';
import type { AiPanelRequest } from './open';
import { buildRequest, type AiSelection, type AiTask, type AiTaskAction } from './requests';
import { aiPlanWords } from './planWords';
import { runCompletion, type AiRun } from './run';
import { AiError, REWRITE_INSTRUCTIONS, type RewriteInstruction } from './types';
import './ai.css';

const ACTIONS: readonly AiTaskAction[] = [
  'rewrite',
  'summarise',
  'actionItems',
  'generatePage',
  'generateDatabase',
  'ask',
];

/** The catalogue's key for a failure's text. */
export function errorKey(code: string): string {
  switch (code) {
    case 'ai.disabled':
      return 'ai.disabled';
    case 'ai.keyInvalid':
      return 'ai.keyInvalid';
    case 'ai.refused':
      return 'ai.refused';
    case 'ai.provider':
      return 'ai.provider';
    case 'ai.limit':
      return 'ai.limit';
    // Phase 13: past the workspace's allowance on Cash Gear's subscription (a section's words).
    case 'ai.allowance':
      return 'aiPlan.allowance';
    case 'limit.rate':
      return 'ai.rate';
    case 'too.long':
    case 'limit.size':
      return 'ai.tooLong';
    case 'request.empty':
      return 'ai.empty';
    case 'access.denied':
    case 'not.found':
    case 'page.gone':
      return 'ai.access';
    case 'response.invalid':
    case 'answer.invalid':
      return 'ai.invalid';
    case 'network':
      return 'ai.network';
    case 'aborted':
      return 'ai.aborted';
    default:
      return 'ai.generic';
  }
}

export interface AiPanelProps {
  ai: AiHandle;
  session: WorkspaceSession;
  page: AnyPage;
  editor: BlockEditor | null;
  doc: PageDocument;
  /** Whether the page may be changed here (Accept edits it only then). */
  editable: boolean;
  databases: ShellDatabaseHost | null;
  /** Names of the people mentioned in the page, as the reader may see them. */
  personName?: (userId: string) => string | undefined;
  request: AiPanelRequest | null;
  onClose: () => void;
}

/** What the panel has asked, with the run of it. */
interface Asked {
  task: AiTask;
  run: AiRun;
}

export function AiPanel({
  ai,
  session,
  page,
  editor,
  doc,
  editable,
  databases,
  personName,
  request,
  onClose,
}: AiPanelProps) {
  useSection(aiPlanWords);
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const language: 'en' | 'ar' = i18n.language === 'ar' ? 'ar' : 'en';
  const row = isRowRecord(page);
  const [action, setAction] = useState<AiTaskAction>(request?.action ?? 'summarise');
  const [selection, setSelection] = useState<AiSelection | null>(request?.selection ?? null);
  const [instruction, setInstruction] = useState<RewriteInstruction>('improve');
  const [target, setTarget] = useState<'en' | 'ar'>(language === 'ar' ? 'en' : 'ar');
  const [prompt, setPrompt] = useState('');
  const [question, setQuestion] = useState(request?.question ?? '');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // A new request (the toolbar's "Ask AI", the page menu, the palette) sets the panel to it.
  useEffect(() => {
    if (!request) return;
    setAction(request.action);
    setSelection(request.selection ?? null);
    if (request.question !== undefined) setQuestion(request.question);
    setNotice(null);
    setProblem(null);
    heading.current?.focus();
    if (request.action === 'ask' && request.question?.trim())
      start({ action: 'ask', question: request.question });
    // Only a new request starts this.
  }, [request?.n]);

  // Closing the panel or leaving the page stops what runs.
  useEffect(() => () => controller.current?.abort(), []);

  const pageText = () => {
    const body = plainText(fragmentToJSON(doc.fragment), { userName: personName });
    return page.title ? `${page.title}\n\n${body}` : body;
  };

  const taskNow = (): AiTask | null => {
    switch (action) {
      case 'rewrite':
        return selection
          ? {
              action,
              selection,
              instruction,
              ...(instruction === 'translate' ? { target } : {}),
              ...(instruction === 'custom' ? { prompt } : {}),
            }
          : null;
      case 'generatePage':
      case 'generateDatabase':
        return { action, prompt };
      case 'ask':
        return { action, question };
      default:
        return { action };
    }
  };

  function start(task: AiTask) {
    controller.current?.abort();
    setNotice(null);
    setProblem(null);
    let built;
    try {
      built = buildRequest(task, {
        workspaceId: page.workspaceId,
        pageId: page.id,
        language,
        pageText,
      });
    } catch (error) {
      setProblem(
        t(errorKey(error instanceof AiError ? error.code : 'server.error') as 'ai.generic'),
      );
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    void runCompletion(
      ai.store.api,
      built,
      (run) => {
        if (controller.current === abort) setAsked({ task, run });
      },
      abort.signal,
    ).then((run) => {
      if (run.status === 'failed' && run.code === 'ai.disabled')
        ai.store.refusedAsOff(ai.workspaceId);
    });
  }

  const stop = () => controller.current?.abort();

  const accept = async () => {
    if (!asked || asked.run.status !== 'done') return;
    let outcome: AcceptOutcome;
    try {
      outcome = await acceptProposal(
        asked.task,
        asked.run,
        {
          session,
          page,
          editor: editor?.editor ?? null,
          editable,
          databases,
          tableName: t('database.viewType.table'),
          selection,
        },
        { sources: t('ai.sources') },
      );
    } catch (error) {
      setProblem(
        t(errorKey(error instanceof AiError ? error.code : 'server.error') as 'ai.generic'),
      );
      return;
    }
    const undo = formatShortcut('Mod+KeyZ');
    switch (outcome.kind) {
      case 'refused':
        setProblem(t('ai.readOnly'));
        return;
      case 'replaced':
        setNotice(t('ai.replaced', { shortcut: undo }));
        break;
      case 'inserted':
        setNotice(t('ai.inserted', { shortcut: undo }));
        break;
      case 'insertedBelow':
        setNotice(t('ai.insertedBelow'));
        break;
      case 'databaseCreated':
        setNotice(t('ai.databaseCreated'));
        break;
      case 'pageCreated':
        setNotice(t('ai.pageCreated'));
        navigate({ kind: 'page', pageId: outcome.pageId });
        break;
    }
    setAsked(null);
    if (asked.task.action === 'rewrite') setSelection(null);
  };

  const discard = () => {
    controller.current?.abort();
    setAsked(null);
    setNotice(null);
  };

  const copy = () => {
    if (asked?.run.status !== 'done') return;
    void navigator.clipboard?.writeText(asked.run.text).then(
      () => setNotice(t('ai.copied')),
      () => undefined,
    );
  };

  const running = asked?.run.status === 'running';
  const task = taskNow();
  const ready = !!task && !running;
  const offered = ai.availability === 'ready';

  return (
    <aside className="cgw-ai" aria-labelledby={titleId} data-testid="ai-panel">
      <div className="cgw-ai-header">
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          {t('ai.title')}
        </h2>
        <button
          type="button"
          className="cgw-icon-button"
          aria-label={t('ai.close')}
          title={t('ai.close')}
          onClick={() => {
            stop();
            onClose();
          }}
        >
          ×
        </button>
      </div>
      <div className="cgw-ai-body">
        {!offered ? (
          <p className="cgw-ai-message" role="status" data-testid="ai-unavailable">
            {t(`ai.${ai.availability}` as 'ai.off')}
          </p>
        ) : (
          <>
            <p className="cgw-muted cgw-ai-intro">{t('ai.intro')}</p>
            <fieldset className="cgw-ai-actions" disabled={running}>
              <legend>{t('ai.actionsLabel')}</legend>
              {ACTIONS.filter((a) => !(row && a === 'generateDatabase')).map((name) => (
                <label key={name} className="cgw-ai-action">
                  <input
                    type="radio"
                    name={`${titleId}-action`}
                    value={name}
                    checked={action === name}
                    onChange={() => {
                      setAction(name);
                      setProblem(null);
                    }}
                  />
                  <span>{t(`ai.${name}`)}</span>
                </label>
              ))}
            </fieldset>
            <TaskInputs
              action={action}
              selection={selection}
              instruction={instruction}
              onInstruction={setInstruction}
              target={target}
              onTarget={setTarget}
              prompt={prompt}
              onPrompt={setPrompt}
              question={question}
              onQuestion={setQuestion}
              disabled={running}
              onSubmit={() => task && !running && start(task)}
            />
            <div className="cgw-ai-buttons">
              {running ? (
                <button type="button" className="cgw-button" onClick={stop}>
                  {t('ai.stop')}
                </button>
              ) : (
                <button
                  type="button"
                  className="cgw-button is-primary"
                  disabled={!ready}
                  onClick={() => task && start(task)}
                >
                  {t('ai.run')}
                </button>
              )}
            </div>
          </>
        )}
        {problem && (
          <p className="cgw-ai-problem" role="alert">
            {problem}
          </p>
        )}
        {asked && (
          <AnswerView
            asked={asked}
            editable={editable}
            onAccept={() => void accept()}
            onDiscard={discard}
            onRetry={() => start(asked.task)}
            onCopy={copy}
          />
        )}
        {notice && (
          <p className="cgw-ai-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </aside>
  );
}

function TaskInputs({
  action,
  selection,
  instruction,
  onInstruction,
  target,
  onTarget,
  prompt,
  onPrompt,
  question,
  onQuestion,
  disabled,
  onSubmit,
}: {
  action: AiTaskAction;
  selection: AiSelection | null;
  instruction: RewriteInstruction;
  onInstruction: (value: RewriteInstruction) => void;
  target: 'en' | 'ar';
  onTarget: (value: 'en' | 'ar') => void;
  prompt: string;
  onPrompt: (value: string) => void;
  question: string;
  onQuestion: (value: string) => void;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  // Ctrl+Enter asks, as the comment composer sends.
  const submitOnCtrlEnter = (event: KeyboardEvent) => {
    if (
      event.code === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSubmit();
    }
  };
  if (action === 'rewrite')
    return (
      <div className="cgw-ai-inputs">
        {selection ? (
          <>
            <div className="cgw-ai-label">{t('ai.selectionLabel')}</div>
            <blockquote className="cgw-ai-quote" dir="auto" data-testid="ai-selection">
              {selection.text.length > 600 ? `${selection.text.slice(0, 600)}…` : selection.text}
            </blockquote>
            <label className="cgw-ai-field">
              <span>{t('ai.instruction')}</span>
              <select
                className="cgw-input"
                value={instruction}
                disabled={disabled}
                onChange={(event) => onInstruction(event.target.value as RewriteInstruction)}
              >
                {REWRITE_INSTRUCTIONS.map((name) => (
                  <option key={name} value={name}>
                    {t(`ai.${name}`)}
                  </option>
                ))}
              </select>
            </label>
            {instruction === 'translate' && (
              <label className="cgw-ai-field">
                <span>{t('ai.translateTo')}</span>
                <select
                  className="cgw-input"
                  value={target}
                  disabled={disabled}
                  onChange={(event) => onTarget(event.target.value as 'en' | 'ar')}
                >
                  <option value="en">{t('ai.languageEn')}</option>
                  <option value="ar">{t('ai.languageAr')}</option>
                </select>
              </label>
            )}
            {instruction === 'custom' && (
              <label className="cgw-ai-field">
                <span>{t('ai.customPrompt')}</span>
                <textarea
                  className="cgw-input"
                  dir="auto"
                  rows={3}
                  value={prompt}
                  disabled={disabled}
                  onChange={(event) => onPrompt(event.target.value)}
                  onKeyDown={submitOnCtrlEnter}
                />
              </label>
            )}
          </>
        ) : (
          <p className="cgw-muted">{t('ai.noSelection')}</p>
        )}
      </div>
    );
  if (action === 'generatePage' || action === 'generateDatabase')
    return (
      <div className="cgw-ai-inputs">
        <label className="cgw-ai-field" htmlFor={`${id}-prompt`}>
          <span>{t(action === 'generatePage' ? 'ai.promptPage' : 'ai.promptDatabase')}</span>
        </label>
        <textarea
          id={`${id}-prompt`}
          className="cgw-input"
          dir="auto"
          rows={4}
          value={prompt}
          disabled={disabled}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={submitOnCtrlEnter}
        />
      </div>
    );
  if (action === 'ask')
    return (
      <div className="cgw-ai-inputs">
        <label className="cgw-ai-field" htmlFor={`${id}-question`}>
          <span>{t('ai.question')}</span>
        </label>
        <input
          id={`${id}-question`}
          className="cgw-input"
          dir="auto"
          value={question}
          disabled={disabled}
          onChange={(event) => onQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.code === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    );
  return null;
}

/** The answer as it arrives, then the proposal with what Accept does. */
function AnswerView({
  asked,
  editable,
  onAccept,
  onDiscard,
  onRetry,
  onCopy,
}: {
  asked: Asked;
  editable: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  const { run, task } = asked;
  const preview = useMemo(
    () => (run.status === 'done' ? previewOf(task, run.text) : null),
    [run, task],
  );
  if (run.status === 'running')
    return (
      <section className="cgw-ai-answer" aria-busy="true" data-testid="ai-answer">
        <div className="cgw-ai-label" role="status">
          {t('ai.writing')}
        </div>
        <div className="cgw-ai-text" dir="auto">
          {run.text}
        </div>
      </section>
    );
  if (run.status === 'failed')
    return (
      <section className="cgw-ai-answer" data-testid="ai-answer">
        <p className="cgw-ai-problem" role="alert" data-code={run.code}>
          {run.code === 'limit.rate' && run.retryAfterSeconds
            ? t('ai.rate', { seconds: run.retryAfterSeconds })
            : run.code === 'limit.rate'
              ? t('ai.rateNoWait')
              : t(errorKey(run.code) as 'ai.generic')}
        </p>
        <div className="cgw-ai-buttons">
          <button type="button" className="cgw-button" onClick={onRetry}>
            {t('ai.tryAgain')}
          </button>
          <button type="button" className="cgw-button" onClick={onDiscard}>
            {t('ai.discard')}
          </button>
        </div>
      </section>
    );
  // Writing into the page needs edit rights here; a new page goes to its section otherwise.
  const writes = task.action !== 'generatePage';
  return (
    <section className="cgw-ai-answer" aria-label={t('ai.proposal')} data-testid="ai-answer">
      <h3 className="cgw-ai-label">{t('ai.proposal')}</h3>
      {preview?.kind === 'invalid' ? (
        <p className="cgw-ai-problem" role="alert">
          {t('ai.invalid')}
        </p>
      ) : preview?.kind === 'items' ? (
        <>
          <div className="cgw-muted">{t('ai.items', { count: preview.items.length })}</div>
          <ul className="cgw-ai-items" data-testid="ai-items">
            {preview.items.map((item, index) => (
              <li key={index} dir="auto">
                <span aria-hidden="true">☐ </span>
                {item}
              </li>
            ))}
          </ul>
        </>
      ) : preview?.kind === 'database' ? (
        <DatabasePreview proposal={preview.proposal} />
      ) : preview?.kind === 'page' ? (
        <>
          <div className="cgw-ai-page-title" dir="auto">
            {preview.title}
          </div>
          <div className="cgw-ai-text" dir="auto">
            {preview.body}
          </div>
        </>
      ) : (
        <div className="cgw-ai-text" dir="auto" data-testid="ai-text">
          {run.text}
        </div>
      )}
      {task.action === 'ask' && (
        <div className="cgw-ai-sources">
          <div className="cgw-ai-label">{t('ai.sources')}</div>
          {run.sources.length ? (
            <ol>
              {run.sources.map((source) => (
                <li key={source.pageId}>
                  <a href={routeHash({ kind: 'page', pageId: source.pageId })} dir="auto">
                    {source.title || t('page.untitled')}
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <p className="cgw-muted">{t('ai.noSources')}</p>
          )}
        </div>
      )}
      {run.stopReason === 'length' && <p className="cgw-muted">{t('ai.truncated')}</p>}
      {writes && !editable && <p className="cgw-muted">{t('ai.readOnly')}</p>}
      <div className="cgw-ai-buttons">
        {preview?.kind !== 'invalid' && (!writes || editable) && (
          <button type="button" className="cgw-button is-primary" onClick={onAccept}>
            {t(acceptLabel(task))}
          </button>
        )}
        <button type="button" className="cgw-button" onClick={onCopy}>
          {t('ai.copy')}
        </button>
        <button type="button" className="cgw-button" onClick={onRetry}>
          {t('ai.tryAgain')}
        </button>
        <button type="button" className="cgw-button" onClick={onDiscard}>
          {t('ai.discard')}
        </button>
      </div>
    </section>
  );
}

function acceptLabel(task: AiTask): 'ai.replace' {
  const key = {
    rewrite: 'ai.replace',
    summarise: 'ai.insertTop',
    actionItems: 'ai.insertTodos',
    generatePage: 'ai.createPage',
    generateDatabase: 'ai.createDatabase',
    ask: 'ai.insertAnswer',
  }[task.action];
  return key as 'ai.replace';
}

type Preview =
  | { kind: 'text' }
  | { kind: 'page'; title: string; body: string }
  | { kind: 'items'; items: string[] }
  | { kind: 'database'; proposal: DatabaseProposal }
  | { kind: 'invalid' };

function previewOf(task: AiTask, text: string): Preview {
  try {
    if (task.action === 'actionItems') return { kind: 'items', items: parseActionItems(text) };
    if (task.action === 'generateDatabase')
      return { kind: 'database', proposal: parseDatabaseProposal(text) };
    if (task.action === 'generatePage') return { kind: 'page', ...splitTitle(text) };
    return text.trim() ? { kind: 'text' } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function DatabasePreview({ proposal }: { proposal: DatabaseProposal }) {
  const { t } = useTranslation();
  const shown = proposal.rows.slice(0, 10);
  const cell = (value: unknown) =>
    value === null || value === undefined
      ? ''
      : typeof value === 'boolean'
        ? value
          ? '☑'
          : '☐'
        : Array.isArray(value)
          ? value.join(', ')
          : String(value);
  return (
    <div className="cgw-ai-database" data-testid="ai-database">
      <div className="cgw-ai-page-title" dir="auto">
        {proposal.name}
      </div>
      <div className="cgw-muted">{t('ai.rows', { count: proposal.rows.length })}</div>
      <div className="cgw-ai-table-wrap">
        <table className="cgw-ai-table">
          <thead>
            <tr>
              {proposal.properties.map((property, index) => (
                <th key={property.name} scope="col" dir="auto">
                  {property.name}
                  <span className="cgw-muted">
                    {' '}
                    (
                    {t(
                      `database.type.${index === 0 ? 'title' : property.type}` as 'database.type.text',
                    )}
                    )
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {proposal.properties.map((property) => (
                  <td key={property.name} dir="auto">
                    {cell(row[property.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
