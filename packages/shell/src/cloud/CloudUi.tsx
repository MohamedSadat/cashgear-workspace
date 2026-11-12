// The account and sync parts of the interface (Phase 2): signing in and out, the devices signed
// in, the sync status, uploading a local workspace, members and invites, and accepting an invite.
// Phase 3: the status while offline or retrying, what is kept offline (the menus' items and the
// sidebar's marks), and the recovered pages' count.
import type { Id, SyncStatus } from '@cgw/workspace';
import type { TFunction } from 'i18next';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
import type { MenuItem } from '../sidebar/RowMenu';
import type { Cloud } from './cloud';

export const CloudContext = createContext<Cloud | null>(null);

export function useCloud(): Cloud | null {
  return useContext(CloudContext);
}

/** Who is signed in: undefined while the first check is out, null when signed out. */
export function useAccount(cloud: Cloud | null) {
  return useSyncExternalStore(
    (listener) => (cloud ? cloud.subscribe(listener) : () => {}),
    () => (cloud ? cloud.account : null),
  );
}

const language = () => (document.documentElement.lang === 'ar' ? 'ar' : 'en');

const noMarks = () => null;
const noSubscription = () => () => {};

/**
 * The pages this device holds, while the server is out of reach in a synced workspace (the tree
 * marks the others); null otherwise. Renders again only when the marks change, never per pass.
 */
export function useOfflineMarks(cloud: Cloud | null): ReadonlySet<Id> | null {
  return useSyncExternalStore(
    cloud ? cloud.offline.subscribe : noSubscription,
    cloud ? cloud.offline.marks : noMarks,
  );
}

/** Renders again when what is kept offline changes (pins, held pages, reachability). */
export function useOfflineRevision(cloud: Cloud | null): number {
  return useSyncExternalStore(
    cloud ? cloud.offline.subscribe : noSubscription,
    cloud ? cloud.offline.getRevision : () => 0,
  );
}

/** Renders again when the recovered pages change. */
export function useRecoveredRevision(cloud: Cloud | null): number {
  return useSyncExternalStore(
    cloud ? cloud.recovery.subscribe : noSubscription,
    cloud ? cloud.recovery.getRevision : () => 0,
  );
}

/**
 * A page menu's "Available offline" items (M3.1): this page, or this page and the pages under it;
 * a page a parent's pin covers says so and leads there, where it can be unpinned. Only in a
 * workspace that syncs: a local one holds every page anyway.
 */
export function offlineMenuItems(
  cloud: Cloud | null,
  session: WorkspaceSession,
  pageId: Id,
  t: TFunction,
): MenuItem[] {
  if (!cloud) return [];
  const page = session.mirror.pages.get(pageId);
  const workspace = page && session.mirror.workspaces.get(page.workspaceId);
  if (!page || !workspace || workspace.localOnly || page.trashedAt) return [];
  const failed = (error: unknown) => console.warn('Could not keep the page offline:', error);
  const state = cloud.offline.pinOf(pageId);
  if (state?.inherited) {
    const root = session.mirror.pages.get(state.pin.pageId);
    return [
      {
        label: t('offline.inherited', { title: root?.title || t('page.untitled') }),
        onSelect: () => navigate({ kind: 'page', pageId: state.pin.pageId }),
      },
    ];
  }
  if (state)
    return [
      ...(state.pin.subtree
        ? []
        : [
            {
              label: t('offline.addSubtree'),
              onSelect: () => void cloud.offline.pin(pageId, true).catch(failed),
            },
          ]),
      {
        label: t('offline.remove'),
        onSelect: () => void cloud.offline.unpin(pageId).catch(failed),
      },
    ];
  return [
    {
      label: t('offline.makeAvailable'),
      onSelect: () => void cloud.offline.pin(pageId, false).catch(failed),
    },
    {
      label: t('offline.makeAvailableSubtree'),
      onSelect: () => void cloud.offline.pin(pageId, true).catch(failed),
    },
  ];
}

