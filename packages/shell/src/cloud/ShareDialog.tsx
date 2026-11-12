// Page sharing (M2.6): who may open the page and at what level, whether it is restricted to the
// people listed, and view links. The server decides access on every request; this dialog only
// shows and asks (ARCHITECTURE.md: hiding a control is never the check).
import type { Id, PageRecord } from '@cgw/workspace';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { Cloud } from './cloud';

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

interface Link {
  id: Id;
  expiresAt: string | null;
}

export function ShareDialog({
  cloud,
  page,
  onClose,
}: {
  cloud: Cloud;
  page: PageRecord;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [mine, setMine] = useState<Level>('view');
  const [members, setMembers] = useState<{ userId: Id; displayName: string; email: string }[]>([]);
  const [adding, setAdding] = useState<Id | ''>('');
  const [links, setLinks] = useState<Link[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const full = mine === 'full';

  useEffect(() => {
    void cloud.permissions(page.id).then(
      (answer) => {
        setRestricted(answer.restricted);
        setMine(answer.yourLevel as Level);
        setEntries(
          answer.entries.map((e) => ({
            principalType: e.principalType === 'workspace' ? 'workspace' : 'user',
            principalId: e.principalId,
            level: e.level as Level,
            name:
              e.principalType === 'workspace'
                ? t('share.everyone')
                : (e.displayName ?? e.email ?? ''),
          })),
        );
        if (answer.yourLevel === 'full')
          void cloud.shareLinks(page.id).then(
            (list) => setLinks(list.map((l) => ({ id: l.id, expiresAt: l.expiresAt ?? null }))),
            () => undefined,
          );
      },
      () => setMessage(t('cloud.requestFailed')),
    );
    void cloud.members(page.workspaceId).then(setMembers, () => undefined);
  }, [cloud, page.id, page.workspaceId, t]);

  const save = () =>
    void cloud
      .setPermissions(page.id, {
        restricted,
        entries: (entries ?? []).map(({ principalType, principalId, level }) => ({
          principalType,
          principalId,
          level,
        })),
      })
      .then(
        () => setMessage(t('share.saved')),
        () => setMessage(t('cloud.requestFailed')),
      );

  const candidates = members.filter(
    (m) => !(entries ?? []).some((e) => e.principalType === 'user' && e.principalId === m.userId),
  );
  const everyone = (entries ?? []).some((e) => e.principalType === 'workspace');

  return (
    <Dialog title={t('share.title', { title: page.title || t('page.untitled') })} onClose={onClose}>
      {!full && entries && <p className="cgw-muted">{t('share.readOnly')}</p>}
      <label className="cgw-check">
        <input
          type="checkbox"
          checked={restricted}
          disabled={!full}
          onChange={(e) => setRestricted(e.target.checked)}
        />
        {t('share.restricted')}
      </label>
      <ul className="cgw-list cgw-share-entries" data-testid="share-entries">
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
          <label htmlFor="cgw-share-person">{t('share.person')}</label>
          <select
            id="cgw-share-person"
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
                      principalId: page.workspaceId,
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
                setLinks((list) => [...list, { id: link.id, expiresAt: link.expiresAt ?? null }]);
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
