// Settings → Members → Groups (Phase 11, M11.1): a workspace's groups and their people. Owners and
// admins make, rename and delete a group (deleting asks first, saying how many people it holds and
// that pages and workbooks shared with it lose that access) and choose its people from the
// workspace's members, never its guests; members read the groups and who is in them; a guest sees
// nothing of groups and never asks. Loaded with Settings, not with the app. The server decides
// every request: a stale version (409 `version.conflict`) reads the groups again and says so, and
// each refusal has its own words. The feed has no group entity, so the list is read again whenever
// the members are (each sync status change while Settings is open).
import { CgCheckBox } from '@cashgear/ui';
import { SyncHttpError, type Id, type WorkspaceRecord } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { WorkspaceSession } from '../session';
import { useSection } from '../i18n/sections';
import type { Cloud } from './cloud';
import { groupsWords } from './groupsWords';
import { GroupIcon } from './principals';
import './groups.css';

/** What the section needs of the cloud (a fake in tests). */
export type GroupsApi = Pick<
  Cloud,
  'groups' | 'createGroup' | 'renameGroup' | 'setGroupPeople' | 'deleteGroup'
>;

/** A member as Settings lists them. */
export interface GroupMember {
  userId: Id;
  displayName: string;
  email: string;
  role: string;
}

/** A group as read. */
export interface Group {
  id: Id;
  name: string;
  version: number;
  people: { userId: Id; displayName: string; email: string | null }[];
}

type GroupDto = Awaited<ReturnType<Cloud['groups']>>['groups'][number];

export const groupOf = (dto: GroupDto): Group => ({
  id: dto.id,
  name: dto.name,
  version: Number(dto.version),
  people: dto.people.map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    email: p.email ?? null,
  })),
});

type Role = WorkspaceRecord['role'];

/** A refusal's words, by the server's code (`name` for the ones that name the group). */
export function refusalKey(code: string) {
  switch (code) {
    case 'access.denied':
      return 'groups.denied' as const;
    case 'request.invalid':
      return 'groups.invalid' as const;
    case 'conflict':
      return 'groups.nameTaken' as const;
    case 'version.conflict':
      return 'groups.stale' as const;
    case 'not.found':
      return 'groups.gone' as const;
    default:
      return 'cloud.requestFailed' as const;
  }
}

const codeOf = (error: unknown) => (error instanceof SyncHttpError ? error.code : 'server.error');

/** The section for the open workspace, inside Settings → Members (which lists its members). */
export function GroupsSection({
  cloud,
  session,
  members,
}: {
  cloud: GroupsApi;
  session: WorkspaceSession;
  members: readonly GroupMember[] | null;
}) {
  const workspace = session.current;
  if (!workspace || workspace.localOnly) return null;
  return (
    <GroupsSettings
      key={workspace.id}
      api={cloud}
      workspaceId={workspace.id}
      role={workspace.role}
      members={members}
    />
  );
}

interface Draft {
  /** The group being changed, or null for a new one. */
  id: Id | null;
  name: string;
  people: ReadonlySet<Id>;
}

