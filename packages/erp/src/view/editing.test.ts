// Changing ERP data in a block (Phase 7, jsdom): only where the ERP gives `edit` and the block
// knows its place; a cell's editor checks the value; changes are marked and counted; "Review
// changes" is a dry run listing every change and error; Commit writes once and the page is read
// again; a conflict shows the ERP's value beside the person's; AI fills the pending list and
// never commits; nothing reaches the block's attributes.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import type { ErpAiRequest, ErpChangeProposal } from '../ai';
import { ErpDrafts } from '../drafts';
import { en } from '../i18n/en';
import type { Rendered } from './testing';

installDom();
const { act } = await import('react');
const {
  FakeErp,
  LINK,
  VENDOR_RECORDS,
  button,
  choose,
  click,
  hasButton,
  press,
  renderView,
  text,
  type,
  until,
} = await import('./testing');

const E = en.erp;
const VENDORS = { linkId: LINK.id, connectorId: 'vendors' } as const;
const [A, B] = VENDOR_RECORDS as [(typeof VENDOR_RECORDS)[0], (typeof VENDOR_RECORDS)[0]];

let views: Rendered[] = [];
afterEach(() => {
  for (const view of views) view.unmount();
  views = [];
});

async function open(options: Parameters<typeof renderView>[0] = {}): Promise<Rendered> {
  const view = await renderView({ attrs: VENDORS, erp: new FakeErp().editable(), ...options });
  views.push(view);
  await click(button(view.container, E.connect));
  await until(() => !!view.container.querySelector('[data-testid="erp-table"]'), 'the table');
  return view;
}

const cell = (view: Rendered, key: string, field: string) =>
  view.container.querySelector<HTMLTableCellElement>(
    `[data-testid="erp-table"] tr[data-key="${key}"] td[data-field="${field}"]`,
  );

/** Opens a cell's editor, types, and presses Enter. */
async function edit(view: Rendered, key: string, field: string, value: string) {
  await click(cell(view, key, field)!.querySelector('button')!);
  const input = cell(view, key, field)!.querySelector('input')!;
  await type(input, value);
  await press(input, 'Enter');
}

const count = (view: Rendered) =>
  text(view.container.querySelector('[data-testid="erp-change-count"]')!);

