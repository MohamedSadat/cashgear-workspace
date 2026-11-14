// A workbook's own access list (decisions, 2026-11-14: Phase 5): the pages' rules, levels and
// people, drawn with the share dialog's parts and words (cloud/ShareDialog.tsx) but no share
// links: a workbook is never shared outside its workspace. Entries are shown to `full` only, and
// only `full` changes them; the server decides every request.
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import { Dialog } from '../Dialog';
import { failureCode, workbookApi, type Workbook } from './api';

type Level = 'full' | 'edit' | 'comment' | 'view' | 'none';
const LEVELS: Level[] = ['full', 'edit', 'comment', 'view', 'none'];
const levelKey = (level: string) =>
  level === 'full'
    ? 'share.levelFull'
    : level === 'edit'
      ? 'share.levelEdit'
      : level === 'comment'
        ? 'share.levelComment'
        : level === 'view'
          ? 'share.levelView'
          : 'share.levelNone';

interface Entry {
  principalType: 'user' | 'workspace';
  principalId: Id;
  level: Level;
  name: string;
}

export function WorkbookPermissions({
  cloud,
  workspaceId,
  workbook,
  onClose,
}: {
  cloud: Cloud;
  workspaceId: Id;
  workbook: Workbook;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useMemo(() => workbookApi(cloud.api), [cloud]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [mine, setMine] = useState<Level>('view');
  const [members, setMembers] = useState<{ userId: Id; displayName: string; email: string }[]>([]);
  const [adding, setAdding] = useState<Id | ''>('');
  const [message, setMessage] = useState<string | null>(null);
  const full = mine === 'full';

  useEffect(() => {
    let live = true;
    api.permissions(workbook.id).then(
      (answer) => {
        if (!live) return;
        setRestricted(answer.restricted);
        setMine(answer.yourLevel as Level);
        setEntries(
          answer.entries.map((e) => ({
            principalType: e.principalType,
            principalId: e.principalId,
            level: e.level as Level,
            name:
              e.principalType === 'workspace'
                ? t('share.everyone')
                : (e.displayName ?? e.email ?? ''),
          })),
        );
      },
      () => live && setMessage(t('cloud.requestFailed')),
    );
    void cloud.members(workspaceId).then(
      (list) => live && setMembers(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, cloud, workbook.id, workspaceId, t]);

  const save = () =>
    void api
      .setPermissions(workbook.id, {
        restricted,
        entries: (entries ?? []).map(({ principalType, principalId, level }) => ({
          principalType,
          principalId,
          level,
        })),
      })
      .then(
        () => setMessage(t('share.saved')),
        (error: unknown) =>
          setMessage(
            failureCode(error) === 'version.conflict'
              ? t('errors.conflict')
              : t('cloud.requestFailed'),
          ),
      );

  const candidates = members.filter(
    (m) => !(entries ?? []).some((e) => e.principalType === 'user' && e.principalId === m.userId),
  );
  const everyone = (entries ?? []).some((e) => e.principalType === 'workspace');

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
      <ul className="cgw-list cgw-share-entries" data-testid="workbook-entries">
        {(entries ?? []).map((entry, i) => (
          <li key={`${entry.principalType}:${entry.principalId}`} className="cgw-list-row">
            <span>{entry.name}</span>
            <select
              className="cgw-input"
              aria-label={t('share.levelFor', { name: entry.name })}
              value={entry.level}
              disabled={!full}
              onChange={(e) =>
                setEntries((list) =>
                  list!.map((x, j) => (j === i ? { ...x, level: e.target.value as Level } : x)),
                )
              }
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(levelKey(level))}
                </option>
              ))}
            </select>
            {full && (
              <button
                type="button"
                className="cgw-button"
                onClick={() => setEntries((list) => list!.filter((_, j) => j !== i))}
              >
                {t('share.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {full && (
        <div className="cgw-inline-form">
          <label htmlFor="cgw-workbook-person">{t('share.person')}</label>
          <select
            id="cgw-workbook-person"
            className="cgw-input"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="" />
            {!everyone && <option value="*">{t('share.everyone')}</option>}
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} ({m.email})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cgw-button"
            disabled={!adding}
            onClick={() => {
              const member = members.find((m) => m.userId === adding);
              setEntries((list) => [
                ...(list ?? []),
                adding === '*'
                  ? {
                      principalType: 'workspace',
                      principalId: workspaceId,
                      level: 'view',
                      name: t('share.everyone'),
                    }
                  : {
                      principalType: 'user',
                      principalId: adding as Id,
                      level: 'view',
                      name: member?.displayName ?? '',
                    },
              ]);
              setAdding('');
            }}
          >
            {t('share.add')}
          </button>
        </div>
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
