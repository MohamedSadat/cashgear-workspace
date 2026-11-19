// A workbook's own access list (decisions, 2026-11-14: Phase 5): the pages' rules, levels and
// people, drawn with the share dialog's parts and words (cloud/ShareDialog.tsx) but no share
// links: a workbook is never shared outside its workspace. Entries are shown to `full` only, and
// only `full` changes them; the server decides every request.
//
// Phase 11: groups beside people, as in the share dialog (cloud/principals.tsx): the list read with
// the groups' rows and saved with `principals: ["group"]`, one picker of the workspace, the groups
// and the people; for a guest no group at all, and their save leaves the group rows to the server.
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
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
} from '../cloud/principals';
import { Dialog } from '../Dialog';
import { failureCode, workbookApi, type Workbook } from './api';

/** What the dialog needs of the cloud (a fake in tests). */
export type WorkbookAccessCloud = Pick<Cloud, 'api' | 'members' | 'groups' | 'knowsGroups'>;

export function WorkbookPermissions({
  cloud,
  workspaceId,
  workbook,
  onClose,
}: {
  cloud: WorkbookAccessCloud;
  workspaceId: Id;
  workbook: Workbook;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useMemo(() => workbookApi(cloud.api), [cloud]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [mine, setMine] = useState<Level>('view');
  const [members, setMembers] = useState<Person[]>([]);
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const full = mine === 'full';
  const knowsGroups = cloud.knowsGroups(workspaceId);
  const everyone = t('share.everyone');

  useEffect(() => {
    let live = true;
    api.permissions(workbook.id, knowsGroups).then(
      (answer) => {
        if (!live) return;
        setRestricted(answer.restricted);
        setMine(answer.yourLevel as Level);
        setEntries(entriesOf(answer.entries, everyone, knowsGroups));
      },
      () => live && setMessage(t('cloud.requestFailed')),
    );
    void cloud.members(workspaceId).then(
      (list) => live && setMembers(list),
      () => undefined,
    );
    if (knowsGroups)
      void cloud.groups(workspaceId).then(
        (answer) => live && setGroups(groupChoices(answer.groups)),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [api, cloud, workbook.id, workspaceId, knowsGroups, everyone, t]);

  const save = () =>
    void api
      .setPermissions(workbook.id, { restricted, entries: entriesIn(entries ?? []) }, knowsGroups)
      .then(
        () => setMessage(t('share.saved')),
        (error: unknown) =>
          void refusalOf(failureCode(error), knowsGroups, entries ?? [], async () =>
            groupChoices((await cloud.groups(workspaceId)).groups),
          ).then((refusal) => {
            if (refusal.groups) setGroups(refusal.groups);
            const drop = refusal.drop;
            if (drop) setEntries((list) => withoutGroups(list ?? [], drop));
            setMessage(t(refusal.message));
          }),
      );

  const candidates = candidatesOf(entries ?? [], members, groups, workspaceId, everyone);

  return (
    <Dialog title={t('sheets.permissionsTitle', { name: workbook.name })} onClose={onClose}>
      <p className="cgw-muted">{t('sheets.permissionsNote')}</p>
      {!full && entries && <p className="cgw-muted">{t('share.readOnly')}</p>}
      <label className="cgw-workbook-choice">
        <input
          type="checkbox"
          checked={restricted}
          disabled={!full}
          onChange={(e) => setRestricted(e.target.checked)}
        />
        {t('sheets.restricted')}
      </label>
      <EntryList
        entries={entries ?? []}
        full={full}
        testId="workbook-entries"
        onLevel={(index, level) =>
          setEntries((list) => list!.map((x, j) => (j === index ? { ...x, level } : x)))
        }
        onRemove={(index) => setEntries((list) => list!.filter((_, j) => j !== index))}
      />
      {full && (
        <PrincipalPicker
          id="cgw-workbook-person"
          candidates={candidates}
          onAdd={(candidate) => setEntries((list) => [...(list ?? []), entryFor(candidate)])}
        />
      )}
      {message && (
        <p role="status" className="cgw-muted">
          {message}
        </p>
      )}
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('frame.close')}
        </button>
        {full && (
          <button type="button" className="cgw-button is-primary" onClick={save}>
            {t('share.save')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
