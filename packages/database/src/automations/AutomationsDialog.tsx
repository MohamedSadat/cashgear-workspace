// A database's automations (Phase 15, M15.3), opened from its views' toolbar: its rules with a
// switch each, what starts each and how its last run went; a rule's editor; a rule's run log.
// Everyone who can read the database reads them; full access changes them (the server decides).
// Rules are read from the server, so offline the dialog says they are kept online. Loaded with the
// dialog, never with the views.
import { CgButton, CgPopup, CgSwitch } from '@cashgear/ui';
import { uuidv7, type Id } from '@cgw/workspace';
import { useCallback, useEffect, useState } from 'react';
import type { AutomationRecord, AutomationTrigger } from '../core';
import { useDatabase, useDatabaseContext, useViews } from '../context';
import type { DatabaseAutomations } from '../host';
import { newRule, statusText, triggerText } from './model';
import type { RuleStart } from './open';
import { RuleEditor, stepNameOf } from './RuleEditor';
import { seriesText } from './Series';
import { RunLog } from './RunLog';
import { useAutoT } from './words';
import './automations.css';

export interface AutomationsDialogProps {
  databaseId: Id;
  onClose(): void;
  /** Open straight on a new rule with this trigger (a button property's "Add an automation"). */
  start?: AutomationTrigger;
  /** Phase 17: its name and steps to start from ("Repeat a template", a date's "Remind people"). */
  extra?: RuleStart;
}

type Screen =
  | { kind: 'list' }
  | { kind: 'edit'; rule: AutomationRecord; isNew: boolean }
  | { kind: 'runs'; rule: AutomationRecord }
  | { kind: 'delete'; rule: AutomationRecord };

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'server.error';
}

