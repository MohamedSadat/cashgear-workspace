// What both first-party blocks draw around their content: a message, the database chooser, the
// header with the title and the settings button, and the live reads of a database and its view.
import { CgButton } from '@cashgear/ui';
import type { DatabaseHost } from '@cgw/database';
import type { DatabaseRecord, ViewRecord } from '@cgw/workspace';
import { useCallback, useId, useSyncExternalStore, type ReactNode } from 'react';
import { usePluginT } from '../i18n';
import type { PluginData } from '../types';

/** A live read from the host: drawn again when the host says something changed. */
export function useHostRead<T>(host: DatabaseHost, read: () => T): T {
  const subscribe = useCallback((listener: () => void) => host.subscribe(listener), [host]);
  return useSyncExternalStore(subscribe, read, read);
}

export interface DatabaseState {
  database: DatabaseRecord | null;
  view: ViewRecord | null;
  views: ViewRecord[];
  title: string;
  canEdit: boolean;
}

/** The database, the view the block names (or the first), its title and whether it may change. */
export function useDatabaseState(
  host: DatabaseHost,
  databaseId: string,
  viewId: string | null,
): DatabaseState {
  const database = useHostRead(host, () => host.database(databaseId));
  const views = useHostRead(host, () => host.views(databaseId));
  const title = useHostRead(host, () => host.pageTitle(databaseId)) ?? '';
  const canEdit = useHostRead(host, () => host.canEdit(databaseId));
  const view = views.find((v) => v.id === viewId) ?? views[0] ?? null;
  return { database, view, views, title, canEdit };
}

export function Message({
  text,
  busy,
  error,
  children,
}: {
  text: string;
  busy?: boolean;
  error?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="cgw-plugin-message"
      role={error ? 'alert' : 'status'}
      aria-busy={busy || undefined}
    >
      <span>{text}</span>
      {children}
    </div>
  );
}

/** "Choose a database" (the linked-view picker), or "No database chosen" for a reader. */
export function ChooseDatabase({
  editable,
  data,
  onChosen,
}: {
  editable: boolean;
  data: PluginData;
  onChosen(databaseId: string, viewId: string | null): void;
}) {
  const { t } = usePluginT();
  if (!editable || !data.pickDatabase) return <Message text={t('common.noDatabase')} />;
  return (
    <Message text={t('common.noDatabase')}>
      <CgButton
        appearance="outline"
        onClick={() =>
          void data.pickDatabase?.().then((ref) => ref && onChosen(ref.databaseId, ref.viewId))
        }
      >
        {t('common.chooseDatabase')}
      </CgButton>
    </Message>
  );
}

/** The block's head: its title, the read-only badge, and the settings button for an editor. */
export function BlockHead({
  title,
  editable,
  newer,
  settingsOpen,
  onSettings,
  onOpenDatabase,
}: {
  title: string;
  editable: boolean;
  newer: boolean;
  settingsOpen: boolean;
  onSettings(): void;
  onOpenDatabase?(): void;
}) {
  const { t } = usePluginT();
  return (
    <div className="cgw-plugin-head">
      {onOpenDatabase ? (
        <button type="button" className="cgw-plugin-title" onClick={onOpenDatabase}>
          <span dir="auto">{title}</span>
        </button>
      ) : (
        <span className="cgw-plugin-title" dir="auto">
          {title}
        </span>
      )}
      {newer ? (
        <span className="cgw-plugin-badge" title={t('common.newer')}>
          {t('common.readOnly')}
        </span>
      ) : null}
      {editable ? (
        <CgButton
          appearance="ghost"
          aria-expanded={settingsOpen}
          className="cgw-plugin-settings-button"
          onClick={onSettings}
        >
          {settingsOpen ? t('common.done') : t('common.settings')}
        </CgButton>
      ) : null}
    </div>
  );
}

/**
 * A labelled native select, as the settings rows use. The label names the select by `for`, not by
 * wrapping it: a wrapping label's name takes in the chosen option ("Chart Bar").
 */
export function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="cgw-plugin-field">
      <label className="cgw-plugin-field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="cgw-plugin-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The view chooser and "Change database", shared by both blocks' settings. */
export function SourceRows({
  state,
  viewId,
  data,
  onView,
  onDatabase,
}: {
  state: DatabaseState;
  viewId: string | null;
  data: PluginData;
  onView(viewId: string | null): void;
  onDatabase(databaseId: string, viewId: string | null): void;
}) {
  const { t } = usePluginT();
  const FIRST = '';
  return (
    <>
      <SelectRow
        label={t('common.view')}
        value={viewId && state.views.some((v) => v.id === viewId) ? viewId : FIRST}
        options={[
          { value: FIRST, label: t('common.firstView') },
          ...state.views.map((v) => ({ value: v.id, label: v.name })),
        ]}
        onChange={(next) => onView(next === FIRST ? null : next)}
      />
      {data.pickDatabase ? (
        <div className="cgw-plugin-field">
          <CgButton
            appearance="outline"
            onClick={() =>
              void data
                .pickDatabase?.()
                .then((ref) => ref && onDatabase(ref.databaseId, ref.viewId))
            }
          >
            {t('common.changeDatabase')}
          </CgButton>
        </div>
      ) : null}
    </>
  );
}
