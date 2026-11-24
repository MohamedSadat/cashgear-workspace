// A run log (Phase 15): a rule's runs, or a row's (its properties' "Runs"), newest first, each
// with when it ran, for which row, who started it, how it ended and each step's outcome. Older
// runs page in; "Read again" fetches the newest.
import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useState } from 'react';
import type { AutomationRun, AutomationRunsPage } from '../host';
import { reasonText, statusText, stepStatusText } from './model';
import { useAutoT } from './words';

export interface RunLogProps {
  /** A page of runs older than the cursor (null: the newest). */
  load(before: string | null): Promise<AutomationRunsPage>;
  /** The log's heading. */
  title: string;
  /** A row's log names each run's rule; a rule's names each run's row. */
  of: 'rule' | 'row';
  stepName(kind: string): string;
}

export function RunLog({ load, title, of, stepName }: RunLogProps) {
  const { t: at, locale } = useAutoT();
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const read = useCallback(
    async (before: string | null) => {
      setState('loading');
      try {
        const page = await load(before);
        setRuns((old) => (before ? [...old, ...page.runs] : page.runs));
        setNext(page.next);
        setState('ready');
      } catch {
        setState('failed');
      }
    },
    [load],
  );

  useEffect(() => void read(null), [read]);

  return (
    <section className="cgw-db-auto-log" aria-label={title}>
      <div className="cgw-db-auto-head">
        <h3 className="cgw-panel-title">{title}</h3>
        <CgButton appearance="ghost" size="small" onClick={() => void read(null)}>
          {at('log.refresh')}
        </CgButton>
      </div>
      {state === 'failed' ? (
        <p role="alert">{at('log.failed')}</p>
      ) : state === 'loading' && !runs.length ? (
        <p role="status">{at('log.loading')}</p>
      ) : !runs.length ? (
        <p>{at('log.none')}</p>
      ) : (
        <ol className="cgw-db-auto-runs">
          {runs.map((run) => (
            <li key={run.id} className="cgw-db-auto-run" data-status={run.status}>
              <div className="cgw-db-auto-run-head">
                <span className="cgw-db-auto-status">{statusText(run.status, at)}</span>
                <time dateTime={run.startedAt}>{format.format(new Date(run.startedAt))}</time>
                <span dir="auto">
                  {of === 'row'
                    ? run.automationName
                    : run.rowId
                      ? (run.rowTitle ?? at('log.hiddenRow'))
                      : at('log.noRow')}
                </span>
              </div>
              {run.actor ? (
                <p className="cgw-db-auto-note">{at('log.startedBy', { name: run.actor.name })}</p>
              ) : null}
              {run.reason ? <p className="cgw-db-auto-note">{reasonText(run.reason, at)}</p> : null}
              {run.steps.length ? (
                <ul className="cgw-db-auto-run-steps" aria-label={at('log.steps')}>
                  {run.steps.map((step) => (
                    <li key={step.index}>
                      {stepName(step.kind)}: {stepStatusText(step.status, at)}
                      {step.code ? ` (${reasonText(step.code, at)})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {next ? (
        <CgButton appearance="outline" size="small" onClick={() => void read(next)}>
          {at('log.more')}
        </CgButton>
      ) : null}
    </section>
  );
}
