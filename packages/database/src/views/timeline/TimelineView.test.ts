// The timeline view drawn in jsdom over the in-memory host (Phase 9): its queries (a date window
// around the days shown and the rows with no date: `DatabaseView` runs none for it), a line per row
// and only those in view, moves and resizes by keys and by pointer that write one `row.update`
// (mirrored right to left), two date properties moved together, lanes, the rows with no date
// placed and dropped on a day, a new row today, the zoom, a reader, and a timeline with no date.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { newOp } = await import('@cgw/workspace');
const { DatabaseView } = await import('../../DatabaseView');
const { createDatabaseI18n } = await import('../../i18n');
const { seed, P } = await import('../../testing/fixtures');
const { VIEW_TYPES, VIEW_ORDER } = await import('../registry');
const { dayNumber: dayOfDate, dateOfDay } = await import('../calendar/dates');

type Root = ReturnType<typeof createRoot>;
type Request = { viewId: string | null; spec: Record<string, unknown>; pageSize?: number };
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
// jsdom has no `scrollBy`, which a drag's edge scrolling calls (Phase 8's gotcha).
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.dir = 'ltr';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const i18n = createDatabaseI18n(language);
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n }, node)));
  await flush();
  await flush();
}
async function key(target: Element, code: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: code, code, bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}
async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pointer(el: EventTarget, kind: string, x: number, y: number) {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent(kind, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 5,
        clientX: x,
        clientY: y,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}
const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
  }) as DOMRect;

/** A seeded Tasks database (today 13 November 2026) shown as a timeline by its Due date. */
async function timelineOf(
  rows: number,
  timeline: Record<string, unknown> = {},
  options: { canEdit?: boolean; config?: Record<string, unknown> } = {},
) {
  const s = seed(rows, { today: '2026-11-13', canEdit: options.canEdit });
  const database = s.host.database(s.tasksId)!;
  const base = s.host.views(s.tasksId)[0];
  const id = s.host.newId();
  const config = VIEW_TYPES.timeline.defaultConfig(database);
  await s.host.apply([
    newOp('view.upsert', base.workspaceId, id, {
      ...base,
      id,
      name: 'Timeline',
      type: 'timeline',
      orderKey: 'a1',
      config: {
        ...config,
        ...options.config,
        timeline: { ...config.timeline!, start: P.due, ...timeline },
      },
    }),
  ]);
  s.host.applied.length = 0;
  const requests: Request[] = [];
  const rowsOf = s.host.rows.bind(s.host);
  s.host.rows = (databaseId, request) => {
    if (databaseId === s.tasksId) requests.push(JSON.parse(JSON.stringify(request)) as Request);
    return rowsOf(databaseId, request);
  };
  return {
    ...s,
    id,
    requests,
    view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }),
  };
}
const ops = (host: { applied: { type: string }[] }, kind: string) =>
  host.applied.filter((op) => op.type === kind);
const bars = () => [...container.querySelectorAll<HTMLElement>('[data-cg-timeline-item]')];
/** `CgTimeline`'s scroller, and the canvas inside it that pointer positions are read against. */
const scrollerOf = () => container.querySelector<HTMLElement>('[data-cg-timeline-scroller]')!;
const canvasOf = () => scrollerOf().firstElementChild as HTMLElement;
const dueOf = (
  host: { rowRecords: Map<string, { values: Record<string, unknown> }> },
  id: string,
) => host.rowRecords.get(id)!.values[P.due] as { start: string; end?: string } | undefined;
const plus = (date: string, days: number) => dateOfDay(dayOfDate(date)! + days);

