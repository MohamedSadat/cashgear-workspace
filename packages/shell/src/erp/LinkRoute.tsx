// `#/erp-link`: the link screen, over the ticket held in memory (linkTicket.ts), the account,
// the workspaces this person owns or administers, the ERP's Redeem and Workspace's erp-links.
import type { ErpLinkScreenHost, LinkableWorkspace } from '@cgw/erp';
import { lazy, Suspense, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
import { useMirror } from '../sidebar/Sidebar';
import { forgetErpLinkTicket, heldErpLinkTicket, onErpLinkTicket } from './linkTicket';
import type { ShellErp } from './services';

const ErpLinkScreen = lazy(() =>
  import('@cgw/erp/view').then((m) => ({ default: m.ErpLinkScreen })),
);

export function ErpLinkRoute({
  session,
  services,
}: {
  session: WorkspaceSession;
  services: ShellErp | null;
}) {
  const { t, i18n } = useTranslation();
  const cloud = useCloud();
  const account = useAccount(cloud);
  useMirror(session);
  const ticket = useSyncExternalStore(onErpLinkTicket, () => heldErpLinkTicket());
  const subscribe = useCallback(
    (listener: () => void) => services?.subscribe(listener) ?? (() => undefined),
    [services],
  );
  const online = useSyncExternalStore(subscribe, () => services?.online() ?? true);
  // Those this person owns or administers, kept on their account: the same list while it holds
  // the same workspaces.
  const workspaces: LinkableWorkspace[] = session
    .workspaces()
    .filter((w) => !w.localOnly && (w.role === 'owner' || w.role === 'admin'))
    .map((w) => ({ id: w.id, name: w.name }));
  const key = workspaces.map((w) => `${w.id}:${w.name}`).join('|');
  const stable = useMemo(() => workspaces, [key]);
  const host = useMemo<ErpLinkScreenHost | null>(
    () =>
      services
        ? {
            ticket,
            signedIn: !cloud ? false : account === undefined ? undefined : !!account,
            online,
            signIn: () => void cloud?.signIn(i18n.language === 'ar' ? 'ar' : 'en'),
            workspaces: stable,
            redeem: (held, workspace) => services.redeemLink(held, workspace),
            record: (workspace, link) => services.recordLink(workspace.id, link),
            forgetTicket: forgetErpLinkTicket,
            openSettings: (workspaceId) => {
              if (session.workspaceId !== workspaceId) session.switchTo(workspaceId);
              navigate({ kind: 'settings' }, true);
            },
            close: () => navigate({ kind: 'home' }, true),
          }
        : null,
    [services, ticket, cloud, account, online, i18n.language, stable, session],
  );
  if (!host)
    return (
      <div className="cgw-empty">
        <h1>{t('frame.notFound')}</h1>
      </div>
    );
  return (
    <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
      <ErpLinkScreen host={host} />
    </Suspense>
  );
}
