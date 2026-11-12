// Makes the migration fixtures: a store written by each earlier release's own cgw-store, as that
// release's webview drove it. Each release's crate is taken from its tag (git show), built under
// target/store-fixtures, and sent the frames below over cgw-store-cli; then the same build answers a
// fixed list of reads, and the answers are kept beside the store (`expected.json`). The tests open a
// copy of each store with this build and check it answers every one of those reads the same way.
//   node crates/cgw-store/tests/fixtures/make.mjs
// Needs git and cargo (offline: the crates the workspace uses are in the local cache).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const work = join(root, 'target/store-fixtures');
const exe = process.platform === 'win32' ? '.exe' : '';

/** The releases whose stores are kept: the tag, and the store schema version it wrote. */
const RELEASES = [
  { tag: 'v0.1.0', version: 1 },
  { tag: 'v0.2.0', version: 2 },
];

// Frames: u32 LE header length, the JSON header, u32 LE blob count, each blob as u32 LE length
// and bytes (crates/cgw-store/src/lib.rs).
function encodeFrame(header, blobs = []) {
  const json = Buffer.from(JSON.stringify(header));
  const parts = [u32(json.length), json, u32(blobs.length)];
  for (const blob of blobs) parts.push(u32(blob.length), Buffer.from(blob));
  return Buffer.concat(parts);
}

