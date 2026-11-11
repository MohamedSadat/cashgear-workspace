// Spikes S5 and S6 in real browsers: the RTL and Arabic input checklist, and the editor budgets,
// in Chrome (Playwright) and in WebView2 (bench/webview2-host over CDP).
//   node bench/editor/run-browser.mjs [--s5] [--s6] [--chrome] [--webview2]
// With no flags, everything. Writes bench/results/s5-rtl.json and s6-perf.json.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = new Set(process.argv.slice(2));
const all = !['--s5', '--s6', '--s7'].some((a) => args.has(a));
const browsers = ['--chrome', '--webview2'].some((a) => args.has(a))
  ? ['chrome', 'webview2'].filter((b) => args.has(`--${b}`))
  : ['chrome', 'webview2'];
const URL_BASE = 'http://127.0.0.1:4290/';

const freePort = () =>
  new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

async function waitFor(url, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + url);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openBrowser(kind) {
  if (kind === 'chrome') {
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    return { browser, page, version: browser.version(), close: () => browser.close() };
  }
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'cgw-spike-webview2-'));
  const child = spawn(join(root, 'target/release/cgw-webview2-host.exe'), ['about:blank'], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdio: 'ignore',
  });
  await waitFor(`http://127.0.0.1:${port}/json/version`, 45000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  return {
    browser,
    page,
    version: browser.version(),
    close: async () => {
      await browser.close().catch(() => {});
      child.kill();
      await new Promise((r) => setTimeout(r, 1000));
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

async function load(page, dir = 'rtl') {
  await page.goto(`${URL_BASE}?dir=${dir}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, {
    timeout: 30000,
  });
}

const call = (page, fn, ...a) => page.evaluate(([f, a]) => window.spike[f](...a), [fn, a]);
/** A key press, then a frame so ProseMirror has read the browser's selection change. */
async function press(page, key) {
  await page.keyboard.press(key);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
}

// ---------------------------------------------------------------- S5
async function s5(page) {
  const items = [];
  const check = (name, pass, detail) => items.push({ name, pass: !!pass, detail });
  await load(page, 'rtl');
  await call(page, 'openChecklist');
  const rect = (sel, n) => call(page, 'rect', sel, n);

  const arabic = await rect('.cgw-body', 1);
  const english = await rect('.cgw-body', 2);
  const mixed = await rect('.cgw-body', 3);
  check('Arabic paragraph runs right to left', arabic.direction === 'rtl', arabic.direction);
  check(
    'English paragraph in an Arabic page runs left to right',
    english.direction === 'ltr',
    english.direction,
  );
  check(
    'Mixed paragraph that starts in Arabic runs right to left',
    mixed.direction === 'rtl',
    mixed.direction,
  );

  const listPadding = await page.evaluate(() => {
    const item = document.querySelector('[data-kind="bulletItem"]');
    const nested = document.querySelector('.cgw-block > .cgw-block');
    const s = getComputedStyle(item);
    const n = getComputedStyle(nested);
    return {
      right: s.paddingRight,
      left: s.paddingLeft,
      nestedRight: n.paddingRight,
      nestedLeft: n.paddingLeft,
      markerRight: getComputedStyle(item, '::before').right,
    };
  });
  check(
    'List marker and nesting sit on the right',
    listPadding.right !== '0px' &&
      listPadding.left === '0px' &&
      listPadding.nestedRight !== '0px' &&
      listPadding.nestedLeft === '0px',
    listPadding,
  );
  const numbered = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-kind="numberedItem"]'), '::before').right,
  );
  check('Numbered marker sits on the right', numbered !== 'auto', numbered);

  const cell0 = await rect('td', 0);
  const cell1 = await rect('td', 1);
  check('Table columns run right to left', cell0.x > cell1.x, { first: cell0.x, second: cell1.x });

  const handle = await rect('.cgw-handle', 1);
  const block = await rect('.ProseMirror > .cgw-block', 1);
  check('Block handle sits on the right of its block', handle.x >= block.x + block.width - 4, {
    handle: handle.x,
    blockRight: block.x + block.width,
  });

  // Caret movement with arrows: in RTL text the left arrow moves forward in the text.
  await call(page, 'caret', 1, 3);
  await press(page, 'ArrowLeft');
  const left = await call(page, 'selection');
  await press(page, 'ArrowRight');
  const right = await call(page, 'selection');
  check(
    'ArrowLeft moves forward in Arabic text, ArrowRight back',
    left.offset === 4 && right.offset === 3,
    { left: left.offset, right: right.offset },
  );
  await call(page, 'caret', 2, 3);
  await press(page, 'ArrowRight');
  const ltr = await call(page, 'selection');
  check('ArrowRight moves forward in English text', ltr.offset === 4, ltr.offset);

  // Through a paragraph that mixes directions, the arrow keys reach every position and the end.
  const mixedText = await call(page, 'blockText', 3);
  await call(page, 'caret', 3, 0);
  const visited = new Set([0]);
  for (let i = 0; i < mixedText.length * 2 && visited.size <= mixedText.length; i++) {
    await press(page, 'ArrowLeft');
    const s = await call(page, 'selection');
    if (s.block !== 3) break;
    visited.add(s.offset);
  }
  check(
    'Arrow keys visit every caret position in a mixed-direction paragraph',
    visited.size === mixedText.length + 1,
    { visited: visited.size, positions: mixedText.length + 1 },
  );

  await call(page, 'caret', 1, 0);
  await press(page, 'End');
  const end = await call(page, 'selection');
  check(
    'End goes to the end of an Arabic line',
    end.offset === (await call(page, 'blockText', 1)).length,
    end.offset,
  );

  // Selection across directions: from Arabic into the English paragraph.
  await call(page, 'caret', 1, 5);
  await page.keyboard.down('Shift');
  await press(page, 'ArrowDown');
  await press(page, 'ArrowDown');
  await page.keyboard.up('Shift');
  const across = await call(page, 'selection');
  check(
    'A selection runs from an Arabic paragraph into an English one',
    /[؀-ۿ]/.test(across.selectedText) &&
      /[A-Za-z]/.test(across.selectedText) &&
      across.domSelection.length > 0,
    { selected: across.selectedText.slice(0, 80) },
  );

  // Arabic text as a keyboard or IME commits it, into the empty last paragraph.
  await call(page, 'caret', 12, 0);
  await page.keyboard.insertText('مرحبا');
  check(
    'Arabic text typed into a paragraph lands in the document and in Yjs',
    (await call(page, 'blockText', 12)) === 'مرحبا' &&
      (await call(page, 'yjsText')).includes('مرحبا'),
    await call(page, 'blockText', 12),
  );

  // The Arabic IME path: composition events, then the commit.
  const cdp = await page.context().newCDPSession(page);
  const original = await call(page, 'blockText', 11);
  await call(page, 'caret', 11, 0);
  for (const partial of ['س', 'سل', 'سلا'])
    await cdp.send('Input.imeSetComposition', {
      text: partial,
      selectionStart: partial.length,
      selectionEnd: partial.length,
    });
  await cdp.send('Input.insertText', { text: 'سلام' });
  await page.waitForTimeout(100);
  const imeText = await call(page, 'blockText', 11);
  check(
    'IME composition commits once, with no leftover composed text',
    imeText === 'سلام' + original &&
      (await call(page, 'yjsText')).includes('سلام' + original.slice(0, 5)),
    imeText,
  );

  // No caret jump when a peer types earlier in the same paragraph (Tiptap #8611), in a real DOM.
  await call(page, 'connectPeer');
  await call(page, 'caret', 1, 10);
  const beforePeer = await call(page, 'selection');
  await call(page, 'peerInsert', 1, 2, 'XYZ');
  await page.waitForTimeout(50);
  const afterPeer = await call(page, 'selection');
  check(
    'No caret jump when a peer types earlier in the same paragraph',
    afterPeer.offset === beforePeer.offset + 3 &&
      afterPeer.before === beforePeer.before &&
      afterPeer.after === beforePeer.after,
    { before: beforePeer.offset, after: afterPeer.offset },
  );
  await page.keyboard.insertText('ك');
  const typedAfterPeer = await call(page, 'blockText', 1);
  check(
    'Typing after a peer edit lands at the caret',
    typedAfterPeer.slice(afterPeer.offset, afterPeer.offset + 1) === 'ك',
    typedAfterPeer,
  );

  check(
    'The binding reported no invalid content',
    (await call(page, 'contentErrors')).length === 0,
    await call(page, 'contentErrors'),
  );
  await page.screenshot({ path: join(root, `bench/results/s5-${page.__kind}.png`) });
  return items;
}

// ---------------------------------------------------------------- S6
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
const round = (n) => Math.round(n * 10) / 10;

async function s6(page) {
  const cdp = await page.context().newCDPSession(page);
  const rows = [];
  for (const blocks of [200, 2000, 5000]) {
    await load(page, 'ltr');
    const runs = blocks === 5000 ? 10 : 30;
    const open = [];
    // The spike's handle puts a widget on every block; the real one (Track U3) is one floating
    // element, so the budgets are measured without it. Its cost is reported on its own.
    for (let i = 0; i < runs; i++)
      open.push(await call(page, 'open', blocks, 'mixed', { handle: false }));
    // Typing in the middle of the page, English letters so each is a real key press.
    await call(page, 'caret', Math.floor((await call(page, 'blockCount')) / 2), 0);
    await call(page, 'keystrokes');
    await call(page, 'editorWork');
    await page.keyboard.type('the quick brown fox jumps over the lazy dog and keeps typing', {
      delay: 35,
    });
    await page.waitForTimeout(200);
    const keys = await call(page, 'keystrokes');
    const work = await call(page, 'editorWork');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    rows.push({
      blocks,
      openRuns: runs,
      openP50: round(percentile(open, 0.5)),
      openP95: round(percentile(open, 0.95)),
      keystrokes: keys.length,
      keyP50: round(percentile(keys, 0.5)),
      keyP95: round(percentile(keys, 0.95)),
      workP50: round(percentile(work, 0.5)),
      workP95: round(percentile(work, 0.95)),
      heapUsedMB: round(heap.usedSize / 1048576),
      domNodes: await call(page, 'domNodes'),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- S7
async function s7(page) {
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await load(page, 'ltr');
  const known = await call(page, 'hostile', false);
  await load(page, 'ltr');
  const unknown = await call(page, 'hostile', true);
  return { known, unknown, dialogs };
}

// ---------------------------------------------------------------- main
mkdirSync(join(root, 'bench/results'), { recursive: true });
const server = spawn(process.execPath, [join(here, 'node_modules/vite/bin/vite.js'), 'preview'], {
  cwd: here,
  stdio: 'ignore',
});
const s5Results = {};
const s6Results = {};
const s7Results = {};
try {
  await waitFor(URL_BASE);
  for (const kind of browsers) {
    const opened = await openBrowser(kind);
    opened.page.__kind = kind;
    try {
      if (all || args.has('--s5'))
        s5Results[kind] = { version: opened.version, items: await s5(opened.page) };
      if (all || args.has('--s6'))
        s6Results[kind] = { version: opened.version, rows: await s6(opened.page) };
      if (all || args.has('--s7'))
        s7Results[kind] = { version: opened.version, ...(await s7(opened.page)) };
    } finally {
      await opened.close();
    }
  }
} finally {
  server.kill();
  if (process.platform === 'win32')
    spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
}
if (Object.keys(s5Results).length)
  writeFileSync(join(root, 'bench/results/s5-rtl.json'), JSON.stringify(s5Results, null, 2) + '\n');
if (Object.keys(s6Results).length)
  writeFileSync(
    join(root, 'bench/results/s6-perf.json'),
    JSON.stringify(s6Results, null, 2) + '\n',
  );
for (const [kind, result] of Object.entries(s5Results)) {
  console.log(`S5 ${kind} ${result.version}`);
  for (const item of result.items)
    console.log(`  ${item.pass ? 'pass' : 'FAIL'}  ${item.name}  ${JSON.stringify(item.detail)}`);
}
for (const [kind, result] of Object.entries(s6Results)) {
  console.log(`S6 ${kind} ${result.version}`);
  for (const row of result.rows) console.log('  ' + JSON.stringify(row));
}
if (Object.keys(s7Results).length)
  writeFileSync(
    join(root, 'bench/results/s7-browser.json'),
    JSON.stringify(s7Results, null, 2) + '\n',
  );
for (const [kind, result] of Object.entries(s7Results))
  console.log(
    `S7 ${kind} ${result.version}\n  ${JSON.stringify({ known: result.known, unknown: result.unknown, dialogs: result.dialogs })}`,
  );
const s7Failed = Object.values(s7Results).some(
  (r) =>
    r.dialogs.length > 0 ||
    [r.known, r.unknown].some(
      (x) =>
        x.scriptsRan.length ||
        x.unsafeLinks.length ||
        x.eventAttributes.length ||
        x.dangerousElements.length ||
        x.styleWithScript,
    ),
);
const failed = Object.values(s5Results).some((r) => r.items.some((i) => !i.pass)) || s7Failed;
process.exit(failed ? 1 : 0);