export function GroupsSettings({
  api,
  workspaceId,
  role,
  members,
}: {
  api: GroupsApi;
  workspaceId: Id;
  role: Role;
  /** The workspace's members as Settings read them; null until read. */
  members: readonly GroupMember[] | null;
}) {
  // This screen's words come with it (i18n/sections.ts), before anything below reads them.
  useSection(groupsWords);
  const { t, i18n } = useTranslation();
  const told = role === 'owner' || role === 'admin' || role === 'member';
  const manages = role === 'owner' || role === 'admin';
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  // Who may be in a group: the members, admins and owners; never a guest.
  const eligible = useMemo(() => (members ?? []).filter((m) => m.role !== 'guest'), [members]);

  // Read when the section opens, and again with the members (and after each change made here).
  useEffect(() => {
    if (!told) return;
    let live = true;
    api.groups(workspaceId).then(
      (answer) => {
        if (!live) return;
        setGroups(answer.groups.map(groupOf));
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, told, members, reading]);

  if (!told) return null;
  const reload = () => setReading((n) => n + 1);
  const editing = draft?.id ? groups?.find((g) => g.id === draft.id) : undefined;
  const names = new Intl.ListFormat(i18n.language, { type: 'conjunction' });

  // The people to send: those chosen among the members as listed here, and those the group holds
  // already (the server's word; a list read a moment ago may not show someone added since).
  const chosen = (people: ReadonlySet<Id>, held: ReadonlySet<Id> = new Set()) => {
    const listed = new Set(eligible.map((m) => m.userId));
    return [
      ...eligible.filter((m) => people.has(m.userId)).map((m) => m.userId),
      ...[...people].filter((id) => !listed.has(id) && held.has(id)),
    ];
  };

  const refused = (error: unknown, name: string) => {
    const code = codeOf(error);
    setMessage(t(refusalKey(code), { name }));
    // A group changed or deleted meanwhile is read again and shown as it is now; so is the list
    // after a refusal of the role (it may have changed too).
    if (code === 'version.conflict' || code === 'not.found' || code === 'access.denied') {
      reload();
      if (draft?.id) setDraft(null);
    }
  };

  const create = async (next: Draft) => {
    const name = next.name.trim();
    setBusy(true);
    try {
      await api.createGroup(workspaceId, name, chosen(next.people));
      setDraft(null);
      setMessage(t('groups.created', { name }));
      reload();
    } catch (error) {
      refused(error, name);
    } finally {
      setBusy(false);
    }
  };

  const save = async (group: Group, next: Draft) => {
    const name = next.name.trim();
    setBusy(true);
    try {
      let version = group.version;
      if (name !== group.name)
        version = Number((await api.renameGroup(workspaceId, group.id, name, version)).version);
      const before = new Set(group.people.map((p) => p.userId));
      const people = chosen(next.people, before);
      if (people.length !== before.size || people.some((id) => !before.has(id)))
        await api.setGroupPeople(workspaceId, group.id, people, version);
      setDraft(null);
      setMessage(t('groups.saved', { name }));
      reload();
    } catch (error) {
      refused(error, codeOf(error) === 'conflict' ? name : group.name);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (group: Group) => {
    setBusy(true);
    try {
      await api.deleteGroup(workspaceId, group.id);
      setDeleting(null);
      if (draft?.id === group.id) setDraft(null);
      setMessage(t('groups.deleted', { name: group.name }));
      reload();
    } catch (error) {
      setDeleting(null);
      refused(error, group.name);
    } finally {
      setBusy(false);
    }
  };

  const form = (current: Draft, onSubmit: () => void, group?: Group) => (
    <GroupForm
      draft={current}
      eligible={eligible}
      group={group}
      busy={busy}
      onChange={setDraft}
      onSubmit={onSubmit}
      onCancel={() => setDraft(null)}
    />
  );

  return (
    <section
      className="cgw-groups"
      aria-labelledby="cgw-groups-title"
      data-testid="groups-settings"
    >
      <h3 id="cgw-groups-title">{t('groups.title')}</h3>
      <p className="cgw-muted">{t('groups.intro')}</p>
      {!manages && <p className="cgw-muted">{t('groups.readOnly')}</p>}
      {groups === null ? (
        failed && <p className="cgw-muted">{t('groups.loadFailed')}</p>
      ) : groups.length === 0 ? (
        <p className="cgw-muted">{t('groups.none')}</p>
      ) : (
        <ul className="cgw-list" data-testid="groups-list">
          {groups.map((group) => (
            <li key={group.id} className="cgw-groups-row" data-group-id={group.id}>
              <div className="cgw-groups-head">
                <span className="cgw-principal">
                  <GroupIcon />
                  <strong className="cgw-principal-name">{group.name}</strong>
                  <span className="cgw-muted">
                    {t('groups.people', { number: numbers.format(group.people.length) })}
                  </span>
                </span>
                {manages && draft?.id !== group.id && (
                  <>
                    <button
                      type="button"
                      className="cgw-button"
                      aria-label={t('groups.editLabel', { name: group.name })}
                      disabled={busy || members === null}
                      onClick={() =>
                        setDraft({
                          id: group.id,
                          name: group.name,
                          people: new Set(group.people.map((p) => p.userId)),
                        })
                      }
                    >
                      {t('groups.edit')}
                    </button>
                    <button
                      type="button"
                      className="cgw-button is-danger"
                      aria-label={t('groups.deleteLabel', { name: group.name })}
                      disabled={busy}
                      onClick={() => setDeleting(group)}
                    >
                      {t('groups.delete')}
                    </button>
                  </>
                )}
              </div>
              {manages && draft?.id === group.id && editing ? (
                form(draft, () => void save(editing, draft), editing)
              ) : (
                <p className="cgw-groups-names">
                  {group.people.length
                    ? names.format(group.people.map((p) => p.displayName))
                    : t('groups.nobody')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {manages &&
        (draft && draft.id === null ? (
          form(draft, () => void create(draft))
        ) : (
          <div>
            <button
              type="button"
              className="cgw-button"
              data-testid="group-new"
              disabled={busy || members === null}
              onClick={() => setDraft({ id: null, name: '', people: new Set() })}
            >
              {t('groups.new')}
            </button>
          </div>
        ))}
      {message && (
        <p role="status" className="cgw-muted" data-testid="groups-status">
          {message}
        </p>
      )}
      {deleting && (
        <Dialog
          role="alertdialog"
          title={t('groups.deleteTitle', { name: deleting.name })}
          onClose={() => setDeleting(null)}
        >
          <p>{t('groups.deleteBody', { number: numbers.format(deleting.people.length) })}</p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setDeleting(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void remove(deleting)}
            >
              {t('groups.deleteConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** A group's name and people, new or being changed. */
function GroupForm({
  draft,
  eligible,
  group,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  eligible: readonly GroupMember[];
  /** The group being changed; none for a new one. */
  group?: Group;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = group ? `cgw-group-${group.id}` : 'cgw-group-new';
  const name = draft.name.trim();
  return (
    <form
      className="cgw-groups-form"
      data-testid={group ? 'group-edit' : 'group-form'}
      onSubmit={(event) => {
        event.preventDefault();
        if (name && !busy) onSubmit();
      }}
    >
      <label htmlFor={`${id}-name`}>{t(group ? 'groups.name' : 'groups.newName')}</label>
      <input
        id={`${id}-name`}
        className="cgw-input"
        maxLength={100}
        autoComplete="off"
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <fieldset className="cgw-groups-choices">
        <legend>
          {group ? t('groups.peopleIn', { name: group.name }) : t('groups.newPeople')}
        </legend>
        {eligible.length === 0 && <p className="cgw-muted">{t('groups.noMembers')}</p>}
        {eligible.map((member) => (
          <CgCheckBox
            key={member.userId}
            label={member.displayName}
            description={<span dir="ltr">{member.email}</span>}
            checked={draft.people.has(member.userId)}
            onCheckedChange={(checked) => {
              const people = new Set(draft.people);
              if (checked === true) people.add(member.userId);
              else people.delete(member.userId);
              onChange({ ...draft, people });
            }}
          />
        ))}
      </fieldset>
      <div className="cgw-groups-buttons">
        <button type="submit" className="cgw-button is-primary" disabled={busy || !name}>
          {t(group ? 'share.save' : 'groups.create')}
        </button>
        <button type="button" className="cgw-button" onClick={onCancel}>
          {t('frame.cancel')}
        </button>
      </div>
    </form>
  );
}
