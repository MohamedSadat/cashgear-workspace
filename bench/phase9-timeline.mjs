// Phase 9's timeline budgets (IMPLEMENTATION_PLAN.md, Phase 9, Performance benchmarks: "the first
// bars of a 50,000-row database ≤ 500 ms; dragging at 60 frames a second"), as a piece for
// bench/phase9.mjs to run and gate with its other figures. Written by the timeline stream and not
// run there (the parent's proof runs the benches, which own the server stack and the ports).
//
//   import { TIMELINE_BUDGETS, measureTimeline, seedTimelineDatabase } from './phase9-timeline.mjs';
//   const seeded = await seedTimelineDatabase(api);      // through the API, as phase4.mjs seeds
//   // a Chrome page signed in as that account (scripts/cloud-account.mjs `signInPage`), then
//   const figures = await measureTimeline(page, seeded, { log });
//
// The database: a title, Start and End dates, a Stage select and Notes; its first view a timeline
// by Start (by weeks, the rows with no date beside it), then a table. 50,000 rows through the
// server's import route (`POST /databases/{id}/import`, as the import dialog sends a large file):
// starts spread over eight years from 2022 (about 17 a day), each 0 to 8 days long, one row in 50
// with no date. Over `LOCAL_ROW_LIMIT`, so the server answers the timeline's queries: its date window
// (the days shown and as many again on each side) holds a few thousand rows.
//   - first bars: from setting the database page's route to its timeline drawing a bar; the first
//     open (the server reads the database's rows into its cache: tracked), then the median of five
//     opens after it, each from another page (budget 500 ms);
//   - a drag: a bar's body dragged by the mouse (pointer events, page.mouse) over 120 moves along
//     its line and back, after a warm-up drag (the first drag in a fresh Chrome has one long frame
//     with no script in it); frame intervals by requestAnimationFrame, p95 (budget 17.5 ms: 60
//     frames a second, as Phase 4's board drag is read). The drop writes the row's dates, as a
//     person's drag does.
import { randomBytes } from 'node:crypto';

/** Budgets, with the margin a regression must also exceed to fail, as bench/phase4.mjs has them. */
export const TIMELINE_BUDGETS = {
  timelineFirstBars50kMs: { max: 500, unit: 'ms', slack: 100 },
  timelineDragFrameP95: { max: 17.5, unit: 'ms', slack: 3 },
  // Tracked, not budgeted.
  timelineFirstBars50kColdMs: { max: Infinity, unit: 'ms', slack: 1000 },
  timelineImport50kMs: { max: Infinity, unit: 'ms', slack: 10000 },
};

