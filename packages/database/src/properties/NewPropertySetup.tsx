// A new relation or rollup is set up before it is written: neither is a property without its
// settings (a relation names its database; a rollup its relation, property and function), so the
// "Add a property" menus open these settings in place of writing an empty one.
import { CellFlyout } from '../cells/CellFlyout';
import type { DatabaseRecord, PropertyDef, PropertyType } from '../core';
import { useDatabaseContext } from '../context';
import { useDbT } from '../i18n';
import { RelationSetup, RollupSetup, type RelationSave } from './RelationSetup';

/** Types whose new property is set up before it is written. */
export const SET_UP_FIRST: readonly PropertyType[] = ['relation', 'rollup'];

export function NewPropertySetup({
  def,
  database,
  anchor,
  onSave,
  onClose,
}: {
  def: PropertyDef;
  database: DatabaseRecord;
  anchor: HTMLElement;
  onSave(save: RelationSave): void;
  onClose(): void;
}) {
  const { t } = useDbT();
  const { host } = useDatabaseContext();
  const title = t(def.type === 'relation' ? 'property.relationSetup' : 'property.rollupSetup');
  return (
    <CellFlyout anchor={anchor} label={title} width={300} onClose={() => onClose()}>
      <div className="cgw-panel">
        <div className="cgw-panel-head">
          <span className="cgw-panel-title">{title}</span>
        </div>
        {def.type === 'relation' ? (
          <RelationSetup
            host={host}
            database={database}
            def={def}
            onSave={(save) => {
              onSave(save);
              onClose();
            }}
          />
        ) : (
          <RollupSetup
            host={host}
            database={database}
            def={def}
            onSave={(next) => {
              onSave({ def: next, reverse: null });
              onClose();
            }}
          />
        )}
      </div>
    </CellFlyout>
  );
}
