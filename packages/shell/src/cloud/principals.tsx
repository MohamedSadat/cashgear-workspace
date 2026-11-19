// Phase 11: who a page's or a workbook's access list names, and the one picker that adds to it:
// the workspace, its groups (by name, with their number of people and a group icon) and its
// people. The share dialog (ShareDialog.tsx) and a workbook's access (sheet/WorkbookPermissions.tsx)
// both draw their lists with it. Groups are shown only to those told of them (members, admins and
// owners): for a guest the lists and the picker hold none, and their save leaves the stored group
// rows to the server, which keeps them. The server decides every request; this only shows.
import { CgComboBox, CgIcon } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './groups.css';

export type Level = 'full' | 'edit' | 'comment' | 'view' | 'none';
export const LEVELS: readonly Level[] = ['full', 'edit', 'comment', 'view', 'none'];
export const levelKey = (level: string) =>
  level === 'full'
    ? 'share.levelFull'
    : level === 'edit'
      ? 'share.levelEdit'
      : level === 'comment'
        ? 'share.levelComment'
        : level === 'view'
          ? 'share.levelView'
          : 'share.levelNone';

const asLevel = (level: string): Level =>
  (LEVELS as readonly string[]).includes(level) ? (level as Level) : 'none';

export type PrincipalType = 'user' | 'workspace' | 'group';

/** One row of an access list, as drawn. */
export interface Entry {
  principalType: PrincipalType;
  principalId: Id;
  level: Level;
  name: string;
  /** A group's number of people; null for a person or the workspace. */
  peopleCount: number | null;
}

/** A row as the server sends it (a page's or a workbook's). */
export interface EntryDto {
  principalType: string;
  principalId: Id;
  level: string;
  displayName?: string | null;
  email?: string | null;
  peopleCount?: number | string | null;
}

/** Someone the picker offers (the workspace's members, guests among them: a page may name one). */
export interface Person {
  userId: Id;
  displayName: string;
  email: string;
}

/** A group the picker offers. */
export interface GroupChoice {
  id: Id;
  name: string;
  people: number;
}

/** One choice of the picker. */
export interface Candidate {
  type: PrincipalType;
  id: Id;
  name: string;
  email: string | null;
  /** A group's number of people. */
  people: number | null;
}

const count = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === '' ? null : Number(value);

/**
 * The server's rows as drawn: the workspace named in the interface's words, a group by its name.
 * A group's row is left out for someone not told of groups (the server sends them none anyway);
 * a kind this build does not know is left out too, and the server keeps what it was not sent.
 */
export function entriesOf(rows: readonly EntryDto[], everyone: string, knowsGroups: boolean) {
  const entries: Entry[] = [];
  for (const row of rows) {
    const type = row.principalType;
    if (type !== 'user' && type !== 'workspace' && type !== 'group') continue;
    if (type === 'group' && !knowsGroups) continue;
    entries.push({
      principalType: type,
      principalId: row.principalId,
      level: asLevel(row.level),
      name: type === 'workspace' ? everyone : (row.displayName ?? row.email ?? ''),
      peopleCount: type === 'group' ? (count(row.peopleCount) ?? 0) : null,
    });
  }
  return entries;
}

/** The entries as the server takes them. */
export const entriesIn = (entries: readonly Entry[]) =>
  entries.map(({ principalType, principalId, level }) => ({ principalType, principalId, level }));

const keyOf = (type: PrincipalType, id: Id) => `${type}:${id}`;

/**
 * The picker's choices, one list: the workspace (when not listed yet), then the groups, then the
 * people, each not in the list yet, in the server's order (by name).
 */
export function candidatesOf(
  entries: readonly Entry[],
  people: readonly Person[],
  groups: readonly GroupChoice[],
  workspaceId: Id,
  everyone: string,
): Candidate[] {
  const listed = new Set(entries.map((e) => keyOf(e.principalType, e.principalId)));
  const out: Candidate[] = [];
  if (!entries.some((e) => e.principalType === 'workspace'))
    out.push({ type: 'workspace', id: workspaceId, name: everyone, email: null, people: null });
  for (const group of groups)
    if (!listed.has(keyOf('group', group.id)))
      out.push({
        type: 'group',
        id: group.id,
        name: group.name,
        email: null,
        people: group.people,
      });
  for (const person of people)
    if (!listed.has(keyOf('user', person.userId)))
      out.push({
        type: 'user',
        id: person.userId,
        name: person.displayName,
        email: person.email,
        people: null,
      });
  return out;
}

/** A chosen candidate as a new row of the list (at `view`, as a person added always was). */
export const entryFor = (candidate: Candidate): Entry => ({
  principalType: candidate.type,
  principalId: candidate.id,
  level: 'view',
  name: candidate.name,
  peopleCount: candidate.type === 'group' ? (candidate.people ?? 0) : null,
});

/** A group's icon, beside its name: it is named by the text beside it. */
export function GroupIcon() {
  return (
    <span className="cgw-principal-icon" aria-hidden="true">
      <CgIcon name="people" size={16} />
    </span>
  );
}