/** The sidebar's sign-in button, or the account's name with sign-out. */
export function AccountButton({ cloud }: { cloud: Cloud }) {
  const { t } = useTranslation();
  const account = useAccount(cloud);
  const [busy, setBusy] = useState(false);
  if (account === undefined) return null;
  if (!account)
    return (
      <button
        type="button"
        className="cgw-button cgw-account-button"
        title={t('cloud.signInHint')}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void cloud.signIn(language()).finally(() => setBusy(false));
        }}
      >
        {busy ? t('cloud.signingIn') : t('cloud.signIn')}
      </button>
    );
  return (
    <button
      type="button"
      className="cgw-button cgw-account-button"
      aria-label={t('cloud.accountMenu', { name: account.displayName })}
      onClick={() => navigate({ kind: 'settings' })}
    >
      {account.displayName}
    </button>
  );
}

/**
 * The top bar's sync state. Drawn without React, as the save status is: a React commit while the
 * editor has focus reads its selection offsets, which costs at large pages.
 */
export function SyncStatusLabel({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const { t } = useTranslation();
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = label.current;
    if (!el) return;
    const show = () => {
      const local = session.current?.localOnly !== false;
      const status: SyncStatus = cloud.status;
      // Until the first check has answered (or the app went on offline without it).
      const state = local ? 'localOnly' : cloud.account === undefined ? 'connecting' : status.state;
      const count = status.waiting;
      el.dataset.state = state;
      el.textContent =
        state === 'localOnly'
          ? t('sync.localOnly')
          : state === 'connecting'
            ? t('sync.connecting')
            : state === 'synced'
              ? t('sync.synced')
              : state === 'syncing'
                ? t('sync.syncing')
                : state === 'offline'
                  ? count
                    ? t('sync.offlineWaiting', { count })
                    : t('sync.offline')
                  : state === 'signedOut'
                    ? count
                      ? t('sync.signedOut', { count })
                      : t('sync.signedOutNone')
                    : // The server answered a problem the loop backs off from and retries.
                      count
                      ? t('sync.errorWaiting', { count })
                      : t('sync.error');
    };
    show();
    const off = cloud.subscribe(show);
    const offMirror = session.mirror.subscribe(show);
    const offSwitch = session.onSwitch(show);
    return () => {
      off();
      offMirror();
      offSwitch();
    };
  }, [cloud, session, t]);
  return (
    <span
      ref={label}
      className="cgw-sync-status"
      role="status"
      aria-live="polite"
      data-testid="sync-status"
    />
  );
}

/** Offered in the sidebar while signed in and the open workspace is on this device only. */
export function UploadBanner({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const { t } = useTranslation();
  const account = useAccount(cloud);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const workspace = session.current;
  if (!account || !workspace || !workspace.localOnly) return null;
  return (
    <div className="cgw-upload-banner" role="region" aria-label={t('cloud.uploadTitle')}>
      <strong>{t('cloud.uploadTitle')}</strong>
      <p>{state === 'failed' ? t('cloud.uploadFailed') : t('cloud.uploadBody')}</p>
      <button
        type="button"
        className="cgw-button is-primary"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          cloud.upload(workspace.id).then(
            () => {
              setState('idle');
              cloud.notify({ code: 'cloud.uploaded' });
            },
            (error: unknown) => {
              console.warn('Upload failed:', error);
              setState('failed');
            },
          );
        }}
      >
        {state === 'busy' ? t('cloud.uploading') : t('cloud.upload')}
      </button>
    </div>
  );
}

type Device = Awaited<ReturnType<Cloud['devices']>>[number];
type MemberRow = Awaited<ReturnType<Cloud['members']>>[number];
type InviteRow = Awaited<ReturnType<Cloud['invites']>>[number];

