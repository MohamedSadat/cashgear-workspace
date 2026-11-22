// Page sharing (M2.6): who may open the page and at what level, whether it is restricted to the
// people listed, and view links. The server decides access on every request; this dialog only
// shows and asks (ARCHITECTURE.md: hiding a control is never the check). Phase 9: for someone with
// full access, a second view of the dialog, "Publish to the web" (PublishSection.tsx).
//
// Phase 11: groups beside people. The list is read with the groups' rows (`?principals=group`) and
// saved with `principals: ["group"]`, so its group entries replace the page's group rows; one
// picker offers the workspace, the groups (with their number of people) and the people
// (principals.tsx). For a guest (never told of groups) the list and the picker hold no group, and
// their save says nothing of groups, so the server keeps every group row as it is.
import { CgCheckBox } from '@cashgear/ui';
import { SyncHttpError, type Id, type PageRecord } from '@cgw/workspace';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { Cloud } from './cloud';
import {
  EntryList,
  PrincipalPicker,
  candidatesOf,
  entriesIn,
  entriesOf,
  entryFor,
  groupChoices,
  refusalOf,
  withoutGroups,
  type Entry,
  type GroupChoice,
  type Level,
  type Person,
} from './principals';
import { publishingApi } from './publishing';

/** The publish view, loaded when it is first shown (not with the app: Phase 1's initial budget). */
const PublishSection = lazy(() =>
  import('./PublishSection').then((m) => ({ default: m.PublishSection })),
);

interface Link {
  id: Id;
  expiresAt: string | null;
}

/** What the dialog needs of the cloud (a fake in tests). */
export type ShareCloud = Pick<
  Cloud,
  | 'permissions'
  | 'setPermissions'
  | 'members'
  | 'groups'
  | 'knowsGroups'
  | 'shareLinks'
  | 'createShareLink'
  | 'revokeShareLink'
  | 'shareUrl'
  | 'api'
> &
  Partial<Pick<Cloud, 'onPublishing'>>;

const codeOf = (error: unknown) => (error instanceof SyncHttpError ? error.code : 'server.error');

