// "No AI path reaches Commit" (IMPLEMENTATION_PLAN.md, Phase 7; INTEGRATIONS.md, AI): every module
// AI code runs, followed through every value import it makes (into the shell, the editor, the
// workspace layer and any other package of this repository), never loads `@cgw/erp`'s client, its
// sessions or its views, nor the shell's ERP services. Only `@cgw/erp/ai`, which holds types alone.
// Type-only imports are erased before anything runs, so they are not followed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const packages = join(root, 'packages');

/** The value imports of a module's source (static, re-exports, dynamic, side-effect). */
export function valueImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const statement =
    /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(statement)) {
    const [, kind, typeOnly, clause, spec] = match;
    if (typeOnly) continue;
    if (kind === 'export' && !/^\s*(\*|\{)/.test(clause)) continue;
    // `import { type A, type B } from …` is erased whole.
    const named = /^\s*\{([\s\S]*)\}\s*$/.exec(clause);
    if (named) {
      const names = named[1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(spec);
  }
  for (const match of code.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) out.push(match[1]);
  for (const match of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(match[1]);
  return out;
}

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function file(path: string): string | null {
  for (const suffix of CANDIDATES) {
    const candidate = path + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate))
      return candidate;
  }
  return null;
}

/** A `@cgw/*` specifier as the package's source file, by its `exports`. */
function workspacePackage(spec: string): string | null {
  const [, name, sub] = /^@cgw\/([^/]+)(\/.*)?$/.exec(spec) ?? [];
  if (!name) return null;
  const dir = join(packages, name);
  if (!existsSync(join(dir, 'package.json'))) return null;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    main?: string;
    exports?: Record<string, string>;
  };
  const key = sub ? `.${sub}` : '.';
  const target = manifest.exports?.[key] ?? (key === '.' ? manifest.main : undefined);
  return target ? file(join(dir, target)) : null;
}

/** Every module reached from `entries` by value imports, and the bare specifiers they name. */
function reach(entries: string[]) {
  const seen = new Set<string>();
  const external = new Set<string>();
  const edges: { from: string; spec: string }[] = [];
  const queue = [...entries];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const spec of valueImports(readFileSync(current, 'utf8'))) {
      edges.push({ from: current, spec });
      const next = spec.startsWith('.')
        ? file(resolve(dirname(current), spec))
        : spec.startsWith('@cgw/')
          ? workspacePackage(spec)
          : null;
      if (next) queue.push(next);
      else if (!spec.startsWith('.')) external.add(spec);
    }
  }
  return { seen, external, edges };
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('AI has no path to Commit', () => {
  it('reads value imports and leaves type-only ones out', () => {
    const imports = valueImports(
      [
        "import type { A } from './types';",
        "import { type B, type C } from './both';",
        "import { type D, e } from './mixed';",
        "import f from './default';",
        "export { g } from './re';",
        "export type { H } from './typeExport';",
        "import './side.css';",
        "const lazy = () => import('./lazy');",
        '// import { no } from "./comment";',
      ].join('\n'),
    );
    expect(imports.sort()).toEqual(['./default', './lazy', './mixed', './re', './side.css']);
  });

  it('reaches neither the ERP client, its sessions or views, nor the shell’s ERP services', () => {
    const entries = sources(here);
    expect(entries.length).toBeGreaterThan(5);
    const { seen, external } = reach(entries);
    const erp = join(packages, 'erp', 'src');
    const shellErp = join(packages, 'shell', 'src', 'erp');
    const reached = [...seen].map((path) => relative(root, path).replace(/\\/g, '/'));
    // A positive control: the walk does follow the shell and other packages.
    expect(reached).toContain('packages/shell/src/ai/AiPanel.tsx');
    expect(reached.some((path) => path.startsWith('packages/editor/src/'))).toBe(true);
    expect(reached.some((path) => path.startsWith('packages/doc/src/'))).toBe(true);
    const intoErp = [...seen].filter(
      (path) => path.startsWith(erp) && relative(erp, path).replace(/\\/g, '/') !== 'ai.ts',
    );
    expect(intoErp.map((path) => relative(root, path))).toEqual([]);
    expect([...seen].filter((path) => path.startsWith(shellErp))).toEqual([]);
    expect([...external].filter((spec) => spec.startsWith('@cgw/erp'))).toEqual([]);
  });

  it('would see a path to the client if one existed', () => {
    // The shell's ERP host mounts the ERP view, whose sessions hold `commit`.
    const { seen } = reach([join(packages, 'shell', 'src', 'erp', 'host.ts')]);
    expect([...seen].some((path) => path.endsWith(join('erp', 'src', 'client.ts')))).toBe(true);
  });
});
