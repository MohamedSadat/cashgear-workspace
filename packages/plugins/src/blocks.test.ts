// The first-party blocks drawn by the frame (`./view`) in jsdom over `@cgw/database`'s in-memory
// host: the chart's number and its groups from a view's rows, its settings written back merged
// with the props it does not know, read-only when a later version wrote it; the kanban's columns
// from a status property, a card moved by keyboard writing one `row.update` with the database's
// access, "Hide group" going to the block's props, never to a view; and a type the registry does
// not have, or no database host, saying it can't be shown here.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from './testing/dom';

installDom();
const { act } = await import('react');
const { en: databaseEn, ar: databaseAr } = await import('@cgw/database/i18n');
const { seed, P } = await import('@cgw/database/testing');
const { FIRST_PARTY, createRegistry } = await import('./index');
const { mountPlugin } = await import('./view');
const { createPluginsI18n } = await import('./i18n');
// The views load lazily; loaded once here, the first mount of each draws at once.
await import('./chart/ChartBlock');
await import('./kanban/KanbanBlock');
type PluginFrameOptions = import('./types').PluginFrameOptions;
type PluginData = import('./types').PluginData;

let container: HTMLElement;
let frames: { destroy(): void }[] = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => {
    for (const frame of frames) frame.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  frames = [];
  document.body.innerHTML = '';
  document.documentElement.dir = 'ltr';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = (times = 3) =>
  act(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
/** Until the lazy view is drawn (no loading fallback left at the frame's top). */
async function settle() {
  for (let i = 0; i < 50; i++) {
    await flush(1);
    const top = container.querySelector('.cgw-plugin-root > .cgw-plugin-message[aria-busy]');
    if (!top) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

interface Mounted {
  writes: { props: string; version: number }[];
  update(next: Partial<PluginFrameOptions>): Promise<void>;
}

async function mount(
  options: Partial<PluginFrameOptions> & { type: string },
  data: PluginData,
  language: 'en' | 'ar' = 'en',
  registry = FIRST_PARTY,
): Promise<Mounted> {
  const i18n = createPluginsI18n(language, { en: databaseEn, ar: databaseAr });
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  const writes: { props: string; version: number }[] = [];
  let current: PluginFrameOptions = {
    version: 1,
    props: null,
    blockId: 'Blk0000000001',
    editable: true,
    setProps: (props, version) => {
      writes.push({ props, version });
      current = { ...current, props, version };
      frame.update(current);
    },
    ...options,
  };
  let frame!: ReturnType<typeof mountPlugin>;
  await act(async () => {
    frame = mountPlugin(container, current, { registry, data, i18n });
  });
  frames.push(frame);
  await settle();
  return {
    writes,
    update: async (next) => {
      current = { ...current, ...next };
      await act(async () => frame.update(current));
      await settle();
    },
  };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}
async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}
async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
  await flush();
}
const field = (label: string) =>
  [...container.querySelectorAll<HTMLLabelElement>('.cgw-plugin-field')].find(
    (l) => l.querySelector('.cgw-plugin-field-label')?.textContent === label,
  )!;

describe('the chart block', () => {
  it('shows the count of the view’s rows as one number', async () => {
    const s = seed(40, { today: '2026-11-13' });
    await mount(
      {
        type: 'cashgear.chart',
        props: JSON.stringify({ databaseId: s.tasksId, chart: 'number' }),
      },
      { databases: s.host },
    );
    const number = container.querySelector('[data-testid="chart-number"]')!;
    expect(number.querySelector('.cgw-plugin-number-value')!.textContent).toBe('40');
    expect(number.textContent).toContain('Count of rows');
    expect(container.querySelector('section')!.getAttribute('aria-label')).toBe(
      'Chart of Count of rows',
    );
  });

  it('sums a number property, and groups by status in a chart', async () => {
    const s = seed(30, { today: '2026-11-13' });
    const amounts = s.host
      .rowsOf(s.tasksId)
      .reduce((sum, r) => sum + ((r.values[P.amount] as number | undefined) ?? 0), 0);
    const block = await mount(
      {
        type: 'cashgear.chart',
        props: JSON.stringify({
          databaseId: s.tasksId,
          chart: 'number',
          measure: { kind: 'sum', propertyId: P.amount },
        }),
      },
      { databases: s.host },
    );
    const shown = container.querySelector('.cgw-plugin-number-value')!.textContent!;
    expect(Number(shown.replace(/,/g, ''))).toBeCloseTo(amounts, 2);
    expect(container.textContent).toContain('Sum of Amount');
    await block.update({
      props: JSON.stringify({ databaseId: s.tasksId, chart: 'bar', groupBy: P.status }),
    });
    expect(container.querySelector('[data-testid="chart-canvas"]')).not.toBeNull();
    expect(container.querySelector('section')!.dataset.chart).toBe('bar');
    expect(container.textContent).toContain('Count by Status');
  });

  it('asks for a database, and says what it needs before it has a group', async () => {
    const s = seed(3);
    let asked = 0;
    const block = await mount(
      { type: 'cashgear.chart', props: '{"later":"kept"}' },
      {
        databases: s.host,
        pickDatabase: async () => {
          asked++;
          return { databaseId: s.tasksId, viewId: null };
        },
      },
    );
    expect(container.textContent).toContain('No database chosen.');
    await click(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Choose a database')!,
    );
    expect(asked).toBe(1);
    expect(JSON.parse(block.writes[0].props)).toMatchObject({
      databaseId: s.tasksId,
      viewId: null,
      later: 'kept',
    });
    expect(block.writes[0].version).toBe(1);
    expect(container.textContent).toContain('Choose a property to group by in the settings.');
  });

  it('writes its settings back merged with the props it does not know', async () => {
    const s = seed(10);
    const block = await mount(
      {
        type: 'cashgear.chart',
        props: JSON.stringify({ databaseId: s.tasksId, chart: 'bar', groupBy: P.status, v2: [1] }),
      },
      { databases: s.host },
    );
    await click(container.querySelector('.cgw-plugin-settings-button')!);
    await choose(field('Chart').querySelector('select')!, 'pie');
    await choose(field('Measure').querySelector('select')!, 'average');
    const last = JSON.parse(block.writes.at(-1)!.props);
    expect(last).toMatchObject({
      databaseId: s.tasksId,
      chart: 'pie',
      groupBy: P.status,
      v2: [1],
      measure: { kind: 'average' },
    });
    // Grouped by nothing, it is a number.
    await choose(field('Group by').querySelector('select')!, '');
    expect(JSON.parse(block.writes.at(-1)!.props)).toMatchObject({
      groupBy: null,
      chart: 'number',
    });
  });

  it('is read-only, and writes nothing, when a later version wrote it', async () => {
    const s = seed(5);
    const block = await mount(
      {
        type: 'cashgear.chart',
        version: 2,
        props: JSON.stringify({ databaseId: s.tasksId, chart: 'number' }),
      },
      { databases: s.host },
    );
    expect(container.querySelector('.cgw-plugin-badge')!.textContent).toBe('Read only');
    expect(container.querySelector('.cgw-plugin-settings-button')).toBeNull();
    expect(block.writes).toEqual([]);
  });

  it('is drawn in Arabic', async () => {
    const s = seed(6);
    await mount(
      { type: 'cashgear.chart', props: JSON.stringify({ databaseId: s.tasksId, chart: 'number' }) },
      { databases: s.host },
      'ar',
    );
    expect(container.querySelector('.cgw-plugin-root')!.getAttribute('dir')).toBe('rtl');
    expect(container.textContent).toContain('عدد الصفوف');
    expect(container.querySelector('.cgw-plugin-settings-button')!.textContent).toBe('الإعدادات');
  });
});

describe('the kanban block', () => {
  it('draws a column per status and moves a card with one row.update', async () => {
    const s = seed(12, { today: '2026-11-13' });
    await mount(
      { type: 'cashgear.kanban', props: JSON.stringify({ databaseId: s.tasksId }) },
      { databases: s.host },
    );
    const columns = [...container.querySelectorAll<HTMLElement>('.cgw-board-column')];
    expect(columns.map((c) => c.dataset.group)).toEqual(['', 'stTodo01', 'stDoing1', 'stDone01']);
    s.host.applied.length = 0;
    const card = container.querySelector<HTMLElement>('[data-group="stTodo01"] [data-card]')!;
    const rowId = card.dataset.rowId!;
    card.focus();
    await key(card, ' ');
    await key(card, 'ArrowRight');
    await key(card, ' ');
    const updates = s.host.applied.filter((op) => op.type === 'row.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      entityId: rowId,
      payload: { values: { [P.status]: 'stDoing1' } },
    });
    // The block's own view is never stored.
    expect(s.host.applied.filter((op) => op.type === 'view.upsert')).toEqual([]);
  });

  it('keeps its columns and cards in its props, and never in one of the database’s views', async () => {
    const s = seed(8, { today: '2026-11-13' });
    const block = await mount(
      {
        type: 'cashgear.kanban',
        props: JSON.stringify({ databaseId: s.tasksId, groupBy: P.priority }),
      },
      { databases: s.host },
    );
    const groups = [...container.querySelectorAll<HTMLElement>('.cgw-board-column')].map(
      (c) => c.dataset.group,
    );
    expect(groups.length).toBeGreaterThan(1);
    await click(container.querySelector('.cgw-plugin-settings-button')!);
    await choose(field('Columns').querySelector('select')!, P.status);
    expect(JSON.parse(block.writes.at(-1)!.props)).toMatchObject({
      groupBy: P.status,
      hidden: [],
    });
    const box = [...container.querySelectorAll<HTMLInputElement>('.cgw-plugin-cards input')][0];
    await click(box);
    expect(JSON.parse(block.writes.at(-1)!.props).cardProperties).toHaveLength(1);
    expect(s.host.applied.filter((op) => op.type === 'view.upsert')).toEqual([]);
  });
});

describe('the frame', () => {
  it('says a block cannot be shown here for a type it has no definition of', async () => {
    await mount({ type: 'cashgear.chart' }, { databases: null }, 'en', createRegistry([]));
    expect(container.textContent).toBe('This block can’t be shown here.');
  });

  it('says so without a database host, as on a page shared by link', async () => {
    await mount({ type: 'cashgear.kanban', props: '{"databaseId":"x"}' }, { databases: null });
    expect(container.textContent).toContain('This block can’t be shown here.');
  });
});