describe('the timeline', () => {
  it('is the sixth view type, offered after the gallery', () => {
    expect(VIEW_ORDER).toEqual(['table', 'board', 'list', 'calendar', 'gallery', 'timeline']);
    expect(VIEW_TYPES.timeline.ownRows).toBe(true);
    expect(VIEW_TYPES.calendar.ownRows).toBe(true);
  });

  it('asks for the days shown and as many again by a date window, and the rows with no date by a filter', async () => {
    const { view, requests } = await timelineOf(300);
    await mount(view);
    // DatabaseView ran no query of its own for the view.
    expect(requests.every((r) => r.spec.window || JSON.stringify(r.spec).includes('isEmpty'))).toBe(
      true,
    );
    const windowed = requests.filter((r) => r.spec.window);
    expect(windowed.length).toBeGreaterThan(1);
    // The days shown first (their rows are the lines drawn at once: sorted by start, the wide
    // window's first pages are days before them), then the wide window.
    const first = windowed[0].spec.window!;
    expect(first.from > '2026-08-01' && first.to < '2027-03-31').toBe(true);
    expect(first.to > first.from).toBe(true);
    // A few days before today, a view of 48 days at 20 px a day (jsdom's 960 px), and as
    // many again on each side, out to whole months.
    expect(windowed.at(-1)!.spec.window).toEqual({
      propertyId: P.due,
      endPropertyId: null,
      from: '2026-08-01',
      to: '2027-03-31',
    });
    expect(windowed.at(-1)!.spec.sorts).toEqual([{ propertyId: P.due, direction: 'asc' }]);
    expect(windowed.at(-1)!.pageSize).toBe(500);
    const undated = requests.find((r) => !r.spec.window)!;
    expect(undated.spec.filter).toEqual({
      kind: 'group',
      op: 'and',
      children: [{ kind: 'condition', propertyId: P.due, operator: 'isEmpty' }],
    });
  });

  it('draws a line per row the days shown hold, earliest first, and only the lines in view', async () => {
    const { view, host, tasksId } = await timelineOf(600);
    await mount(view);
    // The days shown settle (the timeline tells them after 150 ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const startOf = (id: string) =>
      (host.rowRecords.get(id)!.values[P.due] as { start: string }).start;
    const inWindow = host.rowsOf(tasksId).filter((r) => {
      const start = (r.values[P.due] as { start: string } | undefined)?.start;
      return !!start && start >= '2026-08-01' && start <= '2027-03-31';
    });
    expect(inWindow.length).toBeGreaterThan(40);
    const lines = container.querySelectorAll('[role="row"]');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThan(40);
    // The lines are the rows of the days shown (today a fifth of the way in, about seven weeks):
    // fewer than the window fetched around them, all of them about today, earliest first.
    const count = Number(container.querySelector('[role="grid"]')!.getAttribute('aria-rowcount'));
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(inWindow.length);
    const starts = bars().map((b) => startOf(b.dataset.cgTimelineItem!));
    expect([...starts].sort()).toEqual(starts);
    for (const start of starts) {
      expect(start >= '2026-10-25').toBe(true);
      expect(start <= '2026-12-31').toBe(true);
    }
    expect(lines[0].getAttribute('aria-rowindex')).toBe('1');
    const first = bars()[0];
    expect(first.getAttribute('aria-label')).toMatch(
      new RegExp(`^${host.rowRecords.get(first.dataset.cgTimelineItem!)!.title}: `),
    );
    // One tab stop among the bars.
    expect(container.querySelectorAll('[data-cg-timeline-item][tabindex="0"]').length).toBe(1);
    // The rows with no date are beside it, a window of them drawn.
    const undated = host.rowsOf(tasksId).filter((r) => !r.values[P.due]).length;
    const listed = container.querySelectorAll('.cgw-cal-undated-item').length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThanOrEqual(Math.min(undated, 40));
  });

  it('moves a bar a day with Alt and the arrow: one row.update, a date stays a date', async () => {
    const { view, host } = await timelineOf(200);
    await mount(view);
    const bar = bars()[0];
    const id = bar.dataset.cgTimelineItem!;
    const before = dueOf(host, id)!;
    bar.focus();
    await key(bar, 'ArrowRight', { altKey: true });
    const updates = ops(host, 'row.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      entityId: id,
      payload: { values: { [P.due]: { start: plus(before.start, 1) } } },
    });
    // Said aloud, and the focus stays on the bar.
    await nextFrame();
    expect(document.activeElement?.getAttribute('data-cg-timeline-item')).toBe(id);
  });

  it('mirrors the keys right to left, where time runs from right to left', async () => {
    const { view, host } = await timelineOf(200);
    await mount(view, 'ar');
    const bar = bars()[0];
    const before = dueOf(host, bar.dataset.cgTimelineItem!)!;
    bar.focus();
    await key(bar, 'ArrowRight', { altKey: true });
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.due]: { start: plus(before.start, -1) } } },
    });
    // The Arabic name and hint.
    expect(bar.getAttribute('aria-label')).toMatch(/\p{Script=Arabic}|: /u);
    const hint = document.getElementById(bar.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/\p{Script=Arabic}/u);
  });

  it('resizes the end with Alt, Shift and the arrow, and the start with Ctrl, Shift and the arrow', async () => {
    const { view, host } = await timelineOf(200);
    await mount(view);
    let bar = bars()[0];
    const id = bar.dataset.cgTimelineItem!;
    const before = dueOf(host, id)!;
    bar.focus();
    await key(bar, 'ArrowRight', { altKey: true, shiftKey: true });
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.due]: { start: before.start, end: plus(before.start, 1) } } },
    });
    await flush();
    bar = container.querySelector<HTMLElement>(`[data-cg-timeline-item="${id}"]`)!;
    bar.focus();
    await key(bar, 'ArrowLeft', { ctrlKey: true, shiftKey: true });
    expect(ops(host, 'row.update')[1]).toMatchObject({
      payload: {
        values: { [P.due]: { start: plus(before.start, -1), end: plus(before.start, 1) } },
      },
    });
    // AltGr (Ctrl and Alt) moves nothing.
    await key(bar, 'ArrowRight', { altKey: true, ctrlKey: true });
    expect(ops(host, 'row.update')).toHaveLength(2);
  });

  it('moves a bar by pointer in whole days, and resizes it by its end; mirrored right to left', async () => {
    for (const language of ['en', 'ar'] as const) {
      const { view, host } = await timelineOf(200);
      await mount(view, language);
      // jsdom lays nothing out: the timeline's canvas from 0, a day 20 px (by weeks).
      canvasOf().getBoundingClientRect = () => box(0, 100, 1463 * 20, 2000);
      // The scroller around the pointer, so no edge of it scrolls while the bar is dragged.
      scrollerOf().getBoundingClientRect = () => box(0, 100, 1200, 480);
      // A bar some lines down: three days earlier it is still in the days shown.
      const bar = bars()[6];
      const id = bar.dataset.cgTimelineItem!;
      const before = dueOf(host, id)!;
      const sign = language === 'ar' ? -1 : 1;
      await pointer(bar, 'pointerdown', 510, 160);
      await pointer(window, 'pointermove', 520, 160);
      await pointer(window, 'pointermove', 510 + 3 * 20, 160);
      // Nothing is written before the drop.
      expect(ops(host, 'row.update')).toHaveLength(0);
      await pointer(window, 'pointerup', 510 + 3 * 20, 160);
      expect(ops(host, 'row.update')[0]).toMatchObject({
        entityId: id,
        payload: { values: { [P.due]: { start: plus(before.start, 3 * sign) } } },
      });
      await flush();
      // Its end edge: two days more (a one-day row grows an end).
      const moved = container.querySelector<HTMLElement>(`[data-cg-timeline-item="${id}"]`)!;
      const after = dueOf(host, id)!;
      const edge = moved.querySelector<HTMLElement>('[data-cg-timeline-edge="end"]')!;
      await pointer(edge, 'pointerdown', 710, 160);
      await pointer(window, 'pointermove', 710 + sign * 10, 160);
      await pointer(window, 'pointermove', 710 + sign * 2 * 20, 160);
      await pointer(window, 'pointerup', 710 + sign * 2 * 20, 160);
      expect(ops(host, 'row.update')[1]).toMatchObject({
        payload: { values: { [P.due]: { start: after.start, end: plus(after.start, 2) } } },
      });
      await act(async () => root?.unmount());
      root = null;
      container.innerHTML = '';
    }
  });

  it('moves a start and an end property together in one row.update', async () => {
    const s = await timelineOf(40);
    const { host, tasksId } = s;
    const database = host.database(tasksId)!;
    await host.apply([
      newOp('db.update', database.workspaceId, tasksId, {
        properties: [{ id: 'dateEnd1', name: 'Ends', type: 'date', date: { includeTime: false } }],
      }),
    ]);
    const view = host.viewRecords.get(s.id)!;
    await host.apply([
      newOp('view.upsert', view.workspaceId, view.id, {
        ...view,
        config: { ...view.config, timeline: { ...view.config.timeline!, end: 'dateEnd1' } },
      }),
    ]);
    await mount(s.view);
    const bar = bars()[0];
    const id = bar.dataset.cgTimelineItem!;
    const start = dueOf(host, id)!.start;
    await host.apply([
      newOp('row.update', database.workspaceId, id, {
        values: { dateEnd1: { start: plus(start, 4) } },
      }),
    ]);
    await flush();
    host.applied.length = 0;
    const again = container.querySelector<HTMLElement>(`[data-cg-timeline-item="${id}"]`)!;
    again.focus();
    await key(again, 'ArrowLeft', { altKey: true });
    const updates = ops(host, 'row.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      payload: {
        values: { [P.due]: { start: plus(start, -1) }, dateEnd1: { start: plus(start, 3) } },
      },
    });
    expect(s.requests.filter((r) => r.spec.window).at(-1)!.spec.window).toMatchObject({
      endPropertyId: 'dateEnd1',
    });
  });

  it('puts the rows in lanes by status, in its order, and collapses a lane', async () => {
    const { view } = await timelineOf(120, { lane: P.status });
    await mount(view);
    const toggles = () => [...container.querySelectorAll<HTMLElement>('[data-cg-timeline-lane]')];
    const heads = () => toggles().map((b) => b.textContent!.trim());
    /** What the second and third lines of the grid hold: a lane's button, or a row's bar. */
    const lineHolds = (index: number) => {
      const line = container.querySelector(`[role="row"][aria-rowindex="${index}"]`);
      return line?.querySelector('[data-cg-timeline-lane]')
        ? 'lane'
        : line?.querySelector('[data-cg-timeline-item]')
          ? 'row'
          : 'nothing';
    };
    // Only the lines in view are drawn: the first lane and its rows.
    expect(heads()[0]).toContain('Not started');
    expect(lineHolds(2)).toBe('row');
    const toggle = toggles()[0];
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Named by its title first, then its count.
    expect(toggle.getAttribute('aria-label')).toMatch(/^Not started, rows: \d+$/);
    expect(toggle.dataset.cgTimelineLane).toBe('stTodo01');
    // Collapsed one after the other, the lanes come up in their options' order.
    await click(toggle);
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('false');
    expect(lineHolds(2)).toBe('lane');
    expect(heads().slice(0, 2)).toEqual([
      expect.stringContaining('Not started'),
      expect.stringContaining('In progress'),
    ]);
    await click(toggles()[1]);
    expect(heads()).toEqual([
      expect.stringContaining('Not started'),
      expect.stringContaining('In progress'),
      expect.stringContaining('Done'),
    ]);
    expect(lineHolds(3)).toBe('lane');
    expect(lineHolds(4)).toBe('row');
  });

  it('places a row with no date on today, and drops one on the day under the pointer', async () => {
    const { view, host } = await timelineOf(80);
    await mount(view);
    const place = container.querySelector<HTMLElement>(
      '.cgw-cal-undated [aria-label="Place on today"]',
    )!;
    await click(place);
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.due]: { start: '2026-11-13' } } },
    });
    scrollerOf().getBoundingClientRect = () => box(0, 100, 960, 480);
    // The canvas starts two years (731 days, its reach by weeks) before today: placed so that the
    // day at the view's inline start is 733 days into it, 15 November.
    const first = dayOfDate('2026-11-13')! - 731;
    canvasOf().getBoundingClientRect = () => box(-733 * 20, 100, 1463 * 20, 2000);
    const mark = () => container.querySelector('[data-cg-timeline-drop]')!;
    const item = container.querySelector<HTMLElement>('.cgw-cal-undated [data-cal-drag]')!;
    await pointer(item, 'pointerdown', 1100, 300);
    await pointer(window, 'pointermove', 1080, 300);
    await pointer(window, 'pointermove', 9, 300);
    expect(mark().hasAttribute('data-shown')).toBe(true);
    await pointer(window, 'pointerup', 9, 300);
    expect(mark().hasAttribute('data-shown')).toBe(false);
    expect(ops(host, 'row.update')[1]).toMatchObject({
      payload: { values: { [P.due]: { start: dateOfDay(first + 733) } } },
    });
    expect(dateOfDay(first + 733)).toBe('2026-11-15');
  });

  it("makes a row today from the toolbar's New, its title typed first", async () => {
    const { view, host } = await timelineOf(20);
    await mount(view);
    const newButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'New',
    )!;
    await click(newButton);
    await nextFrame();
    await flush();
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] .cgw-inline-editor')!;
    expect(input).toBeTruthy();
    await type(input, 'Plan the launch');
    await key(input, 'Enter');
    expect(ops(host, 'page.create')[0]).toMatchObject({
      payload: { title: 'Plan the launch', row: { values: { [P.due]: { start: '2026-11-13' } } } },
    });
  });

  it("zooms by the timeline's own buttons, and keeps the zoom in the view", async () => {
    const { view, host } = await timelineOf(20);
    await mount(view);
    const months = container.querySelector<HTMLElement>('[data-cg-timeline-scale="month"]')!;
    expect(months.getAttribute('aria-pressed')).toBe('false');
    await click(months);
    expect(
      container.querySelector('[data-cg-timeline-scale="month"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
    const upserts = ops(host, 'view.upsert') as unknown as {
      payload: { config: { timeline: { scale: string } } };
    }[];
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload.config.timeline.scale).toBe('month');
  });

  it('lets a reader look, zoom and open, and move nothing', async () => {
    const { view, host } = await timelineOf(60, {}, { canEdit: false });
    await mount(view);
    const bar = bars()[0];
    expect(bar.hasAttribute('aria-describedby')).toBe(false);
    bar.focus();
    await key(bar, 'ArrowRight', { altKey: true });
    await click(bar);
    expect(ops(host, 'row.update')).toHaveLength(0);
    expect(host.opened.at(-1)).toEqual({ kind: 'row', id: bar.dataset.cgTimelineItem });
    await click(container.querySelector<HTMLElement>('[data-cg-timeline-scale="day"]')!);
    expect(
      container.querySelector('[data-cg-timeline-scale="day"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(ops(host, 'view.upsert')).toHaveLength(0);
  });

  it('moves the focus down the lines with the arrows', async () => {
    const { view } = await timelineOf(200);
    await mount(view);
    const [first, second] = bars();
    first.focus();
    await key(first, 'ArrowDown');
    await nextFrame();
    expect(document.activeElement).toBe(
      container.querySelector(`[data-cg-timeline-item="${second.dataset.cgTimelineItem}"]`),
    );
    expect(container.querySelectorAll('[data-cg-timeline-item][tabindex="0"]').length).toBe(1);
  });

  it('asks for a date property when it has none', async () => {
    const { view } = await timelineOf(3, { start: null });
    await mount(view);
    expect(container.querySelector('.cgw-view-setup')!.textContent).toContain('Choose one');
  });
});