export function ShareDialog({
  cloud,
  page,
  onClose,
}: {
  cloud: ShareCloud;
  page: PageRecord;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [mine, setMine] = useState<Level>('view');
  const [members, setMembers] = useState<Person[]>([]);
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const full = mine === 'full';
  const publishing = useMemo(() => publishingApi(cloud.api), [cloud]);
  // Phase 14: the feed's publishing changes for this page's workspace.
  const publishingChanges = useMemo(
    () =>
      cloud.onPublishing
        ? (listener: (pageIds: Id[] | null) => void) =>
            cloud.onPublishing!((workspaceId, pageIds) => {
              if (workspaceId === page.workspaceId) listener(pageIds);
            })
        : undefined,
    [cloud, page.workspaceId],
  );
  const canPublish = full && page.kind !== 'row';
  const [view, setView] = useState<'share' | 'publish'>('share');
  const shown = canPublish ? view : 'share';
  // Members, admins and owners are told of groups; a guest never is (nor asks: the route refuses).
  const knowsGroups = cloud.knowsGroups(page.workspaceId);
  const everyone = t('share.everyone');

  useEffect(() => {
    let live = true;
    void cloud.permissions(page.id, knowsGroups).then(
      (answer) => {
        if (!live) return;
        setRestricted(answer.restricted);
        setMine(answer.yourLevel as Level);
        setEntries(entriesOf(answer.entries, everyone, knowsGroups));
        if (answer.yourLevel === 'full')
          void cloud.shareLinks(page.id).then(
            (list) =>
              live && setLinks(list.map((l) => ({ id: l.id, expiresAt: l.expiresAt ?? null }))),
            () => undefined,
          );
      },
      () => live && setMessage(t('cloud.requestFailed')),
    );
    void cloud.members(page.workspaceId).then(
      (list) => live && setMembers(list),
      () => undefined,
    );
    if (knowsGroups)
      void cloud.groups(page.workspaceId).then(
        (answer) => live && setGroups(groupChoices(answer.groups)),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [cloud, page.id, page.workspaceId, knowsGroups, everyone, t]);

  const save = () =>
    void cloud
      .setPermissions(page.id, { restricted, entries: entriesIn(entries ?? []) }, knowsGroups)
      .then(
        () => setMessage(t('share.saved')),
        (error: unknown) =>
          void refusalOf(codeOf(error), knowsGroups, entries ?? [], async () =>
            groupChoices((await cloud.groups(page.workspaceId)).groups),
          ).then((refusal) => {
            if (refusal.groups) setGroups(refusal.groups);
            const drop = refusal.drop;
            if (drop) setEntries((list) => withoutGroups(list ?? [], drop));
            setMessage(t(refusal.message));
          }),
      );

  const candidates = candidatesOf(entries ?? [], members, groups, page.workspaceId, everyone);

  return (
    <Dialog title={t('share.title', { title: page.title || t('page.untitled') })} onClose={onClose}>
      {canPublish && (
        <div role="group" aria-label={t('publish.views')} className="cgw-share-views">
          <button
            type="button"
            className={`cgw-button${shown === 'share' ? ' is-primary' : ''}`}
            aria-pressed={shown === 'share'}
            onClick={() => setView('share')}
          >
            {t('publish.viewShare')}
          </button>
          <button
            type="button"
            className={`cgw-button${shown === 'publish' ? ' is-primary' : ''}`}
            aria-pressed={shown === 'publish'}
            data-testid="publish-view"
            onClick={() => setView('publish')}
          >
            {t('publish.viewPublish')}
          </button>
        </div>
      )}
      {shown === 'publish' && (
        <div className="cgw-publish-scroll">
          <Suspense fallback={<p aria-busy="true">{t('app.loading')}</p>}>
            <PublishSection api={publishing} page={page} changes={publishingChanges} />
          </Suspense>
        </div>
      )}
      {shown === 'share' && (
        <>
          {!full && entries && <p className="cgw-muted">{t('share.readOnly')}</p>}
          <CgCheckBox
            label={t('share.restricted')}
            checked={restricted}
            disabled={!full}
            onCheckedChange={(checked) => setRestricted(checked === true)}
          />
          <EntryList
            entries={entries ?? []}
            full={full}
            testId="share-entries"
            onLevel={(index, level) =>
              setEntries((list) => list!.map((x, j) => (j === index ? { ...x, level } : x)))
            }
            onRemove={(index) => setEntries((list) => list!.filter((_, j) => j !== index))}
          />
          {full && (
            <PrincipalPicker
              id="cgw-share-person"
              candidates={candidates}
              onAdd={(candidate) => setEntries((list) => [...(list ?? []), entryFor(candidate)])}
            />
          )}
          {full && (
            <section aria-labelledby="cgw-share-links">
              <h3 id="cgw-share-links">{t('share.links')}</h3>
              <p className="cgw-muted">{t('share.linkNote')}</p>
              <ul className="cgw-list">
                {links.map((l) => (
                  <li key={l.id} className="cgw-list-row">
                    <span>
                      {l.expiresAt
                        ? t('share.expires', { when: format.format(new Date(l.expiresAt)) })
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="cgw-button"
                      onClick={() =>
                        void cloud
                          .revokeShareLink(page.id, l.id)
                          .then(() => setLinks((list) => list.filter((x) => x.id !== l.id)))
                      }
                    >
                      {t('share.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
              {made && (
                <div className="cgw-inline-form" role="status">
                  <span className="cgw-share-link" data-testid="share-link">
                    {made}
                  </span>
                  <button
                    type="button"
                    className="cgw-button"
                    onClick={() =>
                      void navigator.clipboard?.writeText(made).then(() => setCopied(true))
                    }
                  >
                    {copied ? t('share.copied') : t('share.copy')}
                  </button>
                  <p className="cgw-muted">{t('share.linkCreated')}</p>
                </div>
              )}
              <button
                type="button"
                className="cgw-button"
                onClick={() =>
                  void cloud.createShareLink(page.id).then((link) => {
                    setMade(cloud.shareUrl(link.token));
                    setCopied(false);
                    setLinks((list) => [
                      ...list,
                      { id: link.id, expiresAt: link.expiresAt ?? null },
                    ]);
                  })
                }
              >
                {t('share.createLink')}
              </button>
            </section>
          )}
          {message && (
            <p role="status" className="cgw-muted">
              {message}
            </p>
          )}
        </>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('frame.close')}
        </button>
        {full && shown === 'share' && (
          <button type="button" className="cgw-button is-primary" onClick={save}>
            {t('share.save')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
