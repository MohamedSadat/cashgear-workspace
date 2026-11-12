// The cells edited in a flyout: date, select, multi-select, status, person, files and relation.
// The choice is held as a draft while the flyout is open and written as one `row.update` when it
// closes (a single select, or a day without a time, closes it at once); option changes are written
// to the property as they are made. Files write each upload and each removal.
import { normaliseText, type RowRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RELATION_LIMIT, type DateValue, type PropertyDef, type Value } from '../core';
import type { RowRef } from '../host';
import { isDateValue, readCell } from '../model/format';
import { DatePicker } from '../pickers/DatePicker';
import { FilesEditor } from '../pickers/FilesEditor';
import { ListPicker, type PickerItem } from '../pickers/ListPicker';
import { OptionPicker } from '../pickers/OptionPicker';
import { PersonChip } from './CellDisplay';
import { CellFlyout } from './CellFlyout';
import type { CellEnv } from './env';
import type { EditEnd } from './InlineEditor';

export interface PickerEditorProps {
  def: PropertyDef;
  row: RowRecord;
  env: CellEnv;
  anchor: HTMLElement;
  seed?: string | null;
  onDone(end: EditEnd): void;
}

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function PickerEditor({ def, row, env, anchor, seed, onDone }: PickerEditorProps) {
  const { t } = env;
  // The property as this flyout last changed it, until the host's copy catches up.
  const [localDef, setLocalDef] = useState(def);
  useEffect(() => setLocalDef(def), [def]);
  const draft = useRef<{ value: Value | null } | null>(null);
  const closed = useRef(false);

  const close = (end: EditEnd) => {
    if (closed.current) return;
    closed.current = true;
    if (draft.current && env.editable)
      void env.actions.setValue(row, localDef, draft.current.value);
    onDone(end);
  };
  const changeDef = (next: PropertyDef) => {
    setLocalDef(next);
    void env.actions.updateProperty(next);
  };

  let body: ReactNode = null;
  let width: number | string = 300;
  switch (def.type) {
    case 'select':
    case 'status':
    case 'multiSelect': {
      const multiple = def.type === 'multiSelect';
      body = (
        <OptionsBody
          def={localDef}
          initial={idsOf(multiple ? row.values[def.id] : [row.values[def.id]])}
          multiple={multiple}
          env={env}
          seed={seed}
          onDraft={(ids) => {
            draft.current = { value: multiple ? ids : (ids[0] ?? null) };
            if (!multiple) close('enter');
          }}
          onDefChange={changeDef}
        />
      );
      width = 320;
      break;
    }
    case 'date': {
      const value = readCell(row, def);
      body = (
        <DatePicker
          value={isDateValue(value) ? (value as DateValue) : null}
          includeTime={def.date?.includeTime === true}
          onChange={(next) => (draft.current = { value: next })}
          onDone={() => close('enter')}
        />
      );
      width = 'auto';
      break;
    }
    case 'person':
      body = (
        <PeopleBody
          initial={idsOf(row.values[def.id])}
          env={env}
          seed={seed}
          onDraft={(ids) => (draft.current = { value: ids })}
        />
      );
      break;
    case 'relation':
      body = (
        <RelationBody
          def={def}
          initial={idsOf(row.values[def.id])}
          env={env}
          seed={seed}
          onDraft={(ids) => (draft.current = { value: ids })}
        />
      );
      width = 340;
      break;
    case 'files':
      body = (
        <FilesBody
          initial={idsOf(row.values[def.id])}
          env={env}
          onWrite={(ids) => void env.actions.setValue(row, def, ids)}
        />
      );
      break;
  }

  return (
    <CellFlyout
      anchor={anchor}
      label={t('cell.edit', { name: def.name })}
      width={width}
      onClose={(reason) => close(reason === 'escape' ? 'escape' : 'blur')}
    >
      {body}
    </CellFlyout>
  );
}

function OptionsBody({
  def,
  initial,
  multiple,
  env,
  seed,
  onDraft,
  onDefChange,
}: {
  def: PropertyDef;
  initial: string[];
  multiple: boolean;
  env: CellEnv;
  seed?: string | null;
  onDraft(ids: string[]): void;
  onDefChange(def: PropertyDef): void;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <OptionPicker
      def={def}
      selected={selected}
      multiple={multiple}
      canManage={env.editable}
      seed={seed}
      onSelect={(ids) => {
        setSelected(ids);
        onDraft(ids);
      }}
      onDefChange={onDefChange}
    />
  );
}

function PeopleBody({
  initial,
  env,
  seed,
  onDraft,
}: {
  initial: string[];
  env: CellEnv;
  seed?: string | null;
  onDraft(ids: string[]): void;
}) {
  const { t } = env;
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState(seed ?? '');
  const items = useMemo<PickerItem[]>(() => {
    const q = normaliseText(query.trim());
    return [...env.people.values()]
      .filter((p) => !q || normaliseText(p.name).includes(q))
      .map((p) => ({ id: p.id, label: p.name, content: <PersonChip id={p.id} env={env} /> }));
  }, [env, query]);
  return (
    <ListPicker
      items={items}
      selected={selected}
      multiple
      onSelect={(ids) => {
        setSelected(ids);
        onDraft(ids);
      }}
      chip={(id) => ({
        label: env.people.get(id)?.name ?? t('person.unknown'),
        content: <PersonChip id={id} env={env} />,
      })}
      query={query}
      onQuery={setQuery}
      searchLabel={t('person.search')}
      emptyText={t('person.none')}
      listLabel={t('person.list')}
    />
  );
}

function RelationBody({
  def,
  initial,
  env,
  seed,
  onDraft,
}: {
  def: PropertyDef;
  initial: string[];
  env: CellEnv;
  seed?: string | null;
  onDraft(ids: string[]): void;
}) {
  const { t } = env;
  const target = def.relation?.databaseId ?? null;
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState(seed ?? '');
  const [results, setResults] = useState<RowRef[]>([]);
  const [loading, setLoading] = useState(Boolean(target));
  const titles = useRef(new Map<string, string>());

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(
      () => {
        env.host
          .searchRows(target, query, { limit: 25, signal: controller.signal })
          .then((rows) => {
            if (controller.signal.aborted) return;
            for (const r of rows) titles.current.set(r.id, r.title);
            setResults(rows);
            setLoading(false);
          })
          .catch(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [env.host, target, query]);

  const titleOf = (id: string) => {
    const title = env.host.pageTitle(id) ?? titles.current.get(id);
    return title === undefined ? t('relation.unknown') : title || t('untitled');
  };
  const items = results.map((r) => ({ id: r.id, label: r.title || t('untitled') }));
  return (
    <ListPicker
      items={items}
      selected={selected}
      multiple
      onSelect={(ids) => {
        const kept = ids.slice(0, RELATION_LIMIT);
        setSelected(kept);
        onDraft(kept);
      }}
      chip={(id) => ({ label: titleOf(id) })}
      query={query}
      onQuery={setQuery}
      searchLabel={t('relation.search')}
      emptyText={target ? t('relation.none') : t('relation.noTarget')}
      listLabel={t('relation.list')}
      loading={loading}
      note={selected.length >= RELATION_LIMIT ? t('relation.limit') : null}
    />
  );
}

function FilesBody({
  initial,
  env,
  onWrite,
}: {
  initial: string[];
  env: CellEnv;
  onWrite(ids: string[]): void;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <FilesEditor
      ids={ids}
      assets={env.host.assets}
      editable={env.editable}
      onChange={(next) => {
        setIds(next);
        onWrite(next);
      }}
    />
  );
}
