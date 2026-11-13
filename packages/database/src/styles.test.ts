// The package's stylesheets load into the app beside the shell's and the editor's, so a class it
// shares with them takes their rules too. Found by the Phase 4 e2e specs: the shell's `.cgw-menu`
// is a fixed-position context menu, so every menu inside a database flyout (add a property, a
// property's menu, add a view) left its flyout and was cut off at the window's edge; the editor's
// `.cgw-handle` (the block handle, positioned absolutely) took the option and sort drag handles,
// its `.cgw-table` the table view inside a page, and the shell's `.cgw-list` the list view.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packages = join(import.meta.dirname, '..', '..');

/** Every file under `dir` whose name passes `keep`. */
function files(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(path).isDirectory()) found.push(...files(path, keep));
    else if (keep(name)) found.push(path);
  }
  return found;
}

const classesStyled = (dir: string) =>
  new Set(
    files(dir, (n) => n.endsWith('.css')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\.(cgw-[\w-]+)/g)].map((m) => m[1]),
    ),
  );
const classesUsed = (dir: string) =>
  new Set(
    files(dir, (n) => /\.tsx?$/.test(n) && !n.includes('.test.')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\b(cgw-[\w-]+)/g)].map((m) => m[1]),
    ),
  );

/** Shared on purpose, with why. */
const SHARED: Record<string, string> = {
  'cgw-icon-button': 'the shell only keeps its icon buttons from shrinking (`flex: none`)',
};

describe('the stylesheets', () => {
  it('style no class the shell or the editor styles or uses', () => {
    const ours = classesStyled(join(packages, 'database', 'src'));
    const theirs = new Map<string, string>();
    for (const pkg of ['shell', 'editor']) {
      for (const name of classesStyled(join(packages, pkg, 'src'))) theirs.set(name, pkg);
      for (const name of classesUsed(join(packages, pkg, 'src'))) theirs.set(name, pkg);
    }
    // The shell mounts the views into `.cgw-db` and draws around them: names it shares by design.
    const shared = [...ours]
      .filter((name) => theirs.has(name) && !SHARED[name] && name !== 'cgw-db')
      .map((name) => `${name} (${theirs.get(name)})`);
    expect(shared).toEqual([]);
  });
});
