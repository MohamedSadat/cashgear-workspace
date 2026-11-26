// Phase 19: what a page's view shows when its menu asks for Page setup, Export to Word, Print or
// Save as PDF, in a chunk of its own (the page's view holds only a state and its listeners, so the
// initial JavaScript gains next to nothing). It gathers what the export reads: the workspace's
// people for mentions, the database host, the cloud for files the device lacks, the platform.
import type { PageRecord, RowRecord } from '@cgw/workspace';
import { useTranslation } from 'react-i18next';
import { useCloud } from '../cloud/CloudUi';
import { collaborates, useCollab } from '../collab/context';
import { useShell } from '../context';
import { useDatabaseHost } from '../database/context';
import type { WorkspacePlatform } from '../platform';
import type { WorkspaceSession } from '../session';
import { OutDialog } from './OutDialog';
import { PageSetup } from './PageSetup';
import type { OutKind } from './run';

/** A page's address in the app, for a link in a Word file or a PDF. */
export function appAddress(platform: Pick<WorkspacePlatform, 'kind' | 'webBase'>, pageId: string) {
  if (platform.kind === 'web') return `${location.origin}${location.pathname}#/p/${pageId}`;
  return platform.webBase
    ? `${platform.webBase.replace(/\/+$/, '')}/#/p/${pageId}`
    : `cashgear-workspace://p/${pageId}`;
}

export default function PrintDialogs({
  session,
  page,
  editable,
  asked,
  onClose,
}: {
  session: WorkspaceSession;
  page: PageRecord | RowRecord;
  editable: boolean;
  asked: OutKind | 'setup';
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const { platform } = useShell();
  const databases = useDatabaseHost();
  const collab = useCollab();
  const cloud = useCloud();
  if (asked === 'setup')
    return (
      <PageSetup
        page={page}
        editable={editable}
        onSave={(layout) => session.updatePage(page.id, { layout })}
        onClose={onClose}
      />
    );
  const people =
    collab && collaborates(collab, session, page.workspaceId)
      ? collab.people(page.workspaceId)
      : null;
  return (
    <OutDialog
      deps={{
        session,
        i18n,
        databases: databases ?? null,
        personName: people ? people.name : undefined,
        address: (id) => appAddress(platform, id),
        cloud: cloud ?? null,
        platform,
      }}
      pageId={page.id}
      kind={asked}
      onClose={onClose}
    />
  );
}