const ROWS = Number(process.env.PHASE9_TIMELINE_ROWS ?? 50000);
/** Property ids (8 characters of base 62) and the Stage options. */
export const TIMELINE_P = {
  start: 'Start001',
  end: 'End00001',
  stage: 'Stage001',
  notes: 'Notes001',
};
export const STAGES = ['Backlog', 'Planned', 'Doing', 'Review', 'Done'];
const STAGE_IDS = STAGES.map((_, i) => `Stg0000${i}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, width = 2) => String(n).padStart(width, '0');
const dayText = (day) => {
  const d = new Date(day * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

function uuidv7() {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Row `i`'s dates (`null` for a row with no date): the import's and the specs' one rule. */
export function rowDates(i, rows = ROWS) {
  if (i % 50 === 49) return null;
  const first = Date.UTC(2022, 0, 1) / 86_400_000;
  const start = first + Math.floor((i * 2922) / rows);
  return { start: dayText(start), end: dayText(start + (i % 9)) };
}

/**
 * A workspace with a timeline over a database of `rows` rows (default 50,000), through the API as
 * a client makes it, the rows by the import route. Gives its ids and the import's time.
 */
export async function seedTimelineDatabase(api, { rows = ROWS, name = 'Phase 9 timeline' } = {}) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name });
  const now = new Date().toISOString();
  const op = (type, entityId, payload) => ({
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion: null,
    payload,
    createdAt: now,
  });
  const check = (answer) => {
    const refused = answer.results.filter((r) => r.status !== 'applied');
    if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
  };
  const section = uuidv7();
  const databaseId = uuidv7();
  const other = uuidv7();
  const page = (id, kind, title, orderKey, extra = {}) => ({
    id,
    workspaceId,
    sectionId: section,
    parentPageId: null,
    orderKey,
    kind,
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    ...extra,
  });
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op('section.create', section, {
          id: section,
          workspaceId,
          name: 'Shared',
          orderKey: 'a0',
          visibility: 'workspace',
          version: 1,
          createdAt: now,
        }),
        op('page.create', other, page(other, 'page', 'Another page', 'a0')),
        op(
          'page.create',
          databaseId,
          page(databaseId, 'database', 'Fifty thousand dates', 'a1', {
            database: {
              properties: [
                { id: 'title', name: 'Name', type: 'title' },
                { id: TIMELINE_P.start, name: 'Start', type: 'date', date: { includeTime: false } },
                { id: TIMELINE_P.end, name: 'End', type: 'date', date: { includeTime: false } },
                {
                  id: TIMELINE_P.stage,
                  name: 'Stage',
                  type: 'select',
                  options: STAGES.map((n, i) => ({ id: STAGE_IDS[i], name: n, colour: 'blue' })),
                },
                { id: TIMELINE_P.notes, name: 'Notes', type: 'text' },
              ],
            },
          }),
        ),
      ],
    }),
  );
  const timelineId = uuidv7();
  const tableId = uuidv7();
  const view = (id, viewName, type, orderKey, config) => ({
    id,
    workspaceId,
    databaseId,
    name: viewName,
    type,
    orderKey,
    config: {
      filter: null,
      sorts: [],
      group: null,
      properties: { order: [], hidden: [], widths: {} },
      ...config,
    },
    version: 1,
    createdAt: now,
    // As a build that knows the timeline sends it.
    viewTypes: 6,
  });
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op(
          'view.upsert',
          timelineId,
          view(timelineId, 'Timeline', 'timeline', 'a0', {
            sorts: [{ propertyId: TIMELINE_P.start, direction: 'asc' }],
            timeline: {
              start: TIMELINE_P.start,
              end: null,
              lane: null,
              scale: 'week',
              undated: true,
            },
          }),
        ),
        op('view.upsert', tableId, view(tableId, 'Table', 'table', 'a1', {})),
      ],
    }),
  );
  // The rows, through the import route (as the import dialog sends a file over 5,000 rows). The
  // End column is the Start's own end: each row's span is its Start value's range.
  const lines = ['Name,Start,Stage,Notes'];
  for (let i = 0; i < rows; i++) {
    const dates = rowDates(i, rows);
    const span = dates ? `${dates.start} → ${dates.end}` : '';
    lines.push(`Item ${pad(i, 5)},${span},${STAGES[i % 5]},Note number ${i}`);
  }
  const started = Date.now();
  const answer = await api.post(`/api/v1/databases/${databaseId}/import`, {
    csv: lines.join('\r\n') + '\r\n',
    columns: ['title', TIMELINE_P.start, TIMELINE_P.stage, TIMELINE_P.notes],
    header: true,
  });
  const importMs = Date.now() - started;
  if (answer.created !== rows)
    throw new Error(`The import made ${answer.created} rows: ${JSON.stringify(answer.problems)}`);
  return { workspaceId, databaseId, other, timelineId, tableId, importMs, rows };
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;

/** From setting the route to the timeline's first bar drawn, in the page. */
function openTimed(databaseId) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    location.hash = `#/p/${databaseId}`;
    const check = () => {
      if (document.querySelector('.cgw-database-page .cgw-db-tl [data-cg-timeline-item]'))
        return resolve(performance.now() - started);
      if (performance.now() - started > 60000) return reject(new Error('No bar in 60 s'));
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

function startFrames() {
  window.__frames = [];
  window.__framing = true;
  let last = performance.now();
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    if (window.__framing) requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });
}
const stopFrames = () => {
  window.__framing = false;
  return window.__frames.splice(0);
};

