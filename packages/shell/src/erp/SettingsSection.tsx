// The settings frame's "Cash Gear ERP" section: `ErpSettings` over the tab's ERP services, for a
// workspace kept on the account. Owners and admins see "Unlink"; the server decides it again.
import type { ErpSettingsHost } from '@cgw/erp';
import { lazy, Suspense, useMemo } from 'react';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import type { WorkspaceSession } from '../session';
import { useErpServices } from './host';

const ErpSettings = lazy(() => import('@cgw/erp/view').then((m) => ({ default: m.ErpSettings })));

export function ErpSettingsSection({ session }: { session: WorkspaceSession }) {
  const { platform } = useShell();
  const services = useErpServices(session);
  const account = useAccount(useCloud());
  const workspace = session.current;
  const canManage = workspace?.role === 'owner' || workspace?.role === 'admin';
  const host = useMemo<ErpSettingsHost | null>(
    () =>
      services
        ? {
            canManage,
            connection: services,
            sessions: services.sessions(),
            unlink: (link) => services.unlink(link),
            openErp: () => void platform.openExternal(platform.erp!.clientOrigin),
          }
        : null,
    [services, canManage, platform],
  );
  if (!host || !account || !workspace || workspace.localOnly) return null;
  return (
    <Suspense fallback={null}>
      <ErpSettings host={host} />
    </Suspense>
  );
}
