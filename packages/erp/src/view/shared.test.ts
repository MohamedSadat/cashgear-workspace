// Phase 10 (jsdom): a field shared by a key (Items on hand's item name and group, `scope: 'key'`)
// in a block. One row's edit changes every row of its item the block holds, each marked; a row
// read later (the next page) takes the change too; the review lists each, and the rows the ERP
// says change with them that the block did not send; a commit writes the item once; a conflict
// from a stock movement (no field of the commit changed) asks for no choice.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import { en } from '../i18n/en';
import type { Rendered } from './testing';

installDom();
const { FakeErp, ITEM_RECORDS, LINK, button, click, press, renderView, text, type, until } =
  await import('./testing');

const E = en.erp;
const [A, B, C, OTHER] = ITEM_RECORDS as [
  (typeof ITEM_RECORDS)[0],
  (typeof ITEM_RECORDS)[0],
  (typeof ITEM_RECORDS)[0],
  (typeof ITEM_RECORDS)[0],
];

let views: Rendered[] = [];
afterEach(() => {
  for (const view of views) view.unmount();
  views = [];
});

async function open(pageSize: number | null = null): Promise<Rendered> {
  const view = await renderView({
    attrs: { linkId: LINK.id, connectorId: 'itemsOnHand', pageSize },
    erp: new FakeErp().itemsOnHand(),
  });
  views.push(view);
  await click(button(view.container, E.connect));
  await until(() => !!view.container.querySelector('[data-testid="erp-table"]'), 'the table');
  await click(button(view.container, E.editData));
  return view;
}

/** A record's row: rows of one item share their key, so it is told by its warehouse. */
const row = (view: Rendered, id: string) => {
  const record = ITEM_RECORDS.find((r) => r.id === id)!;
  return [...view.container.querySelectorAll('[data-testid="erp-table"] tbody tr')].find(
    (tr) =>
      tr.getAttribute('data-key') === record.key &&
      text(tr.querySelector('td[data-field="warehouseId"]')!) === record.values.warehouseId,
  );
};
const nameCell = (view: Rendered, id: string) =>
  row(view, id)?.querySelector<HTMLTableCellElement>('td[data-field="itemName"]') ?? null;

async function rename(view: Rendered, id: string, value: string) {
  await click(nameCell(view, id)!.querySelector('button')!);
  const input = nameCell(view, id)!.querySelector('input')!;
  // The editor says the item's other rows change too.
  expect(text(nameCell(view, id)!)).toContain(E.sharedField.replace('{{field}}', 'Item ID'));
  await type(input, value);
  await press(input, 'Enter');
}

const count = (view: Rendered) =>
  text(view.container.querySelector('[data-testid="erp-change-count"]')!);

const reviewed = (view: Rendered) =>
  until(
    () =>
      view.container.querySelector('[data-testid="erp-review"]')?.getAttribute('data-phase') ===
      'reviewed',
    'the review',
  );

describe('a field shared by a key', { timeout: 30_000 }, () => {
  it('changes every row of its item the block holds, reviews each, and commits the item once', async () => {
    const view = await open();
    await rename(view, B.id, 'Qorvath olive oil 1 litre');
    for (const id of [A.id, B.id, C.id]) {
      expect(nameCell(view, id)!.dataset.changed, id).toBe('person');
      expect(text(nameCell(view, id)!)).toContain('Qorvath olive oil 1 litre');
    }
    expect(nameCell(view, OTHER.id)!.dataset.changed).toBeUndefined();
    expect(count(view)).toBe(E.changesCount.replace('{{count}}', '3'));

    await click(button(view.container, E.reviewChanges));
    await reviewed(view);
    const review = view.container.querySelector('[data-testid="erp-review-table"]')!;
    const rows = [...review.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    // One record sent per row, the same value each.
    const sent = view.erp.commits[0]!;
    expect(sent.records.map((r) => r.id).sort()).toEqual([A.id, B.id, C.id].sort());
    expect(new Set(sent.records.map((r) => r.changes.itemName!.to))).toEqual(
      new Set(['Qorvath olive oil 1 litre']),
    );
    // Rows of one key are told apart by their ids.
    expect(text(rows[0]!)).toContain(sent.records[0]!.id);
    await click(button(view.container, E.commitChanges.replace('{{count}}', '3')));
    await until(() => !!view.container.querySelector('[data-testid="erp-committed"]'), 'committed');
    for (const id of [A.id, B.id, C.id]) {
      expect(view.erp.records.find((r) => r.id === id)!.values.itemName).toBe(
        'Qorvath olive oil 1 litre',
      );
    }
    expect(view.erp.records.find((r) => r.id === OTHER.id)!.values.itemName).toBe(
      OTHER.values.itemName,
    );
  });

  it('lists the rows the ERP says change with them, and a row read later takes the change', async () => {
    // Two rows a page: the item's third row is on the next page.
    const view = await open(2);
    await rename(view, A.id, 'Renamed oil');
    expect(count(view)).toBe(E.changesCount.replace('{{count}}', '2'));
    await click(button(view.container, E.reviewChanges));
    await reviewed(view);
    const review = view.container.querySelector('[data-testid="erp-review-table"]')!;
    const also = [...review.querySelectorAll('tbody tr[data-also="true"]')];
    expect(also).toHaveLength(1);
    expect(text(also[0]!)).toContain(C.id);
    expect(text(also[0]!)).toContain(E.alsoChanged.replace('{{field}}', 'Item ID'));
    expect(text(also[0]!)).toContain('Renamed oil');
    // Commit counts the person's own changes only.
    expect(button(view.container, E.commitChanges.replace('{{count}}', '2'))).toBeTruthy();
    await click(button(view.container, E.backToEditing));
    await click(button(view.container, E.nextPage));
    await until(() => !!nameCell(view, C.id), 'the next page');
    expect(nameCell(view, C.id)!.dataset.changed).toBe('person');
    expect(count(view)).toBe(E.changesCount.replace('{{count}}', '3'));
  });

  it('asks no choice for a row whose own values moved in the ERP, and keeps the change', async () => {
    const view = await open();
    await rename(view, A.id, 'Moved oil');
    // A posting moves one row's quantity meanwhile: its version changes, not its name.
    view.erp.changeBehind(B.id, { onHandQty: '79.000' });
    await click(button(view.container, E.reviewChanges));
    await until(
      () => !!view.container.querySelector('[data-testid="erp-conflicts"]'),
      'the conflict',
    );
    const panel = view.container.querySelector('[data-testid="erp-conflicts"]')!;
    expect(text(panel.querySelector('[data-testid="erp-conflict-other"]')!)).toBe(E.conflictOther);
    expect(button(panel, E.applyChoices).disabled).toBe(false);
    await click(button(panel, E.applyChoices));
    expect(count(view)).toBe(E.changesCount.replace('{{count}}', '3'));
    await click(button(view.container, E.reviewChanges));
    await reviewed(view);
    expect(view.erp.commits.at(-1)!.records.find((r) => r.id === B.id)!.version).not.toBe(
      B.version,
    );
  });
});
