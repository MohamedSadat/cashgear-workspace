// A date property's "Remind people of this date" (Phase 17, M17.2): the menu closes, and the
// automations open on a new rule a day before the date, telling the database's first person
// property's people as a reminder (the inbox's `reminder` kind). Offered with full access's rule
// editor behind it, on a server that keeps 0.17.0's steps.
import { CgMenuPanelItem } from '@cashgear/ui';
import type { DatabaseRecord, PropertyDef } from '../core';
import { useDatabaseContext, useHost } from '../context';
import { liveProperties } from '../model/properties';
import { openAutomations } from './open';
import { useAutoT } from './words';

export function RemindPeopleItem({
  def,
  database,
  onClose,
}: {
  def: PropertyDef;
  database: DatabaseRecord;
  onClose(): void;
}) {
  const { t: at } = useAutoT();
  const { host } = useDatabaseContext();
  const automations = useHost(host, () => host.automations);
  if (def.type !== 'date' || !automations?.knowsWorkflows?.()) return null;
  const person = liveProperties(database).find((p) => p.type === 'person');
  return (
    <CgMenuPanelItem
      icon="⏰"
      onSelect={() => {
        onClose();
        openAutomations(
          database.id,
          { kind: 'date', propertyId: def.id, offsetMinutes: -1440, at: null },
          {
            name: at('remind.peopleName', { property: def.name }),
            steps: [
              {
                kind: 'notify',
                people: [],
                groups: [],
                personProperties: person ? [person.id] : [],
                message: '',
                reminder: true,
                when: null,
              },
            ],
          },
        );
      }}
    >
      {at('remind.people')}
    </CgMenuPanelItem>
  );
}