/** Settings: who is signed in, the devices signed in, and signing out. */
export function AccountSettings({ cloud }: { cloud: Cloud }) {
  const { t, i18n } = useTranslation();
  const account = useAccount(cloud);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  useEffect(() => {
    if (account) void cloud.devices().then(setDevices, () => setDevices([]));
  }, [cloud, account]);
  if (account === undefined) return null;
  return (
    <section aria-labelledby="cgw-account-title">
      <h2 id="cgw-account-title">{t('cloud.account')}</h2>
      {!account ? (
        <>
          <p>{t('cloud.signInHint')}</p>
          <button
            type="button"
            className="cgw-button is-primary"
            onClick={() => void cloud.signIn(language())}
          >
            {t('cloud.signIn')}
          </button>
        </>
      ) : (
        <>
          <p data-testid="signed-in-as">
            {t('cloud.signedInAs', { name: account.displayName, email: account.email })}
          </p>
          <h3>{t('cloud.devices')}</h3>
          <ul className="cgw-list">
            {(devices ?? []).map((device) => (
              <li key={device.id} className="cgw-list-row">
                <span>
                  {device.name} ·{' '}
                  {t(device.platform === 'desktop' ? 'cloud.platformDesktop' : 'cloud.platformWeb')}
                  {device.current && <> · {t('cloud.thisDevice')}</>}
                </span>
                <span className="cgw-muted">
                  {t('cloud.lastSeen', { when: format.format(new Date(device.lastSeenAt)) })}
                </span>
                {!device.current && (
                  <button
                    type="button"
                    className="cgw-button"
                    onClick={() =>
                      void cloud
                        .revokeDevice(device.id)
                        .then(() =>
                          setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null),
                        )
                    }
                  >
                    {t('cloud.signOutDevice')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="cgw-button" onClick={() => void cloud.signOut()}>
            {t('cloud.signOut')}
          </button>
          <h3>{t('cloud.deleteAccount')}</h3>
          <p className="cgw-muted">{t('cloud.deleteAccountNote')}</p>
          <button
            type="button"
            className="cgw-button is-danger"
            onClick={() => void cloud.deleteAccount(language())}
          >
            {t('cloud.deleteAccountOpen')}
          </button>
        </>
      )}
    </section>
  );
}

const ROLES = ['admin', 'member', 'guest'] as const;
const roleKey = (role: string) =>
  role === 'owner'
    ? 'cloud.roleOwner'
    : role === 'admin'
      ? 'cloud.roleAdmin'
      : role === 'guest'
        ? 'cloud.roleGuest'
        : 'cloud.roleMember';

/** Settings: the open workspace's members and invitations (owners and admins change them). */
export function MembersSettings({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const { t } = useTranslation();
  const account = useAccount(cloud);
  const workspace = session.current;
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('member');
  const [message, setMessage] = useState<string | null>(null);
  const synced = !!account && !!workspace && !workspace.localOnly;
  const admin = workspace?.role === 'owner' || workspace?.role === 'admin';
  const workspaceId: Id | null = synced ? workspace.id : null;
  const load = () => {
    if (!workspaceId) return;
    void cloud.members(workspaceId).then(setMembers, () => setMembers([]));
    if (admin) void cloud.invites(workspaceId).then(setInvites, () => setInvites([]));
  };
  useEffect(load, [cloud, workspaceId, admin]);
  useEffect(() => cloud.subscribe(load), [cloud, workspaceId]);
  if (!account || !workspace) return null;
  const failed = () => setMessage(t('cloud.requestFailed'));
  return (
    <section aria-labelledby="cgw-members-title">
      <h2 id="cgw-members-title">{t('cloud.members')}</h2>
      {!synced ? (
        <p className="cgw-muted">{t('cloud.membersLocalOnly')}</p>
      ) : (
        <>
          <ul className="cgw-list" data-testid="members">
            {(members ?? []).map((member) => (
              <li key={member.userId} className="cgw-list-row">
                <span>
                  {member.displayName}
                  {member.userId === account.id && <> ({t('cloud.you')})</>}
                  <span className="cgw-muted"> {member.email}</span>
                </span>
                {admin && member.role !== 'owner' ? (
                  <select
                    className="cgw-input"
                    aria-label={t('cloud.roleFor', { name: member.displayName })}
                    value={member.role}
                    onChange={(event) =>
                      void cloud
                        .setRole(workspace.id, member.userId, event.target.value)
                        .then(load, failed)
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(roleKey(r))}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{t(roleKey(member.role))}</span>
                )}
                {((admin && member.role !== 'owner') ||
                  (member.userId === account.id && member.role !== 'owner')) && (
                  <button
                    type="button"
                    className="cgw-button"
                    onClick={() =>
                      void cloud.removeMember(workspace.id, member.userId).then(load, failed)
                    }
                  >
                    {member.userId === account.id ? t('cloud.leave') : t('cloud.removeMember')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {admin && (
            <form
              className="cgw-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const to = email.trim();
                if (!to) return;
                void cloud.invite(workspace.id, to, role).then(() => {
                  setEmail('');
                  setMessage(t('cloud.inviteSent', { email: to }));
                  load();
                }, failed);
              }}
            >
              <label htmlFor="cgw-invite-email">{t('cloud.inviteEmail')}</label>
              <input
                id="cgw-invite-email"
                className="cgw-input"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label htmlFor="cgw-invite-role">{t('cloud.inviteRole')}</label>
              <select
                id="cgw-invite-role"
                className="cgw-input"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(roleKey(r))}
                  </option>
                ))}
              </select>
              <button type="submit" className="cgw-button is-primary">
                {t('cloud.invite')}
              </button>
            </form>
          )}
          {message && (
            <p role="status" className="cgw-muted">
              {message}
            </p>
          )}
          {admin && invites.length > 0 && (
            <>
              <h3>{t('cloud.pendingInvites')}</h3>
              <ul className="cgw-list">
                {invites.map((invite) => (
                  <li key={invite.id} className="cgw-list-row">
                    <span>
                      {invite.email} · {t(roleKey(invite.role))}
                    </span>
                    <button
                      type="button"
                      className="cgw-button"
                      onClick={() =>
                        void cloud.revokeInvite(workspace.id, invite.id).then(load, failed)
                      }
                    >
                      {t('cloud.revokeInvite')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** `#/invite/{token}`: accept once signed in with the invited address. */
export function InviteView({
  cloud,
  session,
  token,
}: {
  cloud: Cloud;
  session: WorkspaceSession;
  token: string;
}) {
  const { t } = useTranslation();
  const account = useAccount(cloud);
  const [state, setState] = useState<
    { kind: 'idle' | 'busy' | 'failed' } | { kind: 'done'; name: string }
  >({ kind: 'idle' });
  const accept = () => {
    setState({ kind: 'busy' });
    cloud.acceptInvite(token).then(
      async (workspace) => {
        await cloud.engine.syncOnce().catch(() => undefined);
        await session.reloadMirror();
        if (session.mirror.workspaces.has(workspace.id)) session.switchTo(workspace.id);
        setState({ kind: 'done', name: workspace.name });
      },
      () => setState({ kind: 'failed' }),
    );
  };
  return (
    <section className="cgw-empty" aria-labelledby="cgw-invite-title">
      <h1 id="cgw-invite-title">{t('cloud.inviteTitle')}</h1>
      {state.kind === 'done' ? (
        <p role="status">{t('cloud.inviteAccepted', { name: state.name })}</p>
      ) : state.kind === 'failed' ? (
        <p role="alert">{t('cloud.inviteFailed')}</p>
      ) : !account ? (
        <>
          <p>{t('cloud.inviteSignIn')}</p>
          <button
            type="button"
            className="cgw-button is-primary"
            onClick={() => void cloud.signIn(language())}
          >
            {t('cloud.signIn')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={state.kind === 'busy'}
          onClick={accept}
        >
          {t('cloud.inviteAccept')}
        </button>
      )}
    </section>
  );
}
