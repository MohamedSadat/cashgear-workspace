// A cell as it is shown (not edited), for every property type. Plain elements and no hooks of its
// own, so a table can draw hundreds of them per frame; the one control is the checkbox.
import { CgCheckBox } from '@cashgear/ui';
import type { RowRecord } from '@cgw/workspace';
import type { MouseEvent, ReactNode } from 'react';
import type { CellValue, DateValue, PropertyDef } from '../core';
import type { DbKey } from '../i18n';
import {
  formatDatePart,
  formatNumber,
  isCellError,
  isDateValue,
  optionById,
  readCell,
  valueText,
} from '../model/format';
import { linkFor } from '../model/links';
import type { CellEnv } from './env';

const stop = (event: MouseEvent) => event.stopPropagation();

/** A date or a span as the interface writes it (the span's arrow follows the language). */
export function dateText(value: DateValue, env: CellEnv): string {
  const start = formatDatePart(value.start, env.locale);
  return value.end
    ? env.t('date.range', { start, end: formatDatePart(value.end, env.locale) })
    : start;
}

/** The catalogue key of a formula or rollup error's message. */
export function errorKey(code: string): DbKey {
  switch (code) {
    case 'formula.syntax':
    case 'formula.unknownProperty':
    case 'formula.unknownFunction':
    case 'formula.type':
    case 'formula.arity':
    case 'formula.cycle':
    case 'formula.divideByZero':
    case 'formula.range':
      return `formula.errors.${code.slice('formula.'.length) as 'syntax'}`;
    default:
      return 'formula.errors.other';
  }
}

export function OptionChip({ name, colour }: { name: string; colour: string }) {
  return (
    <span className="cgw-chip" data-colour={colour} dir="auto">
      {name}
    </span>
  );
}

/** Two letters for a person without a picture. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? '') : '';
  return (first + second).toLocaleUpperCase();
}

export function PersonChip({ id, env }: { id: string; env: CellEnv }) {
  const person = env.people.get(id);
  const name = person?.name ?? env.t('person.unknown');
  return (
    <span className="cgw-person" title={person?.email ?? undefined}>
      {person?.avatarUrl ? (
        <img className="cgw-avatar" src={person.avatarUrl} alt="" aria-hidden="true" />
      ) : (
        <span className="cgw-avatar" aria-hidden="true">
          {initials(name)}
        </span>
      )}
      <span className="cgw-person-name" dir="auto">
        {name}
      </span>
    </span>
  );
}

function Links({ def, text, env }: { def: PropertyDef; text: string; env: CellEnv }) {
  const href = linkFor(def.type, text);
  if (!href)
    return (
      <span className="cgw-cell-text" dir="ltr" title={env.t('cell.unsafeLink')}>
        {text}
      </span>
    );
  return (
    <a
      className="cgw-cell-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      tabIndex={-1}
      dir="ltr"
      onMouseDown={stop}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        env.openLink(href);
      }}
    >
      {text}
    </a>
  );
}

function ErrorText({ code, env }: { code: string; env: CellEnv }) {
  const message = env.t(errorKey(code));
  return (
    <span className="cgw-cell-error" title={message} role="note">
      <span aria-hidden="true">⚠ </span>
      {message}
    </span>
  );
}

/** A formula's or rollup's result, by what it is. */
function Computed({ def, value, env }: { def: PropertyDef; value: CellValue; env: CellEnv }) {
  if (value === null) return null;
  if (isCellError(value)) return <ErrorText code={value.error} env={env} />;
  if (typeof value === 'number')
    return <span className="cgw-cell-number">{formatNumber(value, def, env.locale)}</span>;
  if (typeof value === 'boolean')
    return (
      <span
        className="cgw-cell-bool"
        data-checked={value}
        role="img"
        aria-label={value ? env.t('cell.checked') : env.t('cell.unchecked')}
      >
        {value ? '✓' : ''}
      </span>
    );
  if (isDateValue(value)) return <span className="cgw-cell-text">{dateText(value, env)}</span>;
  if (Array.isArray(value))
    return (
      <span className="cgw-chips">
        {value.map((item, i) => (
          <span key={i} className="cgw-chip" data-colour="default" dir="auto">
            {item}
          </span>
        ))}
      </span>
    );
  return (
    <span className="cgw-cell-text" dir="auto">
      {valueText(value, env.lookups)}
    </span>
  );
}

/** What a cell shows; null when it is empty. */
export function renderCell(def: PropertyDef, row: RowRecord, env: CellEnv): ReactNode {
  if (def.type === 'checkbox') {
    const checked = row.values[def.id] === true;
    return (
      <CgCheckBox
        className="cgw-cell-check"
        checked={checked}
        readOnly={!env.editable}
        tabIndex={-1}
        aria-label={def.name}
        onMouseDown={stop}
        onClick={stop}
        onCheckedChange={(next) => void env.actions.setValue(row, def, next === true)}
      />
    );
  }
  const value = readCell(row, def);
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'title':
    case 'text':
      return typeof value === 'string' ? (
        <span className="cgw-cell-text" dir="auto">
          {value}
        </span>
      ) : null;
    case 'number':
      return typeof value === 'number' ? (
        <span className="cgw-cell-number">{formatNumber(value, def, env.locale)}</span>
      ) : null;
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return isDateValue(value) ? (
        <span className="cgw-cell-text">{dateText(value, env)}</span>
      ) : null;
    case 'select':
    case 'status': {
      const option = optionById(def, value);
      return option ? <OptionChip name={option.name} colour={option.colour} /> : null;
    }
    case 'multiSelect':
      return Array.isArray(value) ? (
        <span className="cgw-chips">
          {value.map((id) => {
            const option = optionById(def, id);
            return option ? (
              <OptionChip key={id} name={option.name} colour={option.colour} />
            ) : null;
          })}
        </span>
      ) : null;
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return Array.isArray(value) ? (
        <span className="cgw-chips">
          {value.map((id) => (
            <PersonChip key={id} id={id} env={env} />
          ))}
        </span>
      ) : null;
    case 'url':
    case 'email':
    case 'phone':
      return typeof value === 'string' ? <Links def={def} text={value} env={env} /> : null;
    case 'files':
      return Array.isArray(value) ? (
        <span className="cgw-chips">
          {value.map((id) => {
            const name = env.host.assets?.info(id)?.fileName ?? env.t('files.unknown');
            return (
              <button
                key={id}
                type="button"
                className="cgw-file-chip"
                tabIndex={-1}
                dir="auto"
                aria-label={env.t('files.open', { name })}
                onMouseDown={stop}
                onClick={(event) => {
                  event.stopPropagation();
                  env.host.assets?.open(id);
                }}
              >
                {name}
              </button>
            );
          })}
        </span>
      ) : null;
    case 'relation':
      return Array.isArray(value) ? (
        <span className="cgw-chips">
          {value.map((id) => {
            const title = env.host.pageTitle(id);
            const name = title || (title === '' ? env.t('untitled') : env.t('relation.unknown'));
            return (
              <button
                key={id}
                type="button"
                className="cgw-relation-chip"
                tabIndex={-1}
                dir="auto"
                aria-label={env.t('cell.openRow', { title: name })}
                onMouseDown={stop}
                onClick={(event) => {
                  event.stopPropagation();
                  env.host.openRow(id);
                }}
              >
                <span aria-hidden="true">↗ </span>
                {name}
              </button>
            );
          })}
        </span>
      ) : null;
    case 'formula':
    case 'rollup':
      return <Computed def={def} value={value} env={env} />;
    default:
      return null;
  }
}