/**
 * The figures, in a page signed in as the seeding account (the database's own page, a fresh
 * profile: its first view, the timeline): the first bars' times and the drag's frames.
 */
export async function measureTimeline(page, seeded, { opens = 6, log = console.log } = {}) {
  log('First bars of the 50,000-row timeline');
  const times = [];
  for (let i = 0; i < opens; i++) {
    await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.other);
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
    await sleep(i === 0 ? 0 : 500);
    times.push(await page.evaluate(openTimed, seeded.databaseId));
  }
  const [cold, ...warm] = times;
  log(`  first open ${round(cold)} ms; then ${warm.map(round).join(', ')} ms`);
  // The window's pages come in after the first: let them, so the drag meets a settled view.
  await page.waitForFunction(
    () => document.querySelector('.cgw-database-page .cgw-db-tl-status')?.textContent === '',
    null,
    { timeout: 60000 },
  );

  log('Dragging a bar along its line');
  // A bar wholly in view (lines are drawn past the view's edges), with room after it to drag.
  // The first lines are rows already under way, cut at the inline-start edge (the view's order is
  // earliest start first): the lines are scrolled down, as a person would, until one is whole.
  const index = await page.evaluate(async () => {
    const scroller = document.querySelector('.cgw-database-page [data-cg-timeline-scroller]');
    if (!scroller) return -1;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    for (let step = 0; step < 80; step++) {
      const view = scroller.getBoundingClientRect();
      const bars = [...document.querySelectorAll('.cgw-database-page [data-cg-timeline-item]')];
      const found = bars.findIndex((bar) => {
        const box = bar.getBoundingClientRect();
        return (
          box.left >= view.left + 8 &&
          box.right <= view.left + view.width / 2 &&
          box.top >= view.top + 60 &&
          box.bottom <= view.bottom - 8
        );
      });
      if (found >= 0) return found;
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(100, scroller.clientHeight - 128);
      if (scroller.scrollTop === before) return -1;
      await frame();
      await frame();
    }
    return -1;
  });
  if (index < 0) throw new Error('No bar wholly in the first half of the view');
  const bar = page.locator('.cgw-database-page [data-cg-timeline-item]').nth(index);
  await bar.waitFor({ timeout: 30000 });
  const drag = async (measure) => {
    const box = await bar.boundingBox();
    if (!box) throw new Error('The bar is not drawn');
    const x0 = box.x + box.width / 2;
    const y0 = box.y + box.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    if (measure) await page.evaluate(startFrames);
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      // Out 300 px and back, a little off the line as a hand drags.
      const along = i <= steps / 2 ? i / (steps / 2) : (steps - i) / (steps / 2);
      await page.mouse.move(x0 + along * 300, y0 + Math.sin(i / 6) * 6);
    }
    const frames = measure ? (await page.evaluate(stopFrames)).slice(2) : [];
    // A day on, so the drop writes something as a person's would.
    await page.mouse.move(x0 + 20, y0);
    await page.mouse.up();
    await sleep(800);
    return frames;
  };
  await drag(false);
  const frames = await drag(true);
  log(
    `  ${frames.length} frames, p50 ${round(percentile(frames, 0.5))} ms, p95 ${round(percentile(frames, 0.95))} ms, max ${round(Math.max(...frames))} ms`,
  );
  return {
    firstBars: {
      coldMs: round(cold),
      warm: warm.map(round),
      medianMs: round(percentile(warm, 0.5)),
    },
    drag: {
      frames: frames.length,
      frameP50: round(percentile(frames, 0.5)),
      frameP95: round(percentile(frames, 0.95)),
      max: round(Math.max(...frames)),
    },
    figures: {
      timelineFirstBars50kMs: round(percentile(warm, 0.5)),
      timelineFirstBars50kColdMs: round(cold),
      timelineDragFrameP95: round(percentile(frames, 0.95)),
      timelineImport50kMs: seeded.importMs,
    },
  };
}