function decodeFrame(bytes) {
  let at = 0;
  const read = () => {
    const value = bytes.readUInt32LE(at);
    at += 4;
    return value;
  };
  const headerLength = read();
  const header = JSON.parse(bytes.subarray(at, at + headerLength).toString('utf8'));
  at += headerLength;
  const blobs = [];
  for (let count = read(); count > 0; count--) {
    const length = read();
    blobs.push([...bytes.subarray(at, at + length)]);
    at += length;
  }
  return { header, blobs };
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

/** Builds each release's cgw-store-cli from its tag, in one scratch workspace. */
function build() {
  const scratch = join(work, 'build');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const show = (tag, path) => {
    const result = spawnSync('git', ['show', `${tag}:${path}`], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git show ${tag}:${path}: ${result.stderr}`);
    return result.stdout;
  };
  for (const { tag, version } of RELEASES) {
    const dir = join(scratch, `v${version}`);
    mkdirSync(join(dir, 'src/bin'), { recursive: true });
    writeFileSync(join(dir, 'src/lib.rs'), show(tag, 'crates/cgw-store/src/lib.rs'));
    writeFileSync(
      join(dir, 'src/bin/cgw-store-cli.rs'),
      show(tag, 'crates/cgw-store/src/bin/cgw-store-cli.rs'),
    );
    // The release's dependencies, with its lock file below: the crate as it shipped.
    const manifest = show(tag, 'crates/cgw-store/Cargo.toml');
    const dependencies = manifest.slice(
      manifest.indexOf('[dependencies]'),
      manifest.indexOf('[dev-'),
    );
    writeFileSync(
      join(dir, 'Cargo.toml'),
      [
        '[package]',
        `name = "cgw-store-v${version}"`,
        'version = "0.0.0"',
        'edition = "2021"',
        'publish = false',
        '',
        '[lib]',
        'name = "cgw_store"',
        'path = "src/lib.rs"',
        '',
        '[[bin]]',
        `name = "cgw-store-cli-v${version}"`,
        'path = "src/bin/cgw-store-cli.rs"',
        '',
        dependencies.trim(),
        '',
      ].join('\n'),
    );
  }
  writeFileSync(
    join(scratch, 'Cargo.toml'),
    `[workspace]\nresolver = "2"\nmembers = [${RELEASES.map((r) => `"v${r.version}"`).join(', ')}]\n`,
  );
  writeFileSync(join(scratch, 'Cargo.lock'), show(RELEASES.at(-1).tag, 'Cargo.lock'));
  const cargo = spawnSync(
    'cargo',
    ['build', '--offline', '--bins', '--target-dir', join(work, 'target')],
    { cwd: scratch, stdio: 'inherit' },
  );
  if (cargo.status !== 0) throw new Error('cargo build failed');
}

/** Runs one store's CLI in `dir`: `send` writes a request and resolves with its answer. */
function open(version, dir) {
  const child = spawn(join(work, 'target/debug', `cgw-store-cli-v${version}${exe}`), [dir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      waiting.shift().resolve(decodeFrame(buffer.subarray(4, 4 + length)));
      buffer = buffer.subarray(4 + length);
    }
  });
  child.on('exit', () => {
    for (const w of waiting.splice(0)) w.reject(new Error(`cgw-store-cli-v${version} exited`));
  });
  const send = (header, blobs = []) =>
    new Promise((resolveAnswer, reject) => {
      waiting.push({ resolve: resolveAnswer, reject });
      const frame = encodeFrame(header, blobs);
      child.stdin.write(Buffer.concat([u32(frame.length), frame]));
    }).then((answer) => {
      if (answer.header.error !== undefined)
        throw new Error(`${header.op}: ${answer.header.error}`);
      return answer;
    });
  const close = () =>
    new Promise((done) => {
      child.once('exit', done);
      child.stdin.end();
    });
  return { send, close };
}

// The data: fixed ids and times, so the fixtures only change when this file does.
const id = (n) => `0190f5a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ACCOUNT = id(0xacc);
const T0 = '2026-03-01T09:00:00.000Z';
const time = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const workspace = (n, synced) => ({
  id: id(n),
  name: synced ? 'Team' : 'Mine',
  icon: synced ? '📘' : null,
  createdAt: T0,
  version: synced ? 4 : 1,
  localOnly: !synced,
  deletedAt: null,
  ...(synced ? { accountId: ACCOUNT, role: 'owner' } : {}),
});
const section = (n, ws, name, orderKey, visibility = 'workspace') => ({
  id: id(n),
  workspaceId: ws.id,
  name,
  orderKey,
  visibility,
  version: 1,
  createdAt: T0,
});
const page = (n, ws, sectionId, parentPageId, title, orderKey, extra = {}) => ({
  id: id(n),
  workspaceId: ws.id,
  sectionId,
  parentPageId,
  orderKey,
  kind: 'page',
  title,
  icon: null,
  coverAssetId: null,
  isTemplate: false,
  templateOfPageId: null,
  version: 1,
  createdAt: T0,
  updatedAt: T0,
  trashedAt: null,
  trashRootId: null,
  ...extra,
});
const op = (n, type, ws, entityId, payload, baseVersion = null) => ({
  opId: id(n),
  type,
  workspaceId: ws.id,
  entityId,
  baseVersion,
  payload,
  createdAt: time(n % 60),
});
const asset = (n, ws, extra = {}) => ({
  id: id(n),
  workspaceId: ws.id,
  fileName: 'تقرير.png',
  contentType: 'image/png',
  sizeBytes: 4,
  sha256: 'b'.repeat(64),
  width: 2,
  height: 2,
  createdAt: T0,
  ...extra,
});
const plan = (parts) => ({
  workspaces: [],
  sections: [],
  pages: [],
  favourites: [],
  visits: [],
  deleteSections: [],
  deletePages: [],
  deleteFavourites: [],
  deleteVisits: [],
  outbox: [],
  ...parts,
});

/** A workspace's tree: A > B, C, and T in the trash, in two sections, a favourite and a visit. */
function tree(ws, base) {
  const pagesSection = section(base + 1, ws, 'Pages', 'a0');
  const privateSection = section(base + 2, ws, 'Private', 'a1', 'private');
  const a = page(base + 10, ws, pagesSection.id, null, 'Alpha', 'a0');
  const b = page(base + 11, ws, pagesSection.id, a.id, 'بيتا', 'a0');
  const c = page(base + 12, ws, pagesSection.id, null, 'Gamma', 'a1');
  const t = page(base + 13, ws, privateSection.id, null, 'Old notes', 'a0', {
    version: 2,
    trashedAt: time(30),
    trashRootId: id(base + 13),
  });
  return {
    sections: [pagesSection, privateSection],
    pages: [a, b, c, t],
    favourites: [{ workspaceId: ws.id, pageId: a.id, orderKey: 'a0' }],
    visits: [{ workspaceId: ws.id, pageId: b.id, lastVisitedAt: time(40) }],
    a,
    b,
    c,
    t,
  };
}

/** The frames a release's webview sent: the writes, and the reads whose answers are kept. */
function scenario(version) {
  const synced = version >= 2;
  const ws = workspace(0x100, synced);
  const t = tree(ws, 0x100);
  const local = synced ? workspace(0x200, false) : null;
  const lt = local && tree(local, 0x200);
  const creates = (w, wt, from) => [
    op(from, 'workspace.create', w, w.id, w),
    ...wt.sections.map((s, i) => op(from + 1 + i, 'section.create', w, s.id, s)),
    ...wt.pages.map((p, i) => op(from + 3 + i, 'page.create', w, p.id, { ...p, version: 1 })),
    op(from + 7, 'page.trash', w, wt.t.id, {}, 1),
    op(from + 8, 'favourite.set', w, wt.a.id, { favourite: true, orderKey: 'a0' }),
    op(from + 9, 'visit.record', w, wt.b.id, { at: time(40) }),
  ];
  // Version 1 never sent anything; a synced workspace's creates were answered, one rename waits.
  const outbox = synced
    ? [op(0x300, 'page.update', ws, t.c.id, { title: 'Gamma 2' }, 1), ...creates(local, lt, 0x310)]
    : creates(ws, t, 0x300);
  const assets = [
    asset(0x400, ws, synced ? { uploaded: false } : {}),
    ...(synced ? [asset(0x401, ws, { uploaded: true })] : []),
  ];
  const historyId = id(0x500);
  const writes = [
    [
      {
        op: 'applyPlan',
        plan: plan({
          workspaces: [ws, ...(local ? [local] : [])],
          sections: [...t.sections, ...(lt ? lt.sections : [])],
          pages: [...t.pages, ...(lt ? lt.pages : [])],
          favourites: [...t.favourites, ...(lt ? lt.favourites : [])],
          visits: [...t.visits, ...(lt ? lt.visits : [])],
          outbox,
          ...(synced ? { cursor: { workspaceId: ws.id, value: 42 } } : {}),
        }),
      },
    ],
    // A: a snapshot, then later updates (sent, pulled and unsent ones when synced).
    [
      { op: 'appendDocUpdates', pageId: t.a.id, updateIds: [id(0x601), id(0x602)] },
      [[0x01, 0x00, 0xff], [0x02]],
    ],
    ...(synced
      ? [
          [{ op: 'ackDocUpdates', pageId: t.a.id, acks: [{ updateId: id(0x601), seq: 1 }] }],
          [
            {
              op: 'applyRemoteDocUpdates',
              pageId: t.a.id,
              epoch: 0,
              headSeq: 2,
              updates: [{ seq: 2, updateId: null, id: id(0x603) }],
            },
            [[0x22]],
          ],
        ]
      : []),
    [{ op: 'compactDoc', pageId: t.a.id, coversLocalUpTo: 1 }, [[0x09, 0x09, 0x09]]],
    [{ op: 'appendDocUpdates', pageId: t.a.id, updateIds: [id(0x604)] }, [[0x03, 0x03]]],
    // B: an update that failed to decode, moved to the corrupt area, and one that loads.
    [
      { op: 'appendDocUpdates', pageId: t.b.id, updateIds: [id(0x611), id(0x612)] },
      [[0x0b], [0xde, 0xad]],
    ],
    [{ op: 'quarantineUpdates', pageId: t.b.id, localSeqs: [2], reason: 'doc.undecodable' }],
    // C: only a snapshot (and, synced, the cursor of what it was pulled at).
    synced
      ? [
          {
            op: 'applyRemoteDocUpdates',
            pageId: t.c.id,
            epoch: 1,
            headSeq: 5,
            updates: [{ seq: 5, updateId: id(0x621), id: id(0x621) }],
          },
          [[0x0c]],
        ]
      : [{ op: 'appendDocUpdates', pageId: t.c.id, updateIds: [id(0x621)] }, [[0x0c]]],
    [{ op: 'compactDoc', pageId: t.c.id, coversLocalUpTo: 1 }, [[0x05, 0x05]]],
    ...(lt
      ? [[{ op: 'appendDocUpdates', pageId: lt.a.id, updateIds: [id(0x631)] }, [[0x0d]]]]
      : []),
    [
      {
        op: 'addHistory',
        entry: { id: historyId, pageId: t.a.id, createdAt: time(50) },
        keep: 20,
      },
      [[0x08, 0x08]],
    ],
    [
      {
        op: 'putSearchEntry',
        entry: { pageId: t.a.id, workspaceId: ws.id, title: 'alpha', text: 'the quarterly report' },
      },
    ],
    [
      {
        op: 'putSearchEntry',
        entry: { pageId: t.b.id, workspaceId: ws.id, title: 'بيتا', text: 'تقرير المبيعات الشهري' },
      },
    ],
    ...assets.map((a) => [{ op: 'putAsset', asset: a }, [[0x89, 0x50, 0x4e, 0x47]]]),
    [{ op: 'setPref', key: 'toggles', value: { [t.a.id]: true } }],
    [{ op: 'setPref', key: 'theme', value: 'dark' }],
  ];

  const workspaces = [ws, ...(local ? [local] : [])];
  const pages = [...t.pages, ...(lt ? lt.pages : [])];
  const reads = [
    { op: 'readMirror', workspaceId: null },
    ...workspaces.map((w) => ({ op: 'readMirror', workspaceId: w.id })),
    { op: 'nextOutboxBatch', limit: 100 },
    ...pages.flatMap((p) => [
      { op: 'loadDoc', pageId: p.id },
      { op: 'docLogLength', pageId: p.id },
      { op: 'listHistory', pageId: p.id },
    ]),
    { op: 'getHistory', id: historyId },
    ...assets.map((a) => ({ op: 'getAssetBytes', id: a.id })),
    { op: 'search', workspaceId: ws.id, query: 'quarter', limit: 10 },
    { op: 'search', workspaceId: ws.id, query: 'تقرير', limit: 10 },
    { op: 'getPref', key: 'toggles' },
    { op: 'getPref', key: 'theme' },
    { op: 'getPref', key: 'missing' },
    ...(synced
      ? [
          { op: 'outboxIndex' },
          ...workspaces.flatMap((w) => [
            { op: 'nextOutboxBatch', limit: 100, workspaceId: w.id },
            { op: 'syncCursor', workspaceId: w.id },
            { op: 'docCursors', workspaceId: w.id },
          ]),
          ...pages.map((p) => ({ op: 'docCursor', pageId: p.id })),
          { op: 'unsentDocUpdates', limit: 100 },
          { op: 'pendingAssets', limit: 100 },
        ]
      : []),
  ];
  return {
    writes,
    reads,
    about: {
      version,
      tag: RELEASES.find((r) => r.version === version).tag,
      workspaces: workspaces.map((w) => w.id),
      pages: pages.map((p) => p.id),
      // The page whose log has a snapshot and later updates, and the corrupt update kept aside.
      logPage: t.a.id,
      corrupt: { pageId: t.b.id, localSeq: 2, data: [0xde, 0xad] },
      assets: assets.map((a) => a.id),
      history: historyId,
    },
  };
}

async function make({ version }) {
  const dir = join(work, `stores/v${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { writes, reads, about } = scenario(version);
  const store = open(version, dir);
  const schema = await store.send({ op: 'schemaVersion' });
  if (schema.header.ok !== version) throw new Error(`v${version} reports ${schema.header.ok}`);
  for (const [header, blobs = []] of writes) await store.send(header, blobs.map(Buffer.from));
  const answers = [];
  for (const request of reads) {
    const { header, blobs } = await store.send(request);
    answers.push({ request, answer: header.ok, blobs });
  }
  await store.close();
  // A closed store has checkpointed its WAL into the file and removed it.
  const left = readdirSync(dir).filter((f) => f !== 'workspace.db' && f !== 'assets');
  if (left.length) throw new Error(`v${version} left ${left.join(', ')}`);

  const out = join(here, `v${version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  copyFileSync(join(dir, 'workspace.db'), join(out, 'workspace.db'));
  for (const file of readdirSync(join(dir, 'assets')))
    copyFileSync(join(dir, 'assets', file), join(out, 'assets', file));
  const path = join(out, 'expected.json');
  const text = JSON.stringify({ ...about, reads: answers });
  const options = (await prettier.resolveConfig(path)) ?? {};
  writeFileSync(path, await prettier.format(text, { ...options, filepath: path }));
  console.log(`v${version}: ${answers.length} reads kept in ${out}`);
}

if (!existsSync(join(root, '.git'))) throw new Error('Run this in the repository');
build();
for (const release of RELEASES) await make(release);
