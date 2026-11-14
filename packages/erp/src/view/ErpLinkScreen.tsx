// The link screen (`#/erp-link/{ticket}`, INTEGRATIONS.md "Linking a workspace to a company"):
// Cash Gear ERP sent an admin here with a one-time link ticket, which the shell took out of the
// address at once and holds in memory. The person picks a workspace they own or administer and
// confirms; the ticket is redeemed at the ERP (which names the company) and the link recorded at
// Workspace. The ticket is sent once and then forgotten, whatever the answer.
import { CgButton } from '@cashgear/ui';
import { useId, useState } from 'react';
import { ErpError, type LinkRedeemResponse } from '../contract';
import { useErpT } from '../i18n';
import {
  RecordLinkError,
  type ErpLinkScreenHost,
  type LinkableWorkspace,
  type RecordLinkFailure,
} from './host';
import './erp.css';

type Step =
  | { kind: 'choose' }
  | { kind: 'working' }
  | { kind: 'redeemFailed'; error: ErpError | null }
  | {
      kind: 'recordFailed';
      workspace: LinkableWorkspace;
      link: LinkRedeemResponse;
      code: RecordLinkFailure;
    }
  | { kind: 'done'; workspace: LinkableWorkspace; link: LinkRedeemResponse; existed: boolean }
  | { kind: 'cancelled' };

export function ErpLinkScreen({ host }: { host: ErpLinkScreenHost }) {
  const { t } = useErpT();
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [chosen, setChosen] = useState<string | null>(host.workspaces[0]?.id ?? null);
  const workspace = host.workspaces.find((w) => w.id === chosen) ?? host.workspaces[0];

  const record = async (target: LinkableWorkspace, link: LinkRedeemResponse) => {
    setStep({ kind: 'working' });
    try {
      const outcome = await host.record(target, link);
      setStep({ kind: 'done', workspace: target, link, existed: outcome === 'exists' });
    } catch (error) {
      setStep({
        kind: 'recordFailed',
        workspace: target,
        link,
        code: error instanceof RecordLinkError ? error.code : 'failed',
      });
    }
  };

  const confirm = async () => {
    const ticket = host.ticket;
    if (!ticket || !workspace) return;
    setStep({ kind: 'working' });
    // Sent once: a lost answer may have used it, so it is never sent again.
    host.forgetTicket();
    let link: LinkRedeemResponse;
    try {
      link = await host.redeem(ticket, workspace);
    } catch (error) {
      setStep({ kind: 'redeemFailed', error: error instanceof ErpError ? error : null });
      return;
    }
    await record(workspace, link);
  };

  let body;
  if (step.kind === 'done') {
    body = (
      <>
        <p role="status" data-testid="erp-link-done">
          {t(step.existed ? 'linkExists' : 'linkDone', {
            company: step.link.companyName,
            workspace: step.workspace.name,
          })}
        </p>
        <div className="cgw-erp-actions">
          <CgButton intent="primary" onClick={() => host.openSettings(step.workspace.id)}>
            {t('linkOpenSettings')}
          </CgButton>
        </div>
      </>
    );
  } else if (step.kind === 'recordFailed') {
    body = (
      <>
        <p role="alert" data-testid="erp-link-record-failed">
          {t(
            step.code === 'forbidden'
              ? 'linkForbidden'
              : step.code === 'stale'
                ? 'linkStale'
                : step.code === 'network'
                  ? 'linkOffline'
                  : 'linkRecordFailed',
          )}
        </p>
        <div className="cgw-erp-actions">
          {step.code !== 'forbidden' && step.code !== 'stale' && (
            <CgButton intent="primary" onClick={() => void record(step.workspace, step.link)}>
              {t('retry')}
            </CgButton>
          )}
          <CgButton appearance="ghost" onClick={host.close}>
            {t('close')}
          </CgButton>
        </div>
      </>
    );
  } else if (step.kind === 'redeemFailed') {
    body = (
      <>
        <p role="alert" data-testid="erp-link-failed" data-code={step.error?.code}>
          {redeemText(t, step.error)}
        </p>
        {step.error?.code !== 'ticket.invalid' && (
          <p className="cgw-erp-muted">{t('linkStartAgain')}</p>
        )}
        {step.error?.correlationId && (
          <p className="cgw-erp-muted">{t('reference', { id: step.error.correlationId })}</p>
        )}
        <div className="cgw-erp-actions">
          <CgButton appearance="ghost" onClick={host.close}>
            {t('close')}
          </CgButton>
        </div>
      </>
    );
  } else if (step.kind === 'cancelled') {
    body = <p role="status">{t('linkCancelled')}</p>;
  } else if (step.kind === 'working') {
    body = (
      <p role="status" aria-busy="true">
        {t('linkWorking')}
      </p>
    );
  } else if (!host.ticket) {
    body = <p data-testid="erp-link-no-ticket">{t('linkNoTicket')}</p>;
  } else if (host.signedIn === undefined) {
    body = <p aria-busy="true">{t('loading')}</p>;
  } else if (!host.signedIn) {
    body = (
      <>
        <p data-testid="erp-link-sign-in">{t('linkSignIn')}</p>
        <p className="cgw-erp-muted">{t('linkSignInNote')}</p>
        <div className="cgw-erp-actions">
          <CgButton intent="primary" onClick={host.signIn}>
            {t('signInButton')}
          </CgButton>
        </div>
      </>
    );
  } else if (!host.online) {
    body = <p data-testid="erp-link-offline">{t('linkOffline')}</p>;
  } else if (!workspace) {
    body = <p data-testid="erp-link-no-workspace">{t('linkNoWorkspace')}</p>;
  } else {
    body = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <fieldset className="cgw-erp-fieldset">
          <legend>{t('linkChoose')}</legend>
          <ul className="cgw-erp-checks">
            {host.workspaces.map((w) => (
              <li key={w.id}>
                <label>
                  <input
                    type="radio"
                    name="cgw-erp-link-workspace"
                    value={w.id}
                    checked={w.id === workspace.id}
                    onChange={() => setChosen(w.id)}
                  />{' '}
                  <span dir="auto">{w.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="cgw-erp-actions">
          <CgButton intent="primary" type="submit">
            {t('linkConfirm')}
          </CgButton>
          <CgButton
            appearance="ghost"
            onClick={() => {
              host.forgetTicket();
              setStep({ kind: 'cancelled' });
              host.close();
            }}
          >
            {t('cancel')}
          </CgButton>
        </div>
      </form>
    );
  }

  return (
    <section className="cgw-erp-screen" aria-labelledby={titleId} data-testid="erp-link-screen">
      <h1 id={titleId}>{t('linkTitle')}</h1>
      <p>{t('linkIntro')}</p>
      {body}
    </section>
  );
}

function redeemText(t: ReturnType<typeof useErpT>['t'], error: ErpError | null): string {
  switch (error?.code) {
    case 'ticket.invalid':
      return t('linkExpired');
    case 'link.revoked':
      return t('linkOff');
    case 'privilege.denied':
      return t('linkDenied');
    case 'origin.denied':
      return t('originDenied');
    case 'rate.limited':
      return t('rateLimitedNow');
    case 'network':
    case 'server':
      return t('notAnswering');
    case 'response.invalid':
      return t('badAnswer');
    default:
      return t('failed');
  }
}
