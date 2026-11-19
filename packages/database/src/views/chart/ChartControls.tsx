// A chart's settings controls: its kind, what it measures (a count, or a sum or an average of a
// number, formula or rollup property) and its title. The chart block's settings, moved here in
// Phase 12: the block draws them in its own settings box (its classes, its "Group by" between the
// kind and the measure), the chart view in its layout settings. Each change is told to the caller,
// which writes it.
import { useId, type ReactNode } from 'react';
import type { ChartMeasure, DatabaseRecord } from '../../core';
import { liveProperties } from '../../model/properties';
import { MEASURABLE } from './aggregate';
import { TITLE_LIMIT } from './config';
import { useChartT, type ChartCatalogue } from './words';

/** The classes the controls are drawn with. */
export interface ChartControlsLook {
  /** A box around each label and its control (the block's); absent: both in the flow (the view's). */
  field?: string;
  label: string;
  select: string;
  input: string;
}

/** The database views' own look (a layout settings flyout). */
export const VIEW_LOOK: ChartControlsLook = {
  label: 'cgw-label',
  select: 'cgw-select',
  input: 'cgw-text-input',
};

type Kind = keyof ChartCatalogue['kinds'];

export interface ChartControlsProps<K extends Kind> {
  database: DatabaseRecord;
  /** The kinds offered, in order (the view's bar, line and pie; the block's number too). */
  kinds: readonly K[];
  kind: K;
  measure: ChartMeasure;
  title: string | null;
  look?: ChartControlsLook;
  disabled?: boolean;
  /** The first control takes the focus when a flyout opens (`data-cg-initial-focus`). */
  initialFocus?: boolean;
  /** Drawn between the kind and the measure (the block's "Group by"). */
  between?: ReactNode;
  onKind(kind: K): void;
  onMeasure(measure: ChartMeasure): void;
  onTitle(title: string | null): void;
}

/** The properties a sum or an average can read, in database order. */
export const measurableProperties = (database: DatabaseRecord) =>
  liveProperties(database).filter((p) => (MEASURABLE as readonly string[]).includes(p.type));

/**
 * A label and its select, as the settings rows use. The label names the select by `for`, not by
 * wrapping it: a wrapping label's name takes in the chosen option ("Chart Bar").
 */
export function ChartSelect<T extends string>({
  look,
  label,
  value,
  options,
  onChange,
  disabled,
  initialFocus,
}: {
  look: ChartControlsLook;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
  initialFocus?: boolean;
}) {
  const id = useId();
  const body = (
    <>
      <label className={look.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={look.select}
        value={value}
        disabled={disabled}
        data-cg-initial-focus={initialFocus ? '' : undefined}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
  return look.field ? <div className={look.field}>{body}</div> : body;
}

export function ChartControls<K extends Kind>({
  database,
  kinds,
  kind,
  measure,
  title,
  look = VIEW_LOOK,
  disabled,
  initialFocus,
  between,
  onKind,
  onMeasure,
  onTitle,
}: ChartControlsProps<K>) {
  const { t: ct } = useChartT();
  const titleId = useId();
  const numbers = measurableProperties(database);
  const titleField = (
    <>
      <label className={look.label} htmlFor={titleId}>
        {ct('title')}
      </label>
      <input
        id={titleId}
        className={look.input}
        dir="auto"
        defaultValue={title ?? ''}
        placeholder={ct('titlePlaceholder')}
        maxLength={TITLE_LIMIT}
        disabled={disabled}
        onBlur={(event) => {
          const next = event.target.value.trim() || null;
          if (next !== title) onTitle(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
    </>
  );
  return (
    <>
      <ChartSelect
        look={look}
        label={ct('kind')}
        value={kind}
        options={kinds.map((k) => ({ value: k, label: ct(`kinds.${k}`) }))}
        onChange={onKind}
        disabled={disabled}
        initialFocus={initialFocus}
      />
      {between}
      <ChartSelect
        look={look}
        label={ct('measure')}
        value={measure.kind}
        options={[
          { value: 'count', label: ct('count') },
          ...(numbers.length
            ? [
                { value: 'sum' as const, label: ct('sum') },
                { value: 'average' as const, label: ct('average') },
              ]
            : []),
        ]}
        disabled={disabled}
        onChange={(next) =>
          onMeasure(
            next === 'count' || !numbers.length
              ? { kind: 'count' }
              : {
                  kind: next,
                  propertyId:
                    measure.kind !== 'count' && numbers.some((p) => p.id === measure.propertyId)
                      ? measure.propertyId
                      : numbers[0].id,
                },
          )
        }
      />
      {measure.kind !== 'count' && numbers.length ? (
        <ChartSelect
          look={look}
          label={ct('measureOf')}
          value={measure.propertyId}
          options={numbers.map((p) => ({ value: p.id, label: p.name }))}
          disabled={disabled}
          onChange={(propertyId) =>
            onMeasure({ kind: (measure as { kind: 'sum' | 'average' }).kind, propertyId })
          }
        />
      ) : null}
      {look.field ? <div className={look.field}>{titleField}</div> : titleField}
    </>
  );
}
