// A form's link (Phase 16, M16.2), from the form view's "Share form": its address to copy, whether
// it takes answers, its closing time and maximum, its answers, deleting it; made, changed and
// deleted by full access to the database (the server decides). "Tell me of new answers" saves an
// automation started by the form that tells the person (Phase 15's notice). Links are kept by the
// server: offline the panel says so.
import { CgButton, CgSwitch } from '@cashgear/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import type { AutomationRecord, ViewRecord } from '../../core';
import { useDatabaseContext } from '../../context';
import type { FormLink, FormLinkSettings, FormState, FormsHost } from '../../host';
import { useFormT } from './words';

export interface FormShareProps {
  forms: FormsHost;
  view: ViewRecord;
  /** Told when the link or its answers change (the view's count reads again). */
  onChange?(state: FormState): void;
}

/** An ISO time as a `datetime-local` input shows it on this device, and back. */
function toLocal(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
const fromLocal = (local: string) => (local ? new Date(local).toISOString() : null);

export function FormShare({ forms, view, onChange }: FormShareProps) {
  const { host } = useDatabaseContext();
  const { ft } = useFormT();
  const ids = { closes: useId(), max: useId(), url: useId() };
  const [state, setState] = useState<FormState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ closesAt: string; max: string }>({ closesAt: '', max: '' });

  const settle = useCallback(
    (next: FormState) => {
      setState(next);
      setDraft({
        closesAt: toLocal(next.link?.closesAt ?? null),
        max: next.link?.maxAnswers?.toString() ?? '',
      });
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (!forms.online()) return;
    let live = true;
    forms.state(view.databaseId, view.id).then(
      (next) => live && settle(next),
      () => live && setProblem(ft('share.failed')),
    );
    return () => {
      live = false;
    };
  }, [forms, view.databaseId, view.id, settle, ft]);

  const run = async (act: () => Promise<FormLink | void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await act();
      settle(await forms.state(view.databaseId, view.id));
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setProblem(
        code === 'access.denied'
          ? ft('share.denied')
          : code === 'offline'
            ? ft('share.offline')
            : ft('share.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!forms.online()) return <p className="cgw-db-form-note">{ft('share.offline')}</p>;
  if (!state) return <p className="cgw-db-form-note">{problem ?? ft('share.loading')}</p>;

  const link = state.link;
  const settings = (enabled: boolean): FormLinkSettings => ({
    enabled,
    closesAt: fromLocal(draft.closesAt),
    maxAnswers: draft.max.trim() ? Math.max(1, Math.trunc(Number(draft.max) || 1)) : null,
  });
  const me = host.me();
  const automations = host.automations;

  return (
    <div className="cgw-db-form-share">
      <p className="cgw-db-form-note">{ft('share.intro')}</p>
      {problem ? (
        <p className="cgw-db-form-error" role="alert">
          {problem}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!state.linksAllowed ? (
        <p className="cgw-db-form-note">{ft('share.private')}</p>
      ) : !link ? (
        state.canManage ? (
          <CgButton
            intent="primary"
            disabled={busy}
            onClick={() =>
              void run(() => forms.createLink(view.databaseId, view.id, settings(true)))
            }
          >
            {ft('share.make')}
          </CgButton>
        ) : (
          <p className="cgw-db-form-note">{ft('share.denied')}</p>
        )
      ) : (
        <>
          <div className="cgw-db-form-field">
            <label className="cgw-label" htmlFor={ids.url}>
              {ft('share.address')}
            </label>
            <div className="cgw-db-form-url">
              <input
                id={ids.url}
                className="cgw-text-input"
                dir="ltr"
                readOnly
                value={link.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <CgButton
                appearance="outline"
                size="small"
                onClick={() =>
                  void navigator.clipboard?.writeText(link.url).then(
                    () => setNotice(ft('share.copied')),
                    () => undefined,
                  )
                }
              >
                {ft('share.copy')}
              </CgButton>
            </div>
          </div>
          <p className="cgw-db-form-state" data-state={link.state}>
            {ft(`share.state.${link.state}`)} · {ft('share.byLink', { number: link.answers })}
          </p>
          {state.canManage ? (
            <>
              <div className="cgw-db-form-switch">
                <CgSwitch
                  checked={link.enabled}
                  disabled={busy}
                  aria-label={ft('share.taking')}
                  onCheckedChange={(on) =>
                    void run(() => forms.updateLink(view.databaseId, view.id, settings(on)))
                  }
                />
                <span aria-hidden="true">{ft('share.taking')}</span>
              </div>
              <div className="cgw-db-form-field">
                <label className="cgw-label" htmlFor={ids.closes}>
                  {ft('share.closesAt')}
                </label>
                <input
                  id={ids.closes}
                  type="datetime-local"
                  className="cgw-text-input"
                  value={draft.closesAt}
                  onChange={(event) => setDraft((d) => ({ ...d, closesAt: event.target.value }))}
                />
              </div>
              <div className="cgw-db-form-field">
                <label className="cgw-label" htmlFor={ids.max}>
                  {ft('share.max')}
                </label>
                <input
                  id={ids.max}
                  type="number"
                  min={1}
                  className="cgw-text-input"
                  value={draft.max}
                  onChange={(event) => setDraft((d) => ({ ...d, max: event.target.value }))}
                />
              </div>
              <div className="cgw-db-form-actions">
                <CgButton
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      forms.updateLink(view.databaseId, view.id, settings(link.enabled)),
                    )
                  }
                >
                  {ft('share.save')}
                </CgButton>
                <CgButton
                  appearance="ghost"
                  intent="danger"
                  size="small"
                  disabled={busy}
                  title={ft('share.deleteHelp')}
                  onClick={() => void run(() => forms.deleteLink(view.databaseId, view.id))}
                >
                  {ft('share.delete')}
                </CgButton>
              </div>
            </>
          ) : null}
        </>
      )}
      {automations && me && state.canManage ? (
        <CgButton
          appearance="ghost"
          size="small"
          disabled={busy}
          onClick={() => {
            const name = view.name || ft('untitled');
            const rule: AutomationRecord = {
              id: host.newId(),
              workspaceId: view.workspaceId,
              databaseId: view.databaseId,
              name: ft('share.notifyName', { form: name }),
              enabled: true,
              trigger: { kind: 'formAnswered', viewId: view.id },
              conditions: null,
              steps: [
                {
                  kind: 'notify',
                  people: [me.id],
                  groups: [],
                  personProperties: [],
                  message: ft('share.notifyMessage', { form: name }),
                  when: null,
                },
              ],
              authorId: null,
              version: 0,
              createdAt: '',
              updatedAt: '',
            };
            setBusy(true);
            automations.save(rule).then(
              () => {
                setBusy(false);
                setNotice(ft('share.notifyDone'));
              },
              () => {
                setBusy(false);
                setProblem(ft('share.failed'));
              },
            );
          }}
        >
          {ft('share.notify')}
        </CgButton>
      ) : null}
    </div>
  );
}