/** An access list's rows: name, a group's number of people, the level, and Remove (`full` only). */
export function EntryList({
  entries,
  full,
  onLevel,
  onRemove,
  testId,
}: {
  entries: readonly Entry[];
  full: boolean;
  onLevel: (index: number, level: Level) => void;
  onRemove: (index: number) => void;
  testId: string;
}) {
  const { t, i18n } = useTranslation();
  const numbers = new Intl.NumberFormat(i18n.language);
  return (
    <ul className="cgw-list cgw-share-entries" data-testid={testId}>
      {entries.map((entry, i) => (
        <li
          key={keyOf(entry.principalType, entry.principalId)}
          className="cgw-list-row"
          data-principal={entry.principalType}
          data-principal-id={entry.principalId}
        >
          <span className="cgw-principal">
            {entry.principalType === 'group' && <GroupIcon />}
            <span className="cgw-principal-name">{entry.name}</span>
            {entry.principalType === 'group' && (
              <span className="cgw-muted">
                {t('share.groupPeople', { number: numbers.format(entry.peopleCount ?? 0) })}
              </span>
            )}
          </span>
          <select
            className="cgw-input"
            aria-label={t('share.levelFor', { name: entry.name })}
            value={entry.level}
            disabled={!full}
            onChange={(e) => onLevel(i, e.target.value as Level)}
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(levelKey(level))}
              </option>
            ))}
          </select>
          {full && (
            <button type="button" className="cgw-button" onClick={() => onRemove(i)}>
              {t('share.remove')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One choice in the picker's list: a group with its icon and number of people, a person's address. */
function CandidateOption({ candidate }: { candidate: Candidate }) {
  const { t, i18n } = useTranslation();
  const detail =
    candidate.type === 'group'
      ? t('share.groupPeople', {
          number: new Intl.NumberFormat(i18n.language).format(candidate.people ?? 0),
        })
      : candidate.email;
  return (
    <span className="cgw-principal" data-principal={candidate.type}>
      {candidate.type === 'group' && <GroupIcon />}
      <span className="cgw-principal-name">{candidate.name}</span>
      {detail && (
        <span className="cgw-principal-detail" dir={candidate.type === 'user' ? 'ltr' : undefined}>
          {detail}
        </span>
      )}
    </span>
  );
}

/**
 * The one picker of the workspace, groups and people, searched by name or address, and its Add.
 * Escape closes an open list without closing the dialog around it.
 */
export function PrincipalPicker({
  id,
  candidates,
  onAdd,
}: {
  id: string;
  candidates: readonly Candidate[];
  onAdd: (candidate: Candidate) => void;
}) {
  const { t, i18n } = useTranslation();
  const [choice, setChoice] = useState<Candidate | null>(null);
  // A choice no longer offered (it was added meanwhile) is no choice.
  const chosen =
    choice && candidates.some((c) => c.type === choice.type && c.id === choice.id) ? choice : null;
  return (
    <div className="cgw-inline-form">
      <label htmlFor={id}>{t('share.personOrGroup')}</label>
      <div className="cgw-principal-picker">
        <CgComboBox<Candidate>
          id={id}
          fullWidth
          options={candidates}
          value={chosen}
          onValueChange={setChoice}
          getOptionKey={(c) => keyOf(c.type, c.id)}
          getOptionLabel={(c) => (c.email ? `${c.name} (${c.email})` : c.name)}
          getOptionSearchText={(c) => `${c.name} ${c.email ?? ''}`}
          renderOption={({ option }) => <CandidateOption candidate={option} />}
          locale={i18n.language}
          emptyMessage={t('share.noMatch')}
          refineSearchMessage={t('share.refine')}
          clearAriaLabel={t('share.clearChoice')}
          toggleAriaLabel={t('share.showChoices')}
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' &&
              event.currentTarget.getAttribute('aria-expanded') === 'true'
            )
              event.stopPropagation();
          }}
        />
      </div>
      <button
        type="button"
        className="cgw-button"
        disabled={!chosen}
        onClick={() => {
          if (!chosen) return;
          onAdd(chosen);
          setChoice(null);
        }}
      >
        {t('share.add')}
      </button>
    </div>
  );
}

/** The groups as the picker offers them, from the server's list. */
export const groupChoices = (
  groups: readonly { id: Id; name: string; people: readonly unknown[] }[],
): GroupChoice[] => groups.map((g) => ({ id: g.id, name: g.name, people: g.people.length }));

/** What a refused save says, and what changes with it. */
export interface Refusal {
  message: 'share.readOnly' | 'share.groupGone' | 'errors.conflict' | 'cloud.requestFailed';
  /** The groups as read again. */
  groups?: GroupChoice[];
  /** The groups to take out of the list: deleted meanwhile. */
  drop?: ReadonlySet<Id>;
}

/**
 * A refused save, by the server's code: someone without full access is told so; a list naming a
 * group deleted meanwhile (400 `request.invalid`) has the groups read again, and any that is gone
 * leaves the list, so the person can save again.
 */
export async function refusalOf(
  code: string,
  knowsGroups: boolean,
  entries: readonly Entry[],
  readGroups: () => Promise<GroupChoice[]>,
): Promise<Refusal> {
  if (code === 'access.denied') return { message: 'share.readOnly' };
  if (code === 'version.conflict') return { message: 'errors.conflict' };
  if (code !== 'request.invalid' || !knowsGroups) return { message: 'cloud.requestFailed' };
  let groups: GroupChoice[];
  try {
    groups = await readGroups();
  } catch {
    return { message: 'cloud.requestFailed' };
  }
  const known = new Set(groups.map((g) => g.id));
  const drop = new Set(
    entries
      .filter((e) => e.principalType === 'group' && !known.has(e.principalId))
      .map((e) => e.principalId),
  );
  return drop.size
    ? { message: 'share.groupGone', groups, drop }
    : { message: 'cloud.requestFailed', groups };
}

/** The list without the groups named. */
export const withoutGroups = (entries: readonly Entry[], drop: ReadonlySet<Id>) =>
  entries.filter((e) => !(e.principalType === 'group' && drop.has(e.principalId)));