export function AutomationsDialog({ databaseId, onClose, start, extra }: AutomationsDialogProps) {
  const { t: at, locale } = useAutoT();
  const { host } = useDatabaseContext();
  const automations = host.automations;
  const database = useDatabase(host, databaseId);
  const views = useViews(host, databaseId);
  const [data, setData] = useState<DatabaseAutomations | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'offline'>('loading');
  const [reading, setReading] = useState(0);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    if (!automations) return;
    let live = true;
    if (!automations.online()) {
      setState('offline');
      return;
    }
    automations.list(databaseId).then(
      (answer) => {
        if (!live) return;
        setData(answer);
        setState('ready');
      },
      (error) => live && setState(failureText(error) === 'offline' ? 'offline' : 'failed'),
    );
    automations.groups().then(
      (list) => live && setGroups(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [automations, databaseId, reading]);

  useEffect(() => automations?.onChange(() => setReading((n) => n + 1)), [automations]);

  // A button property's "Add an automation" opens on a new rule for it.
  useEffect(() => {
    if (start && database && data?.canManage) {
      const rule = newRule(uuidv7(), database.workspaceId, database, start);
      setScreen({
        kind: 'edit',
        rule: {
          ...rule,
          name: extra?.name ?? rule.name,
          steps: extra?.steps ?? rule.steps,
        },
        isNew: true,
      });
    }
  }, [start, extra, database, data?.canManage]);

  const stepName = stepNameOf(at);
  const loadRuns = useCallback(
    (rule: AutomationRecord) => (before: string | null) =>
      automations!.runs(databaseId, rule.id, before),
    [automations, databaseId],
  );

  const failed = (error: unknown) => {
    const code = failureText(error);
    setMessage({
      text:
        code === 'access.denied'
          ? at('denied')
          : code === 'automation.limit'
            ? at('limit')
            : code === 'offline'
              ? at('offline')
              : at('failed'),
      alert: true,
    });
  };

  const save = async (rule: AutomationRecord) => {
    setMessage(null);
    try {
      await automations!.save(rule);
      setScreen({ kind: 'list' });
      setMessage({ text: at('saved', { name: rule.name || at('untitled') }), alert: false });
      setReading((n) => n + 1);
    } catch (error) {
      failed(error);
    }
  };

  if (!automations || !database) return null;
  const nameOf = (rule: AutomationRecord) => rule.name || at('untitled');

  const body = (() => {
    if (state === 'offline') return <p role="status">{at('offline')}</p>;
    if (state === 'failed') return <p role="alert">{at('loadFailed')}</p>;
    if (state === 'loading' || !data) return <p role="status">{at('loading')}</p>;
    switch (screen.kind) {
      case 'edit':
        return (
          <RuleEditor
            key={screen.rule.id}
            database={database}
            rule={screen.rule}
            data={data}
            groups={groups}
            onSave={save}
            onCancel={() => setScreen({ kind: 'list' })}
            onDelete={
              screen.isNew ? undefined : () => setScreen({ kind: 'delete', rule: screen.rule })
            }
          />
        );
      case 'runs':
        return (
          <>
            <CgButton appearance="ghost" size="small" onClick={() => setScreen({ kind: 'list' })}>
              {at('back')}
            </CgButton>
            <RunLog
              title={at('log.title', { name: nameOf(screen.rule) })}
              of="rule"
              load={loadRuns(screen.rule)}
              stepName={stepName}
            />
          </>
        );
      case 'delete':
        return (
          <div className="cgw-db-auto-confirm" role="alertdialog" aria-label={at('deleteNow')}>
            <p>{at('deleteAsk', { name: nameOf(screen.rule) })}</p>
            <CgButton
              intent="danger"
              onClick={async () => {
                const rule = screen.rule;
                try {
                  await automations.remove(rule);
                  setScreen({ kind: 'list' });
                  setMessage({ text: at('deleted', { name: nameOf(rule) }), alert: false });
                  setReading((n) => n + 1);
                } catch (error) {
                  failed(error);
                }
              }}
            >
              {at('deleteNow')}
            </CgButton>
            <CgButton
              appearance="outline"
              onClick={() => setScreen({ kind: 'edit', rule: screen.rule, isNew: false })}
            >
              {at('cancel')}
            </CgButton>
          </div>
        );
      case 'list':
        return (
          <>
            {data.allOff ? <p className="cgw-db-auto-note">{at('allOff')}</p> : null}
            {!data.canManage ? <p className="cgw-db-auto-note">{at('readOnly')}</p> : null}
            {data.automations.length ? (
              <ul className="cgw-db-auto-list" aria-label={at('title')}>
                {data.automations.map(({ rule, author, lastRun }) => (
                  <li key={rule.id} className="cgw-db-auto-item" data-automation={rule.id}>
                    <CgSwitch
                      checked={rule.enabled}
                      disabled={!data.canManage}
                      aria-label={at('switchLabel', { name: nameOf(rule) })}
                      onCheckedChange={(on) =>
                        void automations
                          .setEnabled(rule, on)
                          .then(() => setReading((n) => n + 1), failed)
                      }
                    />
                    <div className="cgw-db-auto-item-text">
                      <span className="cgw-db-auto-name" dir="auto">
                        {nameOf(rule)}
                      </span>
                      <span className="cgw-db-auto-note">
                        {triggerText(
                          rule.trigger,
                          database,
                          at,
                          locale,
                          undefined,
                          (id) => views.find((v) => v.id === id)?.name,
                          (series) =>
                            seriesText(
                              series,
                              at,
                              locale,
                              (id) => host.rowTemplates(databaseId).find((r) => r.id === id)?.title,
                            ),
                        )}
                        {author ? ` · ${at('author', { name: author.name })}` : ''}
                      </span>
                      <span className="cgw-db-auto-note">
                        {lastRun
                          ? at('lastRun', {
                              when: format.format(new Date(lastRun.startedAt)),
                              status: statusText(lastRun.status, at),
                            })
                          : at('neverRun')}
                      </span>
                    </div>
                    <CgButton
                      appearance="ghost"
                      size="small"
                      aria-label={at('editLabel', { name: nameOf(rule) })}
                      onClick={() => setScreen({ kind: 'edit', rule, isNew: false })}
                    >
                      {at('edit')}
                    </CgButton>
                    <CgButton
                      appearance="ghost"
                      size="small"
                      aria-label={at('runsLabel', { name: nameOf(rule) })}
                      onClick={() => setScreen({ kind: 'runs', rule })}
                    >
                      {at('runs')}
                    </CgButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{at('none')}</p>
            )}
            {data.canManage ? (
              <CgButton
                intent="primary"
                size="small"
                onClick={() =>
                  setScreen({
                    kind: 'edit',
                    rule: newRule(uuidv7(), database.workspaceId, database),
                    isNew: true,
                  })
                }
              >
                {at('new')}
              </CgButton>
            ) : null}
            <p className="cgw-db-auto-note">
              {data.timeZone ? at('timeZone', { zone: data.timeZone }) : at('timeZoneUtc')}
            </p>
          </>
        );
    }
  })();

  return (
    <CgPopup
      open
      headerText={at('title')}
      closeButtonAriaLabel={at('close')}
      width="min(46rem, calc(100vw - 24px))"
      className="cgw-db-auto-dialog"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="cgw-db-auto">
        {message ? (
          <p role={message.alert ? 'alert' : 'status'} className="cgw-db-auto-message-line">
            {message.text}
          </p>
        ) : null}
        {body}
      </div>
    </CgPopup>
  );
}