describe('changing ERP data in a block', { timeout: 30_000 }, () => {
  it('is offered only where the ERP gives edit and the block knows its place', async () => {
    const readOnly = await renderView({ attrs: { linkId: LINK.id, connectorId: 'customers' } });
    views.push(readOnly);
    await click(button(readOnly.container, E.connect));
    await until(() => !!readOnly.container.querySelector('[data-testid="erp-table"]'));
    expect(hasButton(readOnly.container, E.editData)).toBe(false);

    const nowhere = await open({ place: null });
    expect(hasButton(nowhere.container, E.editData)).toBe(false);
    expect(cell(nowhere, A.key, 'vendorName')!.querySelector('button')).toBeNull();

    const view = await open();
    expect(hasButton(view.container, E.editData)).toBe(true);
    // Not until "Edit data": the table reads as before.
    expect(cell(view, A.key, 'vendorName')!.querySelector('button')).toBeNull();
    await click(button(view.container, E.editData));
    expect(cell(view, A.key, 'vendorName')!.querySelector('button')).not.toBeNull();
    // Fields the ERP keeps read-only have no editor.
    expect(cell(view, A.key, 'debitLimit')!.querySelector('button')).toBeNull();
    expect(cell(view, A.key, 'vendorAccount')!.querySelector('button')).toBeNull();
  });

  it('marks a change, reviews it by a dry run, commits it once and reads the page again', async () => {
    const view = await open();
    await click(button(view.container, E.editData));
    expect(count(view)).toBe(E.noChanges);
    await edit(view, A.key, 'vendorName', 'Qorvath Lanterns');
    const changed = cell(view, A.key, 'vendorName')!;
    expect(changed.dataset.changed).toBe('person');
    expect(text(changed)).toContain('Qorvath Lanterns');
    expect(text(changed)).toContain(E.changed);
    expect(changed.title).toBe(E.wasValue.replace('{{value}}', A.values.vendorName as string));
    expect(count(view)).toBe(E.changesCount.replace('{{count}}', '1'));
    // Nothing went to the ERP yet.
    expect(view.erp.commits).toHaveLength(0);

    await click(button(view.container, E.reviewChanges));
    await until(
      () =>
        view.container.querySelector('[data-testid="erp-review"]')?.getAttribute('data-phase') ===
        'reviewed',
      'the review',
    );
    const row = view.container.querySelector('[data-testid="erp-review-table"] tbody tr')!;
    expect([...row.children].map(text)).toEqual([
      A.key,
      'Name',
      A.values.vendorName,
      'Qorvath Lanterns',
    ]);
    expect(view.erp.commits.map((r) => r.dryRun)).toEqual([true]);
    const queries = view.erp.queries.length;

    await click(button(view.container, E.commitChanges.replace('{{count}}', '1')));
    await until(() => !!view.container.querySelector('[data-testid="erp-committed"]'), 'committed');
    expect(view.erp.commits.map((r) => r.dryRun)).toEqual([true, false]);
    expect(view.erp.commits[0]!.commitId).toBe(view.erp.commits[1]!.commitId);
    expect(view.erp.commits[1]!.source).toEqual({
      workspaceId: LINK.workspaceId,
      pageId: '01930000-0000-7000-8000-0000000000bb',
      blockId: 'Blk000000001',
    });
    expect(view.erp.records.find((r) => r.id === A.id)!.values.vendorName).toBe('Qorvath Lanterns');
    await until(() => view.erp.queries.length > queries, 'the page read again');
    expect(view.audits).toEqual([
      expect.objectContaining({
        outcome: 'committed',
        records: 1,
        fields: 1,
        connectorId: 'vendors',
      }),
    ]);
    // Nothing of the ERP's data reached the block's attributes.
    expect(view.writes).toEqual([]);
  });

  it('checks a value in the cell before taking it', async () => {
    const view = await open();
    await click(button(view.container, E.editData));
    await edit(view, A.key, 'vendorName', '');
    const alert = cell(view, A.key, 'vendorName')!.querySelector('[role="alert"]');
    expect(text(alert!)).toBe(E.problemRequired);
    expect(
      cell(view, A.key, 'vendorName')!.querySelector('input')!.getAttribute('aria-invalid'),
    ).toBe('true');
    expect(count(view)).toBe(E.noChanges);
    // Escape leaves it as it was.
    await press(cell(view, A.key, 'vendorName')!.querySelector('input')!, 'Escape');
    expect(cell(view, A.key, 'vendorName')!.querySelector('input')).toBeNull();
    // A lookup offers active codes only.
    await click(cell(view, A.key, 'vendorGroup')!.querySelector('button')!);
    const select = cell(view, A.key, 'vendorGroup')!.querySelector('select')!;
    const old = [...select.options].find((o) => o.value === 'OLD')!;
    expect(old.disabled).toBe(true);
    await choose(select, 'IMPORT');
    expect(cell(view, A.key, 'vendorGroup')!.dataset.changed).toBe('person');
  });

  it('lists what the ERP refused, per field, and keeps the changes', async () => {
    const view = await open();
    view.erp.commitWith = () => ({
      kind: 'invalid',
      errors: [{ id: A.id, key: A.key, field: 'vendorName', code: 'maxLength', message: 'x' }],
      correlationId: 'c',
    });
    await click(button(view.container, E.editData));
    await edit(view, A.key, 'vendorName', 'Long enough for the ERP to refuse');
    await click(button(view.container, E.reviewChanges));
    await until(
      () =>
        view.container.querySelector('[data-testid="erp-review"]')?.getAttribute('data-phase') ===
        'invalid',
    );
    expect(text(view.container)).toContain(E.reviewInvalid);
    const row = view.container.querySelector('[data-testid="erp-review-table"] tbody tr')!;
    expect(row.getAttribute('data-problem')).toBe('maxLength');
    expect(text(row)).toContain(E.problemMaxLength);
    expect(hasButton(view.container, E.commitChanges.replace('{{count}}', '1'))).toBe(false);
    await click(button(view.container, E.backToEditing));
    expect(cell(view, A.key, 'vendorName')!.dataset.changed).toBe('person');
  });

  it('shows a conflict beside the person’s value, and keeps theirs or mine per field', async () => {
    const view = await open();
    await click(button(view.container, E.editData));
    await edit(view, A.key, 'vendorName', 'Mine');
    view.erp.changeBehind(A.id, { vendorName: 'Theirs' });
    await click(button(view.container, E.reviewChanges));
    await until(
      () => !!view.container.querySelector('[data-testid="erp-conflicts"]'),
      'the conflict',
    );
    const panel = view.container.querySelector('[data-testid="erp-conflicts"]')!;
    const row = panel.querySelector('tr[data-field="vendorName"]')!;
    expect([...row.children].slice(0, 3).map(text)).toEqual(['Name', 'Mine', 'Theirs']);
    expect(text(panel)).toContain('Bob Mansour');
    expect(button(panel, E.applyChoices).disabled).toBe(true);
    await click(row.querySelector<HTMLInputElement>('input[value="mine"]')!);
    expect(button(panel, E.applyChoices).disabled).toBe(false);
    await click(button(panel, E.applyChoices));
    expect(view.container.querySelector('[data-testid="erp-conflicts"]')).toBeNull();
    // Reviewed again on the record's new version, then committed.
    await click(button(view.container, E.reviewChanges));
    await until(
      () =>
        view.container.querySelector('[data-testid="erp-review"]')?.getAttribute('data-phase') ===
        'reviewed',
    );
    expect(
      text(view.container.querySelector('[data-testid="erp-review-table"] tbody tr')!),
    ).toContain('Theirs');
    await click(button(view.container, E.commitChanges.replace('{{count}}', '1')));
    await until(() => !!view.container.querySelector('[data-testid="erp-committed"]'));
    expect(view.erp.records.find((r) => r.id === A.id)!.values.vendorName).toBe('Mine');
    expect(view.erp.commits.filter((r) => !r.dryRun)).toHaveLength(1);
  });

  it('keeps the changes when the block is drawn again, and locks the data choice meanwhile', async () => {
    const drafts = new ErpDrafts({ wait: async () => undefined });
    const first = await open({ drafts });
    await click(button(first.container, E.editData));
    await edit(first, B.key, 'vendorName', 'Kept');
    const data = first.container.querySelector<HTMLSelectElement>('.cgw-erp-toolbar select')!;
    expect(data.disabled).toBe(true);
    expect(text(first.container)).toContain(E.editLocked);
    first.unmount();
    views = views.filter((v) => v !== first);
    // Far away and back (the frame unmounts): the block's draft is the tab's, by page and block.
    const again = await open({ drafts, erp: first.erp });
    expect(cell(again, B.key, 'vendorName')!.dataset.changed).toBe('person');
    expect(count(again)).toBe(E.changesCount.replace('{{count}}', '1'));
    expect(drafts.pendingOn('01930000-0000-7000-8000-0000000000bb')).toBe(true);
  });

  it('lets AI prepare changes, checked like typed ones, and never commits them', async () => {
    const asked: ErpAiRequest[] = [];
    const ai = {
      prepare: async (request: ErpAiRequest): Promise<readonly ErpChangeProposal[]> => {
        asked.push(request);
        return [
          { id: A.id, field: 'vendorName', to: 'AI name' },
          // Not editable, not on screen, an inactive code, a value of the wrong type: unused.
          { id: A.id, field: 'debitLimit', to: '1.00' },
          { id: 'nope', field: 'vendorName', to: 'x' },
          { id: B.id, field: 'vendorGroup', to: 'OLD' },
          { id: B.id, field: 'vendorName', to: 42 },
        ];
      },
    };
    const view = await open({ ai });
    await click(button(view.container, E.editData));
    await click(button(view.container, E.aiPrepare));
    const panel = view.container.querySelector('[data-testid="erp-ai"]')!;
    expect(text(panel)).toContain(E.aiNote);
    const area = panel.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, 'Tidy the names');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(panel, E.aiRun));
    await until(
      () =>
        text(view.container.querySelector('[data-testid="erp-ai-status"]')!) !== E.aiPreparing &&
        text(view.container.querySelector('[data-testid="erp-ai-status"]')!) !== '',
    );
    expect(text(view.container.querySelector('[data-testid="erp-ai-status"]')!)).toBe(
      `${E.aiPrepared.replace('{{count}}', '1')} ${E.aiSkipped.replace('{{count}}', '4')}`,
    );
    expect(cell(view, A.key, 'vendorName')!.dataset.changed).toBe('ai');
    expect(text(cell(view, A.key, 'vendorName')!)).toContain(E.changedByAi);
    // The request: the instruction, the editable fields only, the records on screen.
    expect(asked[0]!.instruction).toBe('Tidy the names');
    expect(asked[0]!.fields.map((f) => f.name)).toEqual(['vendorName', 'vendorGroup']);
    expect(asked[0]!.fields[1]!.lookup!.map((i) => i.code)).toEqual(['LOCAL', 'IMPORT']);
    expect(asked[0]!.records.map((r) => r.id)).toEqual([A.id, B.id]);
    // Prepared is not committed: nothing went to the ERP.
    expect(view.erp.commits).toHaveLength(0);
  });
});
